// Claude가 호출하는 도구: 자료 검색, 자료 읽기, 투자비 계산.
// 검색 결과는 search_result 블록으로 돌려줘서 Claude가 답변에 출처(citation)를 달 수 있게 합니다.
import { z } from "zod";
import { computeInvestment, MAX_YEARS } from "../public/shared/finance.js";

const READ_LIMIT_CHARS = 40_000;
const BLOCKS_PER_RESULT = 6;

const sourceField = z
  .string()
  .min(1)
  .max(300)
  .describe('근거 출처. 검색·읽기 결과의 source 값("doc:d_…:번호")을 그대로 쓰고, 자료에 없는 값이면 "가정: 이유"처럼 적습니다.');

const amountField = z.number().min(0).max(1e13);

export const schemas = {
  search_documents: z.object({
    query: z.string().min(1).max(300).describe("찾을 내용. 핵심 단어 위주로 짧게(예: '냉동 컨테이너 단가', '연간 운영비')."),
    document_ids: z.array(z.string()).max(20).optional().describe("특정 자료 안에서만 찾을 때 자료 ID 목록"),
    max_results: z.number().int().min(1).max(10).optional().describe("가져올 결과 수(기본 6)"),
  }),
  read_document: z.object({
    document_id: z.string().describe("자료 ID(d_로 시작)"),
    from_section: z.number().int().min(1).optional().describe("읽기 시작할 구간 번호(1부터). PDF는 쪽, 엑셀은 시트, 파워포인트는 슬라이드 번호와 같습니다."),
    to_section: z.number().int().min(1).optional().describe("마지막 구간 번호(포함)"),
  }),
  calculate_investment: z.object({
    title: z.string().min(1).max(120).describe("분석 이름(예: 'KenCity 15대 냉동 컨테이너 사업')"),
    currency: z.string().min(1).max(10).optional().describe("통화 코드(기본 USD). 모든 금액은 같은 통화로 맞춥니다."),
    years: z.number().int().min(1).max(MAX_YEARS).describe("분석 기간(년)"),
    investment_items: z
      .array(
        z.object({
          label: z.string().min(1).max(120).describe("투자 항목 이름"),
          amount: amountField.optional().describe("금액. 수량×단가로 계산할 때는 생략"),
          quantity: z.number().min(0).max(1e9).optional().describe("수량"),
          unit_cost: amountField.optional().describe("단가"),
          source: sourceField,
        }),
      )
      .min(1)
      .max(30)
      .describe("0년차 초기 투자(구매·설치·부대비용 등)"),
    annual_revenue: z.object({ amount: amountField, source: sourceField }).describe("연간 매출"),
    annual_opex: z.object({ amount: amountField, source: sourceField }).describe("연간 운영비"),
    revenue_by_year: z.array(amountField).max(MAX_YEARS).optional().describe("연차별 매출이 다를 때 1년차부터 순서대로(없는 연차는 annual_revenue 사용)"),
    opex_by_year: z.array(amountField).max(MAX_YEARS).optional().describe("연차별 운영비가 다를 때 1년차부터 순서대로"),
    discount_rate: z.number().min(0).max(1).optional().describe("NPV 할인율(예: 0.08). 자료나 사용자 요청에 있을 때만"),
  }),
};

const descriptions = {
  search_documents:
    "업로드된 프로젝트 자료에서 관련 내용을 찾습니다. 사실·수치를 답하기 전에 항상 먼저 검색하세요. 결과마다 source(doc:자료ID:구간번호)와 제목(파일명 · 위치)이 붙어 있습니다.",
  read_document:
    "자료 하나의 특정 구간(쪽·시트·슬라이드)을 처음부터 끝까지 읽습니다. 검색 결과만으로 표나 문맥이 부족할 때, 또는 자료 전체 요약을 요청받았을 때 씁니다.",
  calculate_investment:
    "총 투자비, 연도별 현금흐름, 투자금 회수기간, ROI, IRR(할인율을 주면 NPV)을 정확히 계산합니다. 투자·수익성 수치는 직접 계산하지 말고 반드시 이 도구를 쓰세요. 결과는 화면에 요약 카드, 현금흐름 차트, 계산근거 표로 자동 표시됩니다.",
};

export const toolDefinitions = Object.entries(schemas).map(([name, schema]) => {
  const { $schema, ...input_schema } = z.toJSONSchema(schema, { io: "input" });
  return { name, description: descriptions[name], input_schema, eager_input_streaming: true };
});

/**
 * 도구를 실행합니다. Claude에게 돌려줄 content와 화면에 보낼 event를 반환합니다.
 * @param {import("./store.js").Store} store
 */
export function runTool(store, name, rawInput) {
  const schema = schemas[name];
  if (!schema) return { isError: true, content: `알 수 없는 도구: ${name}` };
  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      isError: true,
      content: `입력값이 올바르지 않습니다: ${z.prettifyError(parsed.error)}\n받은 입력: ${JSON.stringify(rawInput)}`,
    };
  }
  const input = parsed.data;
  switch (name) {
    case "search_documents":
      return searchDocuments(store, input);
    case "read_document":
      return readDocument(store, input);
    case "calculate_investment":
      return calculateInvestment(store, input);
  }
}

