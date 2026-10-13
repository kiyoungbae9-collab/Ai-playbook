// 투자 분석 결과 화면: 요약 카드, 연도별 현금흐름 차트, 계산근거 표, Excel(CSV) 저장, 조건 수정.
import { computeInvestment, itemAmount } from "./shared/finance.js";
import { h, icon, fileIcon, fmtNumber, fmtCompact, fmtPercent, fmtYears, fmtDate, sourceHref } from "./format.js";

const SERIES = [
  { key: "revenue", label: "매출", color: "var(--s-rev)" },
  { key: "opex", label: "운영비", color: "var(--s-opex)" },
  { key: "net", label: "순현금흐름", color: "var(--s-net)" },
];
const CUMULATIVE = { label: "누적현금흐름", color: "var(--s-cum)" };

export class AnalysisWidget {
  /** @param {{ input: any, sources: Record<string, any> }} event */
  constructor(event) {
    this.original = structuredClone(event.input);
    this.input = structuredClone(event.input);
    this.sources = event.sources ?? {};
    this.edited = false;
    this.el = h("section.analysis");
    this.render();
  }

  get result() {
    return computeInvestment(this.input);
  }

  update(input) {
    this.input = input;
    this.edited = true;
    this.render();
  }

  render() {
    this.chartObserver?.disconnect();
    const r = this.result;
    const cur = r.currency;
    this.el.replaceChildren(
      h("div.analysis-title", {}, icon("i-bot"), h("b", {}, this.input.title), this.edited ? h("span.badge", {}, "조건 수정됨 · AI 설명은 원래 조건 기준") : null),

      sectionHeading(1, "주요 결과 요약"),
      h(
        "div.kpis",
        {},
        kpi("invest", "총 투자비", fmtNumber(r.totalInvestment), cur),
        kpi("revenue", r.variesByYear ? "연평균 예상 매출" : "연간 예상 매출", fmtNumber(r.avgRevenue), cur),
        kpi("opex", r.variesByYear ? "연평균 운영비" : "연간 운영비", fmtNumber(r.avgOpex), cur),
        r.paybackYears === null ? kpi("payback", "투자금 회수기간", "회수 불가", `${r.years}년 내`) : kpi("payback", "투자금 회수기간", fmtYears(r.paybackYears), "년"),
      ),
      h(
        "div.metrics-line",
        {},
        metric("분석 기간", `${r.years}년`),
        metric("연평균 순현금흐름", `${fmtNumber(r.avgNet)} ${cur}`),
        r.roi !== null ? metric(`ROI(${r.years}년 누적)`, fmtPercent(r.roi)) : null,
        r.irr !== null ? metric("IRR", fmtPercent(r.irr)) : null,
        r.npv !== null ? metric(`NPV(할인율 ${fmtPercent(r.discountRate)})`, `${fmtNumber(r.npv)} ${cur}`) : null,
      ),

      this.renderChartSection(r),
      sectionHeading(3, "주요 가정 및 계산근거"),
      this.renderAssumptions(r),
    );
  }

  renderChartSection(r) {
    const box = h("div.chart-box");
    const table = yearlyTable(r);
    table.hidden = true;
    const toggle = h("button.link", { type: "button" }, "표로 보기");
    toggle.addEventListener("click", () => {
      table.hidden = !table.hidden;
      box.hidden = !table.hidden;
      toggle.textContent = table.hidden ? "표로 보기" : "차트로 보기";
    });
    this.chartObserver = drawChart(box, r);
    return h("div", {}, sectionHeading(2, "연도별 현금흐름 분석", toggle), box, table);
  }

