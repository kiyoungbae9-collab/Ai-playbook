import { test } from "node:test";
import assert from "node:assert/strict";
import { SearchIndex, tokenize, chunkSegment } from "../server/search.js";

test("한국어는 두 글자씩, 영문·숫자는 단어로 나눈다", () => {
  assert.deepEqual(tokenize("투자비는 1,250,000 USD"), ["투자", "자비", "비는", "1250000", "usd"]);
  assert.deepEqual(tokenize("KenCity의 15대"), ["kencity", "의", "15", "대"]);
});

test("조사가 붙어도 관련 구간을 찾는다", () => {
  const index = new SearchIndex();
  index.addDocument("d_aaaaaaaaaaaa", "운영비 추정표.csv", [{ label: "부분 1", text: "연간 운영비 합계 430,000 USD\n전기료 180,000" }]);
  index.addDocument("d_bbbbbbbbbbbb", "제안서.docx", [{ label: "1. 개요", text: "냉동 컨테이너 15대를 설치합니다." }, { label: "2. 비용", text: "컨테이너 단가는 70,000 USD입니다." }]);
  const hits = index.search("컨테이너의 단가가 얼마야?");
  assert.equal(hits[0].docId, "d_bbbbbbbbbbbb");
  assert.equal(hits[0].segIndex, 1);
  assert.equal(index.search("운영비는")[0].docId, "d_aaaaaaaaaaaa");
});

test("자료 ID로 범위를 좁히고, 삭제하면 검색되지 않는다", () => {
  const index = new SearchIndex();
  index.addDocument("d_aaaaaaaaaaaa", "a.txt", [{ label: "부분 1", text: "냉동 창고" }]);
  index.addDocument("d_bbbbbbbbbbbb", "b.txt", [{ label: "부분 1", text: "냉동 컨테이너" }]);
  assert.deepEqual(index.search("냉동", { docIds: ["d_bbbbbbbbbbbb"] }).map((h) => h.docId), ["d_bbbbbbbbbbbb"]);
  index.removeDocument("d_bbbbbbbbbbbb");
  assert.deepEqual(index.search("냉동").map((h) => h.docId), ["d_aaaaaaaaaaaa"]);
  assert.equal(index.df.get("컨테"), undefined);
});

test("긴 구간은 여러 조각으로 나뉜다", () => {
  const chunks = chunkSegment(`${"가".repeat(3000)}\n끝`);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.length <= 1300));
  assert.ok(chunks.at(-1).endsWith("끝"));
});
