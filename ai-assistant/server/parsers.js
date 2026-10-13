// 업로드한 자료에서 텍스트를 뽑아 "구간(segment)" 단위로 나눕니다.
// PDF는 쪽, 엑셀은 시트, 파워포인트는 슬라이드 단위라서 출처를 "p.8", "시트 '매출'"처럼 표시할 수 있습니다.
import path from "node:path";
import { createRequire } from "node:module";
import JSZip from "jszip";

const require = createRequire(import.meta.url);
const PDFJS_DIR = path.dirname(require.resolve("pdfjs-dist/package.json"));

export const SUPPORTED_EXTENSIONS = ["pdf", "xlsx", "xlsm", "docx", "pptx", "csv", "txt", "md"];

const KIND_BY_EXT = { pdf: "pdf", xlsx: "xlsx", xlsm: "xlsx", docx: "docx", pptx: "pptx", csv: "csv", txt: "text", md: "text" };
const TEXT_SEGMENT_CHARS = 3000;
const MAX_SHEET_ROWS = 5000;

/**
 * @typedef {{ label: string, text: string }} Segment
 * @returns {Promise<{ kind: string, segments: Segment[], warnings: string[] }>}
 */
export async function extractDocument(buffer, filename) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  const kind = KIND_BY_EXT[ext];
  if (!kind) {
    throw new UnsupportedFileError(`지원하지 않는 형식입니다 (.${ext || "?"}). 지원 형식: ${SUPPORTED_EXTENSIONS.join(", ")}`);
  }
  const warnings = [];
  let segments;
  switch (kind) {
    case "pdf":
      segments = await extractPdf(buffer);
      if (segments.every((s) => s.text.trim() === "")) {
        warnings.push("텍스트를 추출하지 못했습니다. 스캔한 이미지 PDF라면 텍스트가 있는 PDF로 다시 저장해 주세요.");
      }
      break;
    case "xlsx":
      segments = await extractXlsx(buffer, warnings);
      break;
    case "docx":
      segments = await extractDocx(buffer);
      break;
    case "pptx":
      segments = await extractPptx(buffer);
      break;
    default:
      segments = splitText(decodeText(buffer), "부분");
  }
  segments = segments.filter((s) => s.text.trim() !== "");
  if (segments.length === 0 && warnings.length === 0) warnings.push("자료에서 읽을 수 있는 텍스트가 없습니다.");
  return { kind, segments, warnings };
}

export class UnsupportedFileError extends Error {}

// ---------- PDF ----------

async function extractPdf(buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    cMapUrl: path.join(PDFJS_DIR, "cmaps") + path.sep,
    cMapPacked: true,
    standardFontDataUrl: path.join(PDFJS_DIR, "standard_fonts") + path.sep,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  const segments = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str;
        text += item.hasEOL ? "\n" : item.str ? " " : "";
      }
      segments.push({ label: `p.${n}`, text: tidy(text) });
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return segments;
}

// ---------- XLSX ----------

async function extractXlsx(buffer, warnings) {
  const zip = await JSZip.loadAsync(buffer);
  const workbook = await readZipText(zip, "xl/workbook.xml");
  const rels = parseRels(await readZipText(zip, "xl/_rels/workbook.xml.rels"));
  const shared = parseSharedStrings(await readZipText(zip, "xl/sharedStrings.xml", ""));

  const segments = [];
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => ({
    name: decodeXml(attr(m[1], "name") ?? ""),
    rid: attr(m[1], "r:id"),
  }));
  for (const [i, sheet] of sheets.entries()) {
    const target = rels.get(sheet.rid);
    if (!target) continue;
    const file = target.startsWith("/") ? target.slice(1) : path.posix.join("xl", target);
    const xml = await readZipText(zip, file, "");
    const lines = [];
    let rowCount = 0;
    for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      if (++rowCount > MAX_SHEET_ROWS) {
        warnings.push(`시트 '${sheet.name}'는 ${MAX_SHEET_ROWS}행까지만 읽었습니다.`);
        break;
      }
      const cells = [];
      for (const cell of row[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const value = cellValue(cell[1], cell[2] ?? "", shared);
        if (value === "") continue;
        const ref = attr(cell[1], "r") ?? "";
        cells.push(`${ref.replace(/\d+$/, "")}=${value}`);
      }
      if (cells.length) lines.push(`행 ${attr(row[1], "r") ?? rowCount}: ${cells.join(" | ")}`);
    }
    segments.push({ label: `시트${i + 1} '${sheet.name}'`, text: lines.join("\n") });
  }
  return segments;
}

function cellValue(attrs, inner, shared) {
  const type = attr(attrs, "t");
  if (type === "inlineStr") return decodeXml(joinTags(inner, "t")).trim();
  const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
  if (v === undefined) return "";
  if (type === "s") return (shared[Number(v)] ?? "").trim();
  if (type === "b") return v === "1" ? "TRUE" : "FALSE";
  return decodeXml(v).trim();
}

function parseSharedStrings(xml) {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decodeXml(joinTags(m[1], "t")));
}

// ---------- DOCX ----------

