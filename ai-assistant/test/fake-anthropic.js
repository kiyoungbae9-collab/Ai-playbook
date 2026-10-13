// 테스트용 가짜 Claude API. 실제 SDK가 받는 것과 같은 SSE 스트림을 정해진 각본대로 보냅니다.
// 각본: (1) 자료 검색 → (2) 투자비 계산 → (3) 출처를 단 최종 답변.
import http from "node:http";

export function startFakeAnthropic({ port = 0, delayMs = 2 } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ url: req.url, headers: req.headers, body });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    await streamMessage(res, body, script(body), delayMs);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function script(body) {
  const msgs = body.messages;
  const last = msgs.at(-1);
  const toolResults = Array.isArray(last.content) ? last.content.filter((b) => b.type === "tool_result") : [];
  const results = allSearchResults(msgs);

  if (toolResults.length === 0) {
    return {
      stop: "tool_use",
      blocks: [
        { type: "thinking", thinking: "", signature: "sig-1" },
        { type: "text", text: "프로젝트 자료를 검색해 보겠습니다." },
        { type: "tool_use", id: "toolu_search1", name: "search_documents", input: { query: "냉동 컨테이너 투자비 부대비용 매출 운영비" } },
      ],
    };
  }

  const previousTool = msgs.at(-2).content.find((b) => b.type === "tool_use" && b.id === toolResults[0].tool_use_id)?.name;
  const find = (word) => results.findIndex((r) => r.title.includes(word));
  const src = (word) => results[find(word)]?.source ?? "가정: 자료 없음";

  if (previousTool === "search_documents") {
    return {
      stop: "tool_use",
      blocks: [
        {
          type: "tool_use",
          id: "toolu_calc1",
          name: "calculate_investment",
          input: {
            title: "KenCity 15대 냉동 컨테이너 사업",
            currency: "USD",
            years: 5,
            investment_items: [
              { label: "냉동 컨테이너 15대 (구매 및 설치)", quantity: 15, unit_cost: 70000, source: src("제안서") },
              { label: "부대비용 (운송, 설치 등)", amount: 200000, source: src("현장실사") },
            ],
            annual_revenue: { amount: 720000, source: src("시장조사") },
            annual_opex: { amount: 430000, source: src("운영비") },
          },
        },
      ],
    };
  }

  const cite = (word, text) => {
    const i = find(word);
    if (i < 0) return { type: "text", text };
    const r = results[i];
    return { type: "text", text, citations: [{ type: "search_result_location", source: r.source, title: r.title, cited_text: r.content[0].text, search_result_index: i, start_block_index: 0, end_block_index: 1 }] };
  };
  return {
    stop: "end_turn",
    blocks: [
      { type: "text", text: "KenCity 15대 냉동 컨테이너 사업의 투자비와 회수기간을 분석했습니다.\n\n" },
      cite("제안서", "컨테이너 15대 구매·설치비는 1,050,000 USD이고"),
      { type: "text", text: ", " },
      cite("현장실사", "운송·설치 등 부대비용은 200,000 USD입니다"),
      { type: "text", text: ".\n\n### 해석\n- 연간 순현금흐름은 290,000 USD로 투자금은 약 **4.3년**에 회수됩니다.\n- " },
      cite("시장조사", "연간 예상 매출 720,000 USD는 가동률 85%를 전제로 합니다"),
      { type: "text", text: ".\n\n### 추가 확인 사항\n- 환율 변동과 전기료 인상 가능성을 점검하세요." },
    ],
  };
}

function allSearchResults(messages) {
  const out = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_result" && Array.isArray(b.content)) out.push(...b.content.filter((c) => c.type === "search_result"));
    }
  }
  return out;
}

async function streamMessage(res, body, { stop, blocks }, delayMs) {
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  send("message_start", {
    message: { id: `msg_${Math.random().toString(16).slice(2)}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  });
  for (const [index, block] of blocks.entries()) {
    if (block.type === "thinking") {
      send("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
      send("content_block_delta", { index, delta: { type: "signature_delta", signature: block.signature } });
    } else if (block.type === "text") {
      send("content_block_start", { index, content_block: block.citations ? { type: "text", text: "", citations: [] } : { type: "text", text: "" } });
      for (const citation of block.citations ?? []) send("content_block_delta", { index, delta: { type: "citations_delta", citation } });
      for (const piece of block.text.match(/[\s\S]{1,12}/g) ?? []) {
        send("content_block_delta", { index, delta: { type: "text_delta", text: piece } });
        await new Promise((r) => setTimeout(r, delayMs));
      }
    } else if (block.type === "tool_use") {
      send("content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      const json = JSON.stringify(block.input);
      const mid = Math.floor(json.length / 2);
      send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: json.slice(0, mid) } });
      send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: json.slice(mid) } });
    }
    send("content_block_stop", { index });
  }
  send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 80 } });
  send("message_stop", {});
}

// 단독 실행: node test/fake-anthropic.js [포트=4100] [글자 묶음당 지연 ms=2]
if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = await startFakeAnthropic({ port: Number(process.argv[2]) || 4100, delayMs: Number(process.argv[3]) || 2 });
  console.log(`가짜 Claude API: ${fake.url}`);
}
