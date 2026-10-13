// 화면 공통 도우미: 숫자·날짜 형식, 요소 만들기, 파일 아이콘.

const numberFmt = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export const fmtNumber = (v) => numberFmt.format(Math.round(v));
export const fmtCompact = (v) => compactFmt.format(v);
export const fmtPercent = (v) => `${(v * 100).toFixed(1)}%`;
export const fmtYears = (v) => `${v.toFixed(1)}`;

export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

export function fmtTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
}

export function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 작은 DOM 도우미: h("div.card", { onclick }, child, "텍스트") */
export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name || "div");
  if (classes.length) el.className = classes.join(" ");
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style") el.style.cssText = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function icon(id) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
}

const FILE_KIND = { pdf: ["pdf", "PDF"], xlsx: ["xlsx", "XLS"], csv: ["csv", "CSV"], docx: ["docx", "DOC"], pptx: ["pptx", "PPT"], text: ["text", "TXT"] };

export function fileIcon(kind, small = false) {
  const [cls, text] = FILE_KIND[kind] ?? ["text", "FILE"];
  return h(`span.ficon.${cls}${small ? ".small" : ""}`, { "aria-hidden": "true" }, text);
}

/** 자료 원문 주소. PDF는 해당 쪽으로 바로 엽니다. */
export function sourceHref(src) {
  if (!src?.docId) return null;
  const base = `/api/documents/${encodeURIComponent(src.docId)}/file`;
  return src.page ? `${base}#page=${src.page}` : base;
}

export function sourceLabel(src) {
  return [src.name, src.label].filter(Boolean).join(" · ");
}
