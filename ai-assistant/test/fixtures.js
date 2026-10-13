// 테스트용 문서(xlsx·docx·pptx·pdf)를 즉석에서 만듭니다. 내용은 모두 가상의 예시입니다.
import JSZip from "jszip";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const CT = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** @param {{ name: string, rows: (string|number)[][] }[]} sheets */
export async function makeXlsx(sheets) {
  const zip = new JSZip();
  const strings = [];
  const si = (s) => {
    let i = strings.indexOf(s);
    if (i < 0) i = strings.push(s) - 1;
    return i;
  };
  const col = (i) => String.fromCharCode(65 + i);
  sheets.forEach((sheet, n) => {
    const rows = sheet.rows
      .map((cells, r) => {
        const cs = cells
          .map((v, c) => (v === "" ? "" : typeof v === "number" ? `<c r="${col(c)}${r + 1}"><v>${v}</v></c>` : `<c r="${col(c)}${r + 1}" t="s"><v>${si(v)}</v></c>`))
          .join("");
        return `<row r="${r + 1}">${cs}</row>`;
      })
      .join("");
    zip.file(`xl/worksheets/sheet${n + 1}.xml`, `${CT}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`);
  });
  zip.file(
    "xl/workbook.xml",
    `${CT}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map((s, n) => `<sheet name="${esc(s.name)}" sheetId="${n + 1}" r:id="rId${n + 1}"/>`)
      .join("")}</sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `${CT}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map((_, n) => `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n + 1}.xml"/>`)
      .join("")}</Relationships>`,
  );
  zip.file("xl/sharedStrings.xml", `${CT}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

/** @param {({ heading?: boolean, text: string } | { table: string[][] })[]} blocks */
export async function makeDocx(blocks) {
  const zip = new JSZip();
  const para = (text, heading) =>
    `<w:p>${heading ? '<w:pPr><w:pStyle w:val="1"/></w:pPr>' : ""}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  const body = blocks
    .map((b) =>
      "table" in b
        ? `<w:tbl>${b.table.map((row) => `<w:tr>${row.map((c) => `<w:tc>${para(c)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`
        : para(b.text, b.heading),
    )
    .join("");
  zip.file("word/document.xml", `${CT}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:p/></w:body></w:document>`);
  // 한국어 Word처럼 "제목 1" 스타일 ID를 숫자로 둡니다.
  zip.file("word/styles.xml", `${CT}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style></w:styles>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

/** @param {{ lines: string[], notes?: string[] }[]} slides */
export async function makePptx(slides) {
  const zip = new JSZip();
  const paras = (lines) => lines.map((l) => `<a:p><a:r><a:t>${esc(l)}</a:t></a:r></a:p>`).join("");
  zip.file(
    "ppt/presentation.xml",
    `${CT}<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${slides
      .map((_, n) => `<p:sldId id="${256 + n}" r:id="rId${n + 1}"/>`)
      .join("")}</p:sldIdLst></p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `${CT}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides
      .map((_, n) => `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n + 1}.xml"/>`)
      .join("")}</Relationships>`,
  );
  slides.forEach((slide, n) => {
    zip.file(
      `ppt/slides/slide${n + 1}.xml`,
      `${CT}<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${paras(slide.lines)}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    );
    if (slide.notes) {
      zip.file(
        `ppt/slides/_rels/slide${n + 1}.xml.rels`,
        `${CT}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${n + 1}.xml"/></Relationships>`,
      );
      zip.file(
        `ppt/notesSlides/notesSlide${n + 1}.xml`,
        `${CT}<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${paras([String(n + 1), ...slide.notes])}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
      );
    }
  });
  return zip.generateAsync({ type: "nodebuffer" });
}

/** 영문 텍스트만 담은 최소 PDF. 쪽마다 줄 목록을 받습니다. */
export function makePdf(pages) {
  const objects = [];
  const add = (body) => objects.push(body); // 객체 번호(1부터)
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds = pages.map((lines) => {
    const stream = `BT /F1 12 Tf 72 720 Td 16 TL ${lines.map((l) => `(${l.replace(/[()\\]/g, "\\$&")}) Tj T*`).join(" ")} ET`;
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** 화면에 보이는 예시와 같은 가상의 프로젝트 자료 묶음. */
export async function sampleProjectFiles() {
  return [
    {
      name: "KenCity_제안서_v1.2.docx",
      buffer: await makeDocx([
        { heading: true, text: "KenCity 냉동 컨테이너 사업 제안" },
        { text: "가나 쿠마시 지역에 냉동 컨테이너 15대를 설치하는 사업을 제안합니다." },
        { table: [["항목", "수량", "단가(USD)", "금액(USD)"], ["냉동 컨테이너(구매 및 설치)", "15", "70,000", "1,050,000"]] },
      ]),
    },
    {
      name: "현장실사 보고서.pptx",
      buffer: await makePptx([
        { lines: ["현장실사 보고서", "2026년 10월"] },
        { lines: ["부대비용 추정", "운송, 설치, 인허가 등 부대비용 200,000 USD"], notes: ["항만 통관 비용 포함"] },
      ]),
    },
    {
      name: "시장조사_수요분석.xlsx",
      buffer: await makeXlsx([
        { name: "요약", rows: [["구분", "값"], ["조사 기간", "2026.09"]] },
        { name: "매출추정", rows: [["항목", "금액(USD)"], ["연간 예상 매출", 720000], ["가동률", "85%"]] },
      ]),
    },
    {
      name: "운영비 추정표.csv",
      buffer: Buffer.from("항목,연간 금액(USD)\n전기료,180000\n인건비,150000\n유지보수,100000\n연간 운영비 합계,430000\n", "utf8"),
    },
  ];
}