  renderAssumptions(r) {
    const cur = r.currency;
    const rows = r.items.map((it) =>
      h(
        "tr",
        {},
        h("td", {}, it.label, it.quantity !== undefined && it.unit_cost !== undefined ? h("span.src-meta", {}, `${fmtNumber(it.quantity)} × ${fmtNumber(it.unit_cost)}`) : null),
        h("td.num", {}, fmtNumber(it.amount)),
        h("td", {}, this.sourceCell(it.source)),
      ),
    );
    const byYear = (label, list) => (Array.isArray(list) && list.length ? `${label} (연차별 값 적용)` : label);
    rows.push(
      h("tr", {}, h("td", {}, byYear("연간 매출", this.input.revenue_by_year)), h("td.num", {}, fmtNumber(this.input.annual_revenue.amount)), h("td", {}, this.sourceCell(this.input.annual_revenue.source))),
      h("tr", {}, h("td", {}, byYear("연간 운영비", this.input.opex_by_year)), h("td.num", {}, fmtNumber(this.input.annual_opex.amount)), h("td", {}, this.sourceCell(this.input.annual_opex.source))),
    );
    return h(
      "div.table-wrap",
      {},
      h("table.data-table", {}, h("thead", {}, h("tr", {}, h("th", {}, "항목"), h("th.num", {}, `금액 (${cur})`), h("th", {}, "근거 자료"))), h("tbody", {}, rows)),
    );
  }

  sourceCell(source) {
    const src = this.sources[source];
    if (src?.docId) {
      return h(
        "a.src-link",
        { href: sourceHref(src), target: "_blank", rel: "noopener" },
        fileIcon(src.kind, true),
        h("span", {}, `${src.name}${src.label ? ` (${src.label})` : ""}`, h("span.src-meta", {}, fmtDate(src.date))),
      );
    }
    if (src?.missing) return h("span.src-meta", {}, "삭제된 자료");
    return h("span.assumption", {}, source || "근거 없음");
  }

  toCsv() {
    const r = this.result;
    const lines = [
      ["분석", this.input.title],
      ["통화", r.currency],
      ["분석 기간(년)", r.years],
      ["기준", "0년차 초기 투자, 1년차부터 운영 현금흐름, 세전"],
      [],
      ["항목", "수량", "단가", "금액", "근거"],
      ...r.items.map((it) => [it.label, it.quantity ?? "", it.unit_cost ?? "", it.amount, this.sourceText(it.source)]),
      ["연간 매출", "", "", this.input.annual_revenue.amount, this.sourceText(this.input.annual_revenue.source)],
      ["연간 운영비", "", "", this.input.annual_opex.amount, this.sourceText(this.input.annual_opex.source)],
      [],
      ["연차", "매출", "운영비", "투자", "순현금흐름", "누적현금흐름"],
      ...r.rows.map((row) => [row.year, row.revenue, row.opex, row.investment, row.net, row.cumulative]),
      [],
      ["지표", "값"],
      ["총 투자비", r.totalInvestment],
      ["투자금 회수기간(년)", r.paybackYears === null ? "기간 내 회수 불가" : round2(r.paybackYears)],
      [`ROI(${r.years}년 누적)`, r.roi === null ? "" : round2(r.roi * 100) + "%"],
      ["IRR", r.irr === null ? "" : round2(r.irr * 100) + "%"],
      ["NPV", r.npv === null ? "" : round2(r.npv)],
    ];
    return "﻿" + lines.map((cols) => cols.map(csvCell).join(",")).join("\r\n");
  }

  sourceText(source) {
    const src = this.sources[source];
    return src?.docId ? `${src.name} ${src.label} (${fmtDate(src.date)})` : source;
  }

