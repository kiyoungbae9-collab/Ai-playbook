import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDocument, UnsupportedFileError } from "../server/parsers.js";
import { makeDocx, makePdf, makePptx, makeXlsx } from "./fixtures.js";

test("PDF는 쪽마다 구간이 된다", async () => {
  const pdf = makePdf([["Container unit cost 70,000 USD"], ["Installation 200,000 USD", "Total 1,250,000"]]);
  const { kind, segments } = await extractDocument(pdf, "report.pdf");
  assert.equal(kind, "pdf");
  assert.deepEqual(segments.map((s) => s.label), ["p.1", "p.2"]);
  assert.match(segments[0].text, /Container unit cost 70,000 USD/);
  assert.match(segments[1].text, /Total 1,250,000/);
});

test("엑셀은 시트마다 구간이 되고 셀 값을 행 단위로 읽는다", async () => {
  const xlsx = await makeXlsx([
    { name: "요약", rows: [["구분", "값"]] },
    { name: "매출추정", rows: [["항목", "금액"], ["연간 예상 매출", 720000]] },
  ]);
  const { segments } = await extractDocument(xlsx, "시장조사.xlsx");
  assert.deepEqual(segments.map((s) => s.label), ["시트1 '요약'", "시트2 '매출추정'"]);
  assert.match(segments[1].text, /행 2: A=연간 예상 매출 \| B=720000/);
});

test("워드는 제목 기준으로 나누고 표를 한 줄씩 읽는다", async () => {
  const docx = await makeDocx([
    { heading: true, text: "사업 개요" },
    { text: "냉동 컨테이너 & 물류" },
    { heading: true, text: "비용" },
    { table: [["항목", "금액"], ["컨테이너", "1,050,000"]] },
  ]);
  const { segments } = await extractDocument(docx, "제안서.docx");
  assert.deepEqual(segments.map((s) => s.label), ["1. 사업 개요", "2. 비용"]);
  assert.match(segments[0].text, /냉동 컨테이너 & 물류/);
  assert.match(segments[1].text, /컨테이너 \| 1,050,000/);
});

test("파워포인트는 슬라이드마다 구간이 되고 발표자 노트도 읽는다", async () => {
  const pptx = await makePptx([{ lines: ["표지"] }, { lines: ["부대비용 200,000 USD"], notes: ["통관 비용 포함"] }]);
  const { segments } = await extractDocument(pptx, "보고서.pptx");
  assert.deepEqual(segments.map((s) => s.label), ["슬라이드 1", "슬라이드 2"]);
  assert.match(segments[1].text, /\[발표자 노트\]\n통관 비용 포함/);
  assert.doesNotMatch(segments[1].text, /^2$/m);
});

test("CP949로 저장한 CSV도 읽는다", async () => {
  const eucKr = Buffer.from([0xbf, 0xee, 0xbf, 0xb5, 0xba, 0xf1, 0x2c, 0x34, 0x33, 0x30]); // "운영비,430"
  const { segments } = await extractDocument(eucKr, "운영비.csv");
  assert.equal(segments[0].text, "운영비,430");
});

test("지원하지 않는 형식은 알려 준다", async () => {
  await assert.rejects(extractDocument(Buffer.from("x"), "old.hwp"), UnsupportedFileError);
});
