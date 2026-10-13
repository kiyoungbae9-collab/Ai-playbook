// 서버 전체 흐름: 자료 업로드 → 질문 → (가짜) Claude API 스트리밍 → 화면 이벤트 → 대화 저장.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { createApp } from "../server/index.js";
import { Store } from "../server/store.js";
import { startFakeAnthropic } from "./fake-anthropic.js";
import { sampleProjectFiles, makePdf } from "./fixtures.js";

let fake;
let server;
let baseUrl;
let dataDir;

before(async () => {
  fake = await startFakeAnthropic();
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "assistant-test-"));
  const store = new Store(dataDir);
  await store.init();
  const client = new Anthropic({ apiKey: "test-key", baseURL: fake.url, maxRetries: 0 });
  const app = createApp({ store, client, options: { projectName: "테스트 프로젝트", appPassword: "" } });
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await fake.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function upload(name, buffer) {
  const res = await fetch(`${baseUrl}/api/documents`, {
    method: "POST",
    headers: { "X-Filename": encodeURIComponent(name), "X-Last-Modified": String(Date.UTC(2026, 9, 2)) },
    body: buffer,
  });
  return { status: res.status, body: await res.json() };
}

async function ask(convId, text) {
  const res = await fetch(`${baseUrl}/api/conversations/${convId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  assert.equal(res.status, 200);
  return (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
}

test("자료를 올리고 질문하면 검색·계산·출처가 달린 답변이 스트리밍된다", async () => {
  for (const f of await sampleProjectFiles()) {
    const { status, body } = await upload(f.name, f.buffer);
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.name, f.name);
  }
  const docs = await (await fetch(`${baseUrl}/api/documents`)).json();
  assert.equal(docs.length, 4);
  assert.equal(docs.find((d) => d.name.startsWith("KenCity")).version, "1.2");

  const conv = await (await fetch(`${baseUrl}/api/conversations`, { method: "POST" })).json();
  const events = await ask(conv.id, "KenCity 15대 냉동 컨테이너 사업의 투자비와 회수기간을 분석해 줘");
  const types = events.map((e) => e.t);

  assert.equal(types.at(-1), "done");
  assert.ok(!types.includes("error"), JSON.stringify(events.filter((e) => e.t === "error")));

  const search = events.find((e) => e.t === "search");
  assert.ok(search.results.length >= 4, "네 자료 모두 검색되어야 함");

  const analysis = events.find((e) => e.t === "analysis");
  assert.equal(analysis.input.investment_items[0].quantity, 15);
  const sourceNames = Object.values(analysis.sources).map((s) => s.name).sort();
  assert.deepEqual(sourceNames, ["KenCity_제안서_v1.2.docx", "시장조사_수요분석.xlsx", "운영비 추정표.csv", "현장실사 보고서.pptx"].sort());

  const cites = events.filter((e) => e.t === "cite");
  assert.equal(cites.length, 3);
  assert.equal(cites[0].c.name, "KenCity_제안서_v1.2.docx");
  assert.equal(cites[1].c.label, "슬라이드 2");
  assert.equal(cites[2].c.label, "시트2 '매출추정'");

  const text = events.filter((e) => e.t === "text").map((e) => e.d).join("");
  assert.match(text, /약 \*\*4\.3년\*\*에 회수/);

  // Claude API에 보낸 요청 확인
  assert.equal(fake.requests.length, 3);
  const first = fake.requests[0];
  assert.equal(first.body.model, "claude-opus-5-5");
  assert.deepEqual(first.body.thinking, { type: "adaptive" });
  assert.deepEqual(first.body.cache_control, { type: "ephemeral" });
  assert.equal(first.body.fallbacks, "default");
  assert.match(first.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  assert.ok(first.body.tools.every((t) => t.eager_input_streaming === true));
  assert.match(first.body.system[1].text, /현재 업로드된 자료 \(4건\)/);

  // 두 번째 요청에는 생각 블록(서명 포함)과 검색 결과(search_result)가 그대로 들어가야 함
  const second = fake.requests[1].body.messages;
  assert.equal(second[1].content[0].type, "thinking");
  assert.equal(second[1].content[0].signature, "sig-1");
  const searchResults = second[2].content[0].content;
  assert.ok(searchResults.every((b) => b.type === "search_result" && b.citations.enabled && b.source.startsWith("doc:d_")));

  // 대화가 저장되어 다시 불러올 수 있어야 함
  const saved = await (await fetch(`${baseUrl}/api/conversations/${conv.id}`)).json();
  assert.equal(saved.turns.length, 2);
  assert.ok(saved.turns[1].events.some((e) => e.t === "analysis"));
  assert.ok(!saved.turns[1].events.some((e) => e.t === "status"));
});

test("PDF 원문은 브라우저에서 바로 열리도록 내려준다", async () => {
  const { body } = await upload("현장실사 보고서.pdf", makePdf([["page one"], ["page two"]]));
  assert.equal(body.segmentCount, 2);
  const res = await fetch(`${baseUrl}/api/documents/${body.id}/file`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.match(res.headers.get("content-disposition"), /^inline; filename\*=UTF-8''%ED%98%84/);
  assert.equal((await fetch(`${baseUrl}/api/documents/${body.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await fetch(`${baseUrl}/api/documents/${body.id}/file`)).status, 404);
});

test("지원하지 않는 형식과 잘못된 ID는 거절한다", async () => {
  const { status, body } = await upload("old.hwp", Buffer.from("x"));
  assert.equal(status, 400);
  assert.match(body.error, /지원하지 않는 형식/);
  assert.equal((await fetch(`${baseUrl}/api/documents/../../etc/passwd/file`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/conversations/c_nothere`)).status, 404);
});

test("API 키가 틀리면 이해할 수 있는 오류를 보내고 대화 기록을 되돌린다", async () => {
  const store = new Store(dataDir);
  await store.init();
  const client = new Anthropic({ apiKey: "bad", baseURL: "http://127.0.0.1:9", maxRetries: 0 });
  const app = createApp({ store, client, options: { appPassword: "" } });
  const s = await new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
  });
  try {
    const url = `http://127.0.0.1:${s.address().port}`;
    const conv = await (await fetch(`${url}/api/conversations`, { method: "POST" })).json();
    const res = await fetch(`${url}/api/conversations/${conv.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "안녕" }) });
    const events = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(events.at(-1).t, "error");
    assert.match(events.at(-1).message, /연결하지 못했습니다/);
    const raw = JSON.parse(await fs.readFile(path.join(dataDir, "conversations", `${conv.id}.json`), "utf8"));
    assert.equal(raw.messages.length, 0);
    assert.equal(raw.turns.length, 2);
  } finally {
    await new Promise((r) => s.close(r));
  }
});

test("APP_PASSWORD를 설정하면 비밀번호 없이는 열리지 않는다", async () => {
  const store = new Store(dataDir);
  await store.init();
  const app = createApp({ store, client: new Anthropic({ apiKey: "x" }), options: { appPassword: "s3cret" } });
  const s = await new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
  });
  try {
    const url = `http://127.0.0.1:${s.address().port}/api/status`;
    assert.equal((await fetch(url)).status, 401);
    const ok = await fetch(url, { headers: { Authorization: `Basic ${Buffer.from("team:s3cret").toString("base64")}` } });
    assert.equal(ok.status, 200);
  } finally {
    await new Promise((r) => s.close(r));
  }
});