  downloadCsv() {
    const blob = new Blob([this.toCsv()], { type: "text/csv;charset=utf-8" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `${this.input.title.replace(/[\\/:*?"<>|]/g, "_")}_투자분석.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /** 조건 수정 대화상자. ask(text)는 "AI 해석 요청"을 눌렀을 때 보낼 질문을 받습니다. */
  openEditor(ask) {
    const dialog = document.getElementById("edit-dialog");
    const form = document.getElementById("edit-form");
    const body = document.getElementById("edit-body");
    const input = this.input;
    const field = (name, value, attrs = {}) => h("input", { name, type: "number", step: "any", min: "0", value: value ?? "", required: true, ...attrs });

    const groups = [
      h("fieldset", {}, h("legend", {}, "기간·할인율"), row("분석 기간(년)", field("years", input.years, { step: "1", min: "1", max: "30" })), row("할인율(%) · 비워 두면 NPV 생략", field("discount", input.discount_rate === undefined ? "" : input.discount_rate * 100, { required: false }))),
      h(
        "fieldset",
        {},
        h("legend", {}, `초기 투자 (${input.currency || "USD"})`),
        input.investment_items.map((it, i) =>
          it.quantity !== undefined && it.unit_cost !== undefined
            ? h("label.edit-row.qty", {}, h("span", {}, `${it.label} (수량 · 단가)`), field(`qty${i}`, it.quantity), field(`unit${i}`, it.unit_cost))
            : row(it.label, field(`amt${i}`, itemAmount(it))),
        ),
      ),
      h(
        "fieldset",
        {},
        h("legend", {}, "운영"),
        row("연간 매출", field("revenue", input.annual_revenue.amount)),
        row("연간 운영비", field("opex", input.annual_opex.amount)),
        (input.revenue_by_year ?? []).map((v, i) => row(`매출 ${i + 1}년차`, field(`rev_y${i}`, v))),
        (input.opex_by_year ?? []).map((v, i) => row(`운영비 ${i + 1}년차`, field(`opex_y${i}`, v))),
      ),
    ];
    body.replaceChildren(...groups);

    form.onsubmit = (e) => {
      e.preventDefault();
      const data = new FormData(form);
      const num = (k) => Number(data.get(k));
      const next = structuredClone(input);
      next.years = Math.max(1, Math.min(30, Math.round(num("years"))));
      const discount = String(data.get("discount") ?? "").trim();
      if (discount === "") delete next.discount_rate;
      else next.discount_rate = Number(discount) / 100;
      next.investment_items.forEach((it, i) => {
        if (data.has(`qty${i}`)) {
          it.quantity = num(`qty${i}`);
          it.unit_cost = num(`unit${i}`);
        } else {
          it.amount = num(`amt${i}`);
          delete it.quantity;
          delete it.unit_cost;
        }
      });
      next.annual_revenue.amount = num("revenue");
      next.annual_opex.amount = num("opex");
      if (next.revenue_by_year) next.revenue_by_year = next.revenue_by_year.map((_, i) => num(`rev_y${i}`));
      if (next.opex_by_year) next.opex_by_year = next.opex_by_year.map((_, i) => num(`opex_y${i}`));
      this.update(next);
      dialog.close();
      if (e.submitter?.value === "ask") ask(this.describeChange());
    };
    dialog.showModal();
  }

  describeChange() {
    const r = this.result;
    const cur = r.currency;
    const items = r.items.map((it) => `${it.label} ${fmtNumber(it.amount)} ${cur}`).join(", ");
    const payback = r.paybackYears === null ? `${r.years}년 안에 회수되지 않음` : `${fmtYears(r.paybackYears)}년`;
    return `'${this.input.title}'의 계산 조건을 다음과 같이 바꿔 다시 계산했어. 분석 기간 ${r.years}년, 초기 투자 ${items}, 연간 매출 ${fmtNumber(this.input.annual_revenue.amount)} ${cur}, 연간 운영비 ${fmtNumber(this.input.annual_opex.amount)} ${cur}. 결과는 총 투자비 ${fmtNumber(r.totalInvestment)} ${cur}, 회수기간 ${payback}이야. calculate_investment로 이 조건을 다시 확인하고, 원래 분석과 비교해서 의미와 리스크를 설명해 줘.`;
  }
}

function row(label, inputEl) {
  return h("label.edit-row", {}, h("span", {}, label), inputEl);
}

function sectionHeading(n, title, extra) {
  return h("div.section-h", {}, h("span.num", {}, n), h("span", {}, title), h("span.spacer"), extra);
}

function kpi(cls, label, value, unit) {
  return h(`div.kpi.${cls}`, {}, h("div.label", {}, label), h("div.value", {}, value), h("div.unit", {}, unit));
}

function metric(label, value) {
  return h("span", {}, `${label} `, h("b", {}, value));
}

function yearlyTable(r) {
  return h(
    "div.table-wrap",
    {},
    h(
      "table.data-table",
      {},
      h("thead", {}, h("tr", {}, ["연차", "매출", "운영비", "투자", "순현금흐름", "누적현금흐름"].map((t, i) => h(i ? "th.num" : "th", {}, t)))),
      h(
        "tbody",
        {},
        r.rows.map((row) =>
          h("tr", {}, h("td", {}, yearLabel(row.year)), [row.revenue, row.opex, row.investment, row.net, row.cumulative].map((v) => h("td.num", {}, fmtNumber(v)))),
        ),
      ),
    ),
  );
}

function yearLabel(year) {
  return year === 0 ? "투자(0년차)" : `${year}년차`;
}

// ---------- 차트(직접 그린 SVG) ----------

const SVG_NS = "http://www.w3.org/2000/svg";

function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
}

function drawChart(box, r) {
  const legend = h(
    "div.legend",
    {},
    SERIES.map((ser) => h("span", {}, h("i", { style: `--c:${ser.color}` }), ser.label)),
    h("span", {}, h("i.line", { style: `--c:${CUMULATIVE.color}` }), CUMULATIVE.label),
  );
  const holder = h("div");
  const tip = h("div.chart-tip", { hidden: true });
  box.replaceChildren(legend, holder, tip);

  let lastWidth = 0;
  const paint = () => {
    const width = Math.max(300, Math.round(holder.clientWidth || 640));
    if (width === lastWidth) return;
    lastWidth = width;
    holder.replaceChildren(buildSvg(r, width, box, tip));
  };
  const observer = new ResizeObserver(paint);
  observer.observe(holder);
  requestAnimationFrame(paint);
  return observer;
}

function buildSvg(r, width, box, tip) {
  const height = width < 520 ? 230 : 270;
  const m = { top: 26, right: 12, bottom: 28, left: 52 };
  const plotW = width - m.left - m.right;
  const plotH = height - m.top - m.bottom;
  const rows = r.rows;

  const values = rows.flatMap((row) => [row.revenue, -row.opex, row.net, row.cumulative]);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values), 5);
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const y = (v) => m.top + ((yMax - v) / (yMax - yMin || 1)) * plotH;
  const band = plotW / rows.length;
  const cx = (i) => m.left + band * (i + 0.5);
  const gap = 2;
  const barW = Math.max(3, Math.min(24, (band * 0.72 - gap * 2) / 3));
  const groupW = barW * 3 + gap * 2;

  const svg = s("svg", { class: "chart", viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `연도별 현금흐름 차트. 누적현금흐름은 ${yearLabel(rows.at(-1).year)}에 ${fmtNumber(rows.at(-1).cumulative)} ${r.currency}` });

  for (const t of ticks) {
    svg.append(
      s("line", { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), stroke: t === 0 ? "var(--border-strong)" : "var(--grid)", "stroke-width": 1, "shape-rendering": "crispEdges" }),
      s("text", { x: m.left - 8, y: y(t) + 4, "text-anchor": "end", "font-size": 11, fill: "var(--text-muted)" }, fmtCompact(t)),
    );
  }

  const highlight = s("rect", { x: 0, y: m.top, width: band, height: plotH, fill: "rgba(255,255,255,.05)", visibility: "hidden" });
  svg.append(highlight);

  const labelEvery = Math.ceil(rows.length / Math.max(1, Math.floor(plotW / 44)));
  rows.forEach((row, i) => {
    const vals = { revenue: row.revenue, opex: -row.opex, net: row.net };
    SERIES.forEach((ser, k) => {
      const v = vals[ser.key];
      if (!v) return;
      const x = cx(i) - groupW / 2 + k * (barW + gap);
      svg.append(s("path", { d: barPath(x, y(0), y(v), barW), fill: ser.color }));
    });
    if (i % labelEvery === 0) {
      svg.append(s("text", { x: cx(i), y: height - 8, "text-anchor": "middle", "font-size": 11, fill: "var(--text-secondary)" }, row.year === 0 ? "투자" : `${row.year}년차`));
    }
  });

  // 회수 시점 표시
  if (r.paybackYears !== null && r.paybackYears > 0) {
    const px = cx(0) + r.paybackYears * band;
    svg.append(
      s("line", { x1: px, x2: px, y1: m.top - 4, y2: y(0), stroke: "rgba(232,237,247,.35)", "stroke-width": 1 }),
      s("text", { x: Math.min(Math.max(px, m.left + 40), width - m.right - 40), y: m.top - 10, "text-anchor": "middle", "font-size": 11, "font-weight": 700, fill: "var(--text-primary)" }, `회수 ${fmtYears(r.paybackYears)}년`),
    );
  }

  const points = rows.map((row, i) => `${cx(i)},${y(row.cumulative)}`).join(" ");
  svg.append(s("polyline", { points, fill: "none", stroke: CUMULATIVE.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  rows.forEach((row, i) => svg.append(s("circle", { cx: cx(i), cy: y(row.cumulative), r: 4, fill: CUMULATIVE.color, stroke: "var(--surface-1)", "stroke-width": 2 })));

  // 마우스를 올리면 해당 연차의 값을 보여 줍니다.
  rows.forEach((row, i) => {
    const hit = s("rect", { x: m.left + band * i, y: m.top, width: band, height: plotH, fill: "transparent" });
    const show = () => {
      highlight.setAttribute("x", m.left + band * i);
      highlight.setAttribute("visibility", "visible");
      const rowsForYear =
        row.year === 0
          ? [tipRow("투자", -row.investment, "var(--s-net)", r.currency)]
          : [tipRow("매출", row.revenue, "var(--s-rev)", r.currency), tipRow("운영비", -row.opex, "var(--s-opex)", r.currency), tipRow("순현금흐름", row.net, "var(--s-net)", r.currency)];
      tip.replaceChildren(h("div", {}, h("b", {}, yearLabel(row.year))), ...rowsForYear, tipRow("누적현금흐름", row.cumulative, "var(--s-cum)", r.currency));
      tip.hidden = false;
      const boxRect = box.getBoundingClientRect();
      const svgRect = svg.getBoundingClientRect();
      const scale = svgRect.width / width;
      const left = svgRect.left - boxRect.left + cx(i) * scale;
      const tipW = tip.offsetWidth;
      tip.style.left = `${Math.max(4, Math.min(left + 14, boxRect.width - tipW - 4))}px`;
      if (left + 14 + tipW > boxRect.width - 4) tip.style.left = `${Math.max(4, left - tipW - 14)}px`;
      tip.style.top = `${svgRect.top - boxRect.top + m.top * scale}px`;
    };
    const hide = () => {
      highlight.setAttribute("visibility", "hidden");
      tip.hidden = true;
    };
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("pointerdown", show);
    hit.addEventListener("pointerleave", hide);
    svg.append(hit);
  });
  return svg;
}

function tipRow(label, value, color, currency) {
  return h("div.row", {}, h("span", {}, h("i", { style: `--c:${color}` }), label), h("b", {}, `${fmtNumber(value)} ${currency}`));
}

/** 기준선에서 자라는 막대. 끝은 4px 둥글게, 기준선 쪽은 각지게. */
function barPath(x, y0, y1, w) {
  const hgt = Math.abs(y1 - y0);
  const rad = Math.min(4, w / 2, hgt);
  if (y1 < y0) {
    return `M${x},${y0}V${y1 + rad}Q${x},${y1} ${x + rad},${y1}H${x + w - rad}Q${x + w},${y1} ${x + w},${y1 + rad}V${y0}Z`;
  }
  return `M${x},${y0}V${y1 - rad}Q${x},${y1} ${x + rad},${y1}H${x + w - rad}Q${x + w},${y1} ${x + w},${y1 - rad}V${y0}Z`;
}

function niceTicks(min, max, count) {
  if (min === max) max = min + 1;
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((st) => st >= raw) ?? 10 * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : v);
  return ticks;
}

function csvCell(v) {
  const str = String(v ?? "");
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