function searchDocuments(store, { query, document_ids, max_results }) {
  const hits = store.index.search(query, { docIds: document_ids, limit: max_results ?? 6 });
  const event = {
    t: "search",
    query,
    results: hits.map((h) => store.resolveSource(store.sourceKey(h.docId, h.segIndex))),
  };
  if (hits.length === 0) {
    return { content: `'${query}'에 맞는 내용을 찾지 못했습니다. 다른 표현이나 더 짧은 검색어로 다시 찾아보세요.`, event };
  }
  const content = hits.map((h) => searchResultBlock(store, h.docId, h.segIndex, h.text));
  return { content, event };
}

function readDocument(store, { document_id, from_section, to_section }) {
  const doc = store.getDocument(document_id);
  if (!doc) return { isError: true, content: `자료를 찾을 수 없습니다: ${document_id}` };
  const segments = store.getSegments(doc.id);
  if (segments.length === 0) return { content: `'${doc.name}'에는 읽을 수 있는 텍스트가 없습니다.` };

  const from = Math.min(from_section ?? 1, segments.length);
  const to = Math.min(Math.max(to_section ?? segments.length, from), segments.length);
  const content = [];
  let used = 0;
  let next = null;
  for (let i = from - 1; i < to; i++) {
    const text = segments[i].text;
    if (used > 0 && used + text.length > READ_LIMIT_CHARS) {
      next = i + 1;
      break;
    }
    // 한 구간이 한도를 넘으면 잘린 사실을 알려 줍니다.
    const clipped = text.length > READ_LIMIT_CHARS ? text.slice(0, READ_LIMIT_CHARS) : text;
    content.push(searchResultBlock(store, doc.id, i, clipped));
    used += clipped.length;
    if (clipped.length < text.length) {
      content.push({ type: "text", text: `[구간 ${i + 1}은 너무 길어 앞부분 ${READ_LIMIT_CHARS.toLocaleString()}자만 보냈습니다. 나머지는 search_documents로 찾아보세요.]` });
    }
  }
  if (next) {
    content.push({ type: "text", text: `[분량이 많아 구간 ${from}–${next - 1}까지만 보냈습니다. 이어서 읽으려면 from_section=${next}로 다시 호출하세요. 전체 ${segments.length}개 구간.]` });
  }
  const event = { t: "read", document: { docId: doc.id, name: doc.name }, from, to: next ? next - 1 : to };
  return { content, event };
}

function calculateInvestment(store, input) {
  for (const item of input.investment_items) {
    const hasQty = item.quantity !== undefined && item.unit_cost !== undefined;
    if (!hasQty && item.amount === undefined) {
      return { isError: true, content: `투자 항목 '${item.label}'에 amount 또는 quantity와 unit_cost가 필요합니다.` };
    }
  }
  const result = computeInvestment(input);
  const sources = {};
  const collect = (src) => {
    if (src && !(src in sources)) sources[src] = store.resolveSource(src) ?? { source: src, assumption: true };
  };
  input.investment_items.forEach((it) => collect(it.source));
  collect(input.annual_revenue.source);
  collect(input.annual_opex.source);

  const round = (v) => (v === null ? null : Math.round(v * 100) / 100);
  const summary = {
    currency: result.currency,
    years: result.years,
    total_investment: round(result.totalInvestment),
    investment_items: result.items.map((it) => ({ label: it.label, amount: round(it.amount) })),
    average_annual_revenue: round(result.avgRevenue),
    average_annual_opex: round(result.avgOpex),
    average_annual_net_cash_flow: round(result.avgNet),
    payback_years: result.paybackYears === null ? "분석 기간 내 회수되지 않음" : round(result.paybackYears),
    roi_over_period: round(result.roi),
    irr: round(result.irr),
    npv: round(result.npv),
    discount_rate: result.discountRate,
    yearly: result.rows.map((r) => ({ year: r.year, revenue: round(r.revenue), opex: round(r.opex), investment: round(r.investment), net: round(r.net), cumulative: round(r.cumulative) })),
    basis: "0년차 초기 투자, 1년차부터 운영 현금흐름 발생, 세전 기준, 회수기간은 연중 균등 발생으로 보간",
    display: "요약 카드·현금흐름 차트·계산근거 표가 사용자 화면에 이미 표시되었습니다.",
  };
  return { content: JSON.stringify(summary), event: { t: "analysis", input, sources } };
}

function searchResultBlock(store, docId, segIndex, text) {
  const info = store.resolveSource(store.sourceKey(docId, segIndex));
  return {
    type: "search_result",
    source: info.source,
    title: `${info.name} · ${info.label}`,
    content: splitIntoBlocks(text).map((t) => ({ type: "text", text: t })),
    citations: { enabled: true },
  };
}

// 인용은 블록 단위로 잡히므로, 조각을 몇 개의 블록으로 나눠 더 정확한 부분을 가리킬 수 있게 합니다.
export function splitIntoBlocks(text) {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length <= BLOCKS_PER_RESULT) return lines.length ? lines : [text];
  const size = Math.ceil(lines.length / BLOCKS_PER_RESULT);
  const blocks = [];
  for (let i = 0; i < lines.length; i += size) blocks.push(lines.slice(i, i + size).join("\n"));
  return blocks;
}
