import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { runTurn, sanitizeForEcho, buildCatalog } from "../server/assistant.js";
import { Store } from "../server/store.js";

/** stream()이 호출될 때마다 각본의 다음 동작을 돌려주는 가짜 클라이언트 */
function fakeClient(steps) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params) {
          calls.push(structuredClone(params));
          const step = steps[calls.length - 1];
          return {
            async *[Symbol.asyncIterator]() {
              if (step.throwBeforeEvents) throw step.throwBeforeEvents;
              yield { type: "message_start", message: {} };
            },
            async finalMessage() {
              return step.message;
            },
          };
        },
      },
    },
  };
}

const store = new Store("/nonexistent-not-used");
const base = { store, model: "claude-opus-5-5", effort: "high", projectName: "테스트" };

test("요청 전에 나는 SDK 오류(예: API 키 없음)는 다시 시도하지 않는다", async () => {
  const client = fakeClient([{ throwBeforeEvents: new Anthropic.AnthropicError("Could not resolve authentication method") }]);
  const conv = { messages: [] };
  const events = [];
  await assert.rejects(runTurn({ ...base, client, conv, userText: "안녕", emit: (e) => events.push(e) }), Anthropic.AnthropicError);
  assert.equal(client.calls.length, 1);
  assert.ok(!events.some((e) => e.t === "discard"));
  assert.equal(conv.messages.length, 0, "실패한 턴은 대화 기록에서 되돌린다");
});

test("안전 정책 거절이면 부분 답변을 버리고 대화 기록을 되돌린다", async () => {
  const client = fakeClient([{ message: { stop_reason: "refusal", content: [{ type: "text", text: "부분" }], usage: {} } }]);
  const conv = { messages: [{ role: "user", content: "이전 질문" }, { role: "assistant", content: [{ type: "text", text: "이전 답" }] }] };
  const events = [];
  await runTurn({ ...base, client, conv, userText: "질문", emit: (e) => events.push(e) });
  assert.deepEqual(events.map((e) => e.t).slice(-2), ["discard", "error"]);
  assert.equal(conv.messages.length, 2);
});

test("도구 입력이 형식에 맞지 않으면 실행하지 않고 오류 결과를 돌려준다", async () => {
  const client = fakeClient([
    { message: { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "calculate_investment", input: { title: "x" } }], usage: {} } },
    { message: { stop_reason: "end_turn", content: [{ type: "text", text: "다시 확인하겠습니다." }], usage: {} } },
  ]);
  const conv = { messages: [] };
  await runTurn({ ...base, client, conv, userText: "계산해 줘", emit: () => {} });
  const result = conv.messages[2].content[0];
  assert.equal(result.type, "tool_result");
  assert.equal(result.is_error, true);
  assert.match(result.content, /입력값이 올바르지 않습니다/);
  assert.equal(client.calls.length, 2);
  // 첫 요청과 두 번째 요청의 앞부분(시스템·도구·첫 질문)이 같아야 캐시가 맞는다
  assert.deepEqual(client.calls[1].system, client.calls[0].system);
  assert.deepEqual(client.calls[1].messages[0], client.calls[0].messages[0]);
});

test("모델 전환(fallback) 지점 앞의 생각·도구 블록은 다시 보내지 않는다", () => {
  const content = [
    { type: "thinking", thinking: "", signature: "a" },
    { type: "text", text: "앞부분" },
    { type: "tool_use", id: "t0", name: "search_documents", input: {} },
    { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } },
    { type: "thinking", thinking: "", signature: "b" },
    { type: "text", text: "이어서" },
  ];
  assert.deepEqual(sanitizeForEcho(content).map((b) => b.type), ["text", "fallback", "thinking", "text"]);
  const plain = [{ type: "thinking" }, { type: "text" }];
  assert.equal(sanitizeForEcho(plain), plain);
});

test("자료가 없으면 목록에 없음이라고 쓴다", () => {
  assert.match(buildCatalog({ listDocuments: () => [] }), /없음/);
});