async function extractDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await readZipText(zip, "word/document.xml");
  const body = xml.match(/<w:body>([\s\S]*)<\/w:body>/)?.[1] ?? xml;
  const headingStyles = parseHeadingStyles(await readZipText(zip, "word/styles.xml", ""));

  // 표는 "셀 | 셀" 한 줄로, 문단은 한 줄로 바꿉니다.
  const blocks = [];
  for (const m of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[\s\S]*?<\/w:p>/g)) {
    if (m[0].startsWith("<w:tbl>")) {
      for (const row of m[0].matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)) {
        const cells = [...row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((c) => docxParagraphs(c[0]).join(" "));
        blocks.push({ heading: false, text: cells.join(" | ") });
      }
    } else {
      const style = m[0].match(/<w:pStyle w:val="([^"]+)"/)?.[1];
      blocks.push({ heading: headingStyles.has(style), text: docxParagraphs(m[0]).join("\n") });
    }
  }

  // 큰 제목이 나오거나 분량이 많아지면 새 구간을 시작합니다.
  const segments = [];
  let current = { title: "", lines: [], size: 0 };
  const flush = () => {
    if (current.lines.length) {
      const n = segments.length + 1;
      segments.push({ label: current.title ? `${n}. ${current.title.slice(0, 40)}` : `부분 ${n}`, text: current.lines.join("\n") });
    }
  };
  for (const b of blocks) {
    if (!b.text.trim()) continue;
    if ((b.heading && current.size > 0) || current.size > TEXT_SEGMENT_CHARS) {
      flush();
      current = { title: "", lines: [], size: 0 };
    }
    if (b.heading && !current.title) current.title = b.text.trim();
    current.lines.push(b.text);
    current.size += b.text.length;
  }
  flush();
  return segments;
}

// 한국어 Word는 "제목 1" 스타일 ID가 "1"처럼 숫자라서 styles.xml의 이름으로 판별합니다.
function parseHeadingStyles(xml) {
  const ids = new Set(["Heading1", "Heading2", "Title"]);
  for (const m of xml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const name = m[2].match(/<w:name w:val="([^"]+)"/)?.[1] ?? "";
    if (/^(heading [12]|title)$/i.test(name)) ids.add(attr(m[1], "w:styleId"));
  }
  return ids;
}

function docxParagraphs(xml) {
  return [...xml.matchAll(/<w:p\b[^>]*\/>|<w:p\b[\s\S]*?<\/w:p>/g)].map((p) =>
    decodeXml(
      p[0]
        .replace(/<w:tab\/>/g, "<w:t>\t</w:t>")
        .replace(/<w:br\/>/g, "<w:t>\n</w:t>")
        .match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g)
        ?.map((t) => t.replace(/<[^>]+>/g, ""))
        .join("") ?? "",
    ),
  );
}

// ---------- PPTX ----------

async function extractPptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const presentation = await readZipText(zip, "ppt/presentation.xml");
  const rels = parseRels(await readZipText(zip, "ppt/_rels/presentation.xml.rels"));
  const slideFiles = [...presentation.matchAll(/<p:sldId\b([^>]*)\/?>/g)]
    .map((m) => rels.get(attr(m[1], "r:id")))
    .filter(Boolean)
    .map((t) => (t.startsWith("/") ? t.slice(1) : path.posix.join("ppt", t)));

  const segments = [];
  for (const [i, file] of slideFiles.entries()) {
    const lines = pptxParagraphs(await readZipText(zip, file, ""));
    const slideRels = parseRels(await readZipText(zip, file.replace(/([^/]+)$/, "_rels/$1.rels"), ""));
    const notesTarget = [...slideRels.values()].find((t) => t.includes("notesSlide"));
    if (notesTarget) {
      const notes = pptxParagraphs(await readZipText(zip, path.posix.join(path.posix.dirname(file), notesTarget), ""));
      // 노트 슬라이드에는 슬라이드 번호 자리표시자가 들어 있어 숫자만 있는 줄은 뺍니다.
      const meaningful = notes.filter((l) => !/^\d+$/.test(l.trim()));
      if (meaningful.length) lines.push("[발표자 노트]", ...meaningful);
    }
    segments.push({ label: `슬라이드 ${i + 1}`, text: lines.join("\n") });
  }
  return segments;
}

function pptxParagraphs(xml) {
  return [...xml.matchAll(/<a:p>[\s\S]*?<\/a:p>/g)]
    .map((p) => decodeXml(joinTags(p[0].replace(/<a:br\/>/g, "<a:t>\n</a:t>"), "a:t")))
    .filter((l) => l.trim() !== "");
}

// ---------- 텍스트·CSV ----------

function decodeText(buffer) {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  if (!utf8.includes("�")) return utf8.replace(/^﻿/, "");
  // 한국어 엑셀이 저장한 CSV는 CP949(EUC-KR)인 경우가 많습니다.
  try {
    return new TextDecoder("euc-kr").decode(buffer);
  } catch {
    return utf8;
  }
}

function splitText(text, labelPrefix) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const segments = [];
  let buf = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length > TEXT_SEGMENT_CHARS && buf.length) {
      segments.push({ label: `${labelPrefix} ${segments.length + 1}`, text: buf.join("\n") });
      buf = [];
      size = 0;
    }
    buf.push(line);
    size += line.length + 1;
  }
  if (buf.length) segments.push({ label: `${labelPrefix} ${segments.length + 1}`, text: buf.join("\n") });
  return segments;
}

// ---------- 공통 ----------

async function readZipText(zip, name, fallback) {
  const file = zip.file(name);
  if (!file) {
    if (fallback !== undefined) return fallback;
    throw new UnsupportedFileError(`파일 구조를 읽을 수 없습니다 (${name} 없음). 손상되었거나 암호가 걸린 파일일 수 있습니다.`);
  }
  return file.async("string");
}

function parseRels(xml) {
  const map = new Map();
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    map.set(attr(m[1], "Id"), attr(m[1], "Target"));
  }
  return map;
}

function attr(attrs, name) {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name.replace(":", "\\:")}="([^"]*)"`));
  return m ? m[1] : undefined;
}

function joinTags(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => m[1]).join("");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()];
  });
}

function tidy(text) {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
