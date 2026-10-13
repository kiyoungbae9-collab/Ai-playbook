import { marked } from "/vendor/marked.esm.js";
import DOMPurify from "/vendor/purify.es.mjs";
import { AnalysisWidget } from "./analysis.js";
import { h, icon, fileIcon, fmtDate, fmtTime, fmtSize, sourceHref, sourceLabel } from "./format.js";

const SUPPORTED = ["pdf", "xlsx", "xlsm", "docx", "pptx", "csv", "txt", "md"];
const SUGGESTIONS = [
  "KenCity의 15대 냉동 컨테이너 사업의 투자비와 회수기간을 분석해 주고, 관련 자료도 함께 보여줘.",
  "25대를 설치하면 투자비와 ROI가 어떻게 바뀌는지 분석해 줘.",
  "정부지원금을 포함하면 회수기간이 어떻게 달라지는지 계산해 줘.",
  "올린 자료들을 한눈에 요약해 줘.",
];
const REPORT_PROMPT = "위 분석 결과를 바탕으로 사업 검토 보고서 초안을 작성해 줘. 근거 자료의 출처를 포함해 줘.";
const SCENARIO_PROMPT = "다른 시나리오(예: 매출 10% 감소, 운영비 10% 증가, 설치 대수 변경)로 투자비와 회수기간을 비교 분석해 줘.";
const MARK_OPEN = "";
const MARK_CLOSE = "";

marked.setOptions({ gfm: true, breaks: false });
// 답변 속 링크는 새 탭에서 열어 작성 중인 답변이 끊기지 않게 합니다.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const $ = (id) => document.getElementById(id);
const state = { convId: null, busy: false, controller: null, docs: [], maxUploadMb: 50 };
const views = new WeakMap(); // 메시지 요소 → AssistantView

// ---------- 서버 통신 ----------

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `요청 실패 (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

// ---------- 답변 하나를 그리는 객체 ----------

class AssistantView {
  constructor() {
    this.flow = h("div.flow");
    this.status = h("div.status", { hidden: true }, h("span.spinner"), h("span"));
    this.sourcesEl = h("section.sources", { hidden: true });
    this.actionsEl = h("div.actions", { hidden: true });
    this.card = h("div.card", {}, this.flow, this.status, this.sourcesEl, this.actionsEl);
    this.el = h("article.msg.assistant", {}, h("div.bot-avatar", { "aria-hidden": "true" }, icon("i-bot")), this.card);
    this.runs = [];
    this.run = null;
    this.block = null;
    this.cites = new Map(); // source → { n, src }
    this.analyses = [];
    this.stepNodes = [];
    this.stepCites = [];
    this.hasError = false;
    views.set(this.el, this);
  }

  handle(ev) {
    switch (ev.t) {
      case "step":
        this.stepNodes = [];
        this.stepCites = [];
        break;
      case "status":
        this.setStatus(ev.text);
        break;
      case "text_start":
        if (!this.run) {
          this.run = { el: h("div.md"), md: "" };
          this.runs.push(this.run);
          this.add(this.run.el);
        }
        this.block = { cites: [] };
        this.setStatus(null);
        break;
      case "text":
        if (!this.run) this.handle({ t: "text_start" });
        this.run.md += ev.d;
        this.scheduleRender(this.run);
        break;
      case "cite":
        if (this.block && !this.block.cites.some((c) => c.source === ev.c.source)) this.block.cites.push(ev.c);
        break;
      case "text_end":
        if (this.run && this.block?.cites.length) {
          const marks = this.block.cites.map((c) => `${MARK_OPEN}${this.citeNumber(c)}${MARK_CLOSE}`).join("");
          this.run.md = this.run.md.replace(/(\s*)$/, `${marks}$1`);
          this.scheduleRender(this.run);
          this.renderSources();
        }
        this.block = null;
        break;
      case "search":
      case "read":
        this.endRun();
        this.addTrace(ev);
        break;
      case "analysis": {
        this.endRun();
        const widget = new AnalysisWidget(ev);
        this.analyses.push(widget);
        this.add(widget.el);
        this.renderSources();
        break;
      }
      case "notice":
        this.endRun();
        this.add(h("div.notice", {}, ev.text));
        break;
      case "error":
        this.endRun();
        this.hasError = true;
        this.add(h("div.error-box", { role: "alert" }, ev.message));
        break;
      case "discard":
        for (const node of this.stepNodes) node.remove();
        for (const key of this.stepCites) this.cites.delete(key);
        this.runs = this.runs.filter((r) => r.el.isConnected);
        this.analyses = this.analyses.filter((a) => a.el.isConnected);
        this.run = null;
        this.block = null;
        this.stepNodes = [];
        this.stepCites = [];
        this.renderSources();
        break;
    }
  }

  add(node) {
    this.flow.append(node);
    this.stepNodes.push(node);
  }

  endRun() {
    if (this.run) this.renderRun(this.run);
    this.run = null;
    this.block = null;
  }

  citeNumber(src) {
    let entry = this.cites.get(src.source);
    if (!entry) {
      entry = { n: this.cites.size + 1, src };
      this.cites.set(src.source, entry);
      this.stepCites.push(src.source);
    }
    return entry.n;
  }

  setStatus(text) {
    this.status.hidden = !text;
    if (text) this.status.lastChild.textContent = text;
  }

  scheduleRender(run) {
    if (run.pending) return;
    run.pending = requestAnimationFrame(() => {
      run.pending = 0;
      this.renderRun(run);
      autoScroll();
    });
  }

  renderRun(run) {
    if (run.pending) cancelAnimationFrame(run.pending);
    run.pending = 0;
    const html = DOMPurify.sanitize(marked.parse(run.md));
    run.el.innerHTML = html.replace(new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, "g"), (_, n) => `<sup class="cite" tabindex="0" role="button" data-n="${n}">${n}</sup>`);
  }

  addTrace(ev) {
    let trace = this.flow.lastElementChild;
    if (!trace?.classList.contains("trace")) {
      trace = h("details.trace", {}, h("summary"), h("ul"));
      trace.counts = { search: 0, read: 0, places: new Set() };
      this.add(trace);
    }
    const counts = trace.counts;
    const li =
      ev.t === "search"
        ? h("li", {}, "검색 ", h("span.q", {}, `'${ev.query}'`), ` → ${ev.results.length ? ev.results.map(sourceLabel).join(", ") : "결과 없음"}`)
        : h("li", {}, "읽기 ", h("span.q", {}, ev.document.name), ` (구간 ${ev.from}–${ev.to})`);
    trace.lastElementChild.append(li);
    counts[ev.t] += 1;
    if (ev.t === "search") ev.results.forEach((r) => counts.places.add(r.source));
    const parts = [];
    if (counts.search) parts.push(`자료 검색 ${counts.search}회`);
    if (counts.read) parts.push(`자료 읽기 ${counts.read}회`);
    if (counts.places.size) parts.push(`관련 구간 ${counts.places.size}곳`);
    trace.firstElementChild.replaceChildren(icon("i-search"), parts.join(" · "));
  }

  renderSources() {
    // 본문에 번호로 인용된 자료와 계산근거로 쓰인 자료를 문서별로 묶습니다.
    const byDoc = new Map();
    const addRef = (src, n) => {
      const key = src.docId ?? src.source;
      if (!byDoc.has(key)) byDoc.set(key, { src, refs: [], labels: new Set() });
      const doc = byDoc.get(key);
      if (doc.labels.has(src.label)) return; // 같은 위치는 한 번만
      doc.labels.add(src.label);
      const ref = [n ? `[${n}]` : "", src.label].filter(Boolean).join(" ");
      if (ref) doc.refs.push(ref);
    };
    for (const { n, src } of this.cites.values()) addRef(src, n);
    for (const a of this.analyses) for (const src of Object.values(a.sources)) if (src?.docId) addRef(src, null);
    this.sourcesEl.hidden = byDoc.size === 0;
    if (byDoc.size === 0) return;
    const cards = [...byDoc.values()].map(({ src, refs }) =>
      h(
        src.docId ? "a.source-card" : "div.source-card",
        src.docId ? { href: `/api/documents/${encodeURIComponent(src.docId)}/file`, target: "_blank", rel: "noopener" } : {},
        fileIcon(src.kind),
        h("span.name", {}, src.name),
        h("span.meta", {}, [fmtDate(src.date), src.version ? `v${src.version}` : ""].filter(Boolean).join(" · ")),
        refs.length ? h("span.refs", {}, refs.join(", ")) : null,
      ),
    );
    this.sourcesEl.replaceChildren(h("div.section-h", {}, icon("i-folder"), h("span", {}, `관련 원문 자료 (${byDoc.size}건)`)), h("div.source-cards", {}, cards));
  }

  finish() {
    this.endRun();
    this.setStatus(null);
    const hasContent = this.runs.some((r) => r.md.trim()) || this.analyses.length > 0;
    if (!hasContent) return;
    const latest = this.analyses.at(-1);
    const chips = [h("button.chip.primary", { type: "button", onclick: () => send(REPORT_PROMPT) }, "이 결과로 보고서 작성")];
    if (latest) {
      chips.push(
        h("button.chip.success", { type: "button", onclick: () => latest.downloadCsv() }, "Excel로 저장"),
        h("button.chip", { type: "button", onclick: () => latest.openEditor((text) => send(text)) }, "계산 조건 수정"),
        h("button.chip", { type: "button", onclick: () => send(SCENARIO_PROMPT) }, "다른 시나리오 분석"),
      );
    }
    chips.push(h("button.chip", { type: "button", onclick: () => this.copy() }, icon("i-copy"), "복사"));
    this.actionsEl.replaceChildren(...chips);
    this.actionsEl.hidden = false;
  }

  async copy() {
    const body = this.runs.map((r) => r.md.replace(new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, "g"), "[$1]")).join("\n\n");
    const refs = [...this.cites.values()].map(({ n, src }) => `[${n}] ${sourceLabel(src)}`).join("\n");
    try {
      await navigator.clipboard.writeText(refs ? `${body}\n\n출처\n${refs}` : body);
      toast("답변을 복사했습니다.");
    } catch {
      toast("복사하지 못했습니다. 브라우저 권한을 확인해 주세요.");
    }
  }
}

// ---------- 메시지 목록 ----------

const messagesEl = $("messages");

function nearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 160;
}

let stickToBottom = true;
messagesEl.addEventListener("scroll", () => {
  stickToBottom = nearBottom();
});

function autoScroll(force = false) {
  if (force || stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addUserMessage(text, at) {
  $("welcome").hidden = true;
  messagesEl.append(
    h("article.msg.user", {}, h("span.time", {}, fmtTime(at)), h("div.bubble", {}, text), h("div.user-avatar", { "aria-hidden": "true" }, icon("i-user"))),
  );
}

function addAssistantView() {
  const view = new AssistantView();
  messagesEl.append(view.el);
  return view;
}

function clearMessages() {
  for (const el of [...messagesEl.querySelectorAll(".msg")]) el.remove();
  $("welcome").hidden = false;
}

async function loadConversation(id) {
  const conv = await api(`/api/conversations/${encodeURIComponent(id)}`);
  state.convId = conv.id;
  clearMessages();
  for (const turn of conv.turns) {
    if (turn.role === "user") addUserMessage(turn.text, turn.at);
    else {
      const view = addAssistantView();
      for (const ev of turn.events) view.handle(ev);
      view.finish();
    }
  }
  autoScroll(true);
}

async function send(text) {
  text = text.trim();
  if (!text || state.busy) return;
  setBusy(true);
  const input = $("input");
  if (input.value.trim() === text) {
    input.value = "";
    resizeInput();
  }
  addUserMessage(text);
  const view = addAssistantView();
  view.setStatus("자료를 확인하는 중…");
  autoScroll(true);

  const controller = new AbortController();
  state.controller = controller;
  try {
    if (!state.convId) {
      const conv = await api("/api/conversations", { method: "POST" });
      state.convId = conv.id;
      saveConvId(conv.id);
    }
    const res = await fetch(`/api/conversations/${encodeURIComponent(state.convId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `요청 실패 (${res.status})`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) view.handle(JSON.parse(line));
      }
    }
  } catch (err) {
    if (controller.signal.aborted) view.handle({ t: "notice", text: "답변을 중단했습니다." });
    else view.handle({ t: "error", message: err.message === "Failed to fetch" ? "서버에 연결하지 못했습니다. 서버가 실행 중인지 확인해 주세요." : err.message });
  } finally {
    view.finish();
    state.controller = null;
    setBusy(false);
    autoScroll();
  }
}

function setBusy(busy) {
  state.busy = busy;
  $("send").hidden = busy;
  $("stop").hidden = !busy;
  $("new-chat").disabled = busy;
}

function saveConvId(id) {
  try {
    if (id) localStorage.setItem("convId", id);
    else localStorage.removeItem("convId");
  } catch {
    // 저장소를 못 쓰는 브라우저에서는 새로고침하면 새 대화로 시작합니다.
  }
}

function readConvId() {
  try {
    return localStorage.getItem("convId");
  } catch {
    return null;
  }
}

// ---------- 출처 말풍선 ----------

const tooltip = $("tooltip");

function citeEntry(sup) {
  const view = views.get(sup.closest(".msg.assistant"));
  const n = Number(sup.dataset.n);
  return view && [...view.cites.values()].find((c) => c.n === n);
}

function showTooltip(sup) {
  const entry = citeEntry(sup);
  if (!entry) return;
  const { src } = entry;
  const quote = src.cited ? (src.cited.length > 280 ? `${src.cited.slice(0, 280)}…` : src.cited) : null;
  tooltip.replaceChildren(
    h("div.t-title", {}, fileIcon(src.kind, true), sourceLabel(src)),
    src.date ? h("div.t-hint", {}, `작성일 ${fmtDate(src.date)}${src.version ? ` · v${src.version}` : ""}`) : null,
    quote ? h("div.t-quote", {}, quote) : null,
    src.docId ? h("div.t-hint", {}, "눌러서 원문 열기") : null,
  );
  tooltip.hidden = false;
  const r = sup.getBoundingClientRect();
  const tw = tooltip.offsetWidth;
  const th = tooltip.offsetHeight;
  tooltip.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - tw - 8))}px`;
  tooltip.style.top = `${r.top - th - 8 > 8 ? r.top - th - 8 : r.bottom + 8}px`;
}

messagesEl.addEventListener("pointerover", (e) => {
  const sup = e.target.closest?.("sup.cite");
  if (sup) showTooltip(sup);
});
messagesEl.addEventListener("pointerout", (e) => {
  if (e.target.closest?.("sup.cite")) tooltip.hidden = true;
});
messagesEl.addEventListener("focusin", (e) => {
  if (e.target.matches?.("sup.cite")) showTooltip(e.target);
});
messagesEl.addEventListener("focusout", () => {
  tooltip.hidden = true;
});
function openCite(sup) {
  const href = sourceHref(citeEntry(sup)?.src);
  if (href) window.open(href, "_blank", "noopener");
}
messagesEl.addEventListener("click", (e) => {
  const sup = e.target.closest?.("sup.cite");
  if (sup) openCite(sup);
});
messagesEl.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.("sup.cite")) {
    e.preventDefault();
    openCite(e.target);
  }
});

// ---------- 자료 업로드·관리 ----------

async function refreshDocs() {
  state.docs = await api("/api/documents");
  $("doc-count").textContent = state.docs.length;
  renderDocList();
}

const pendingUploads = [];

function renderDocList() {
  const list = $("doc-list");
  const items = [
    ...pendingUploads.map((u) =>
      h(`li.${u.error ? "failed" : "uploading"}`, {}, fileIcon("text"), h("div.info", {}, h("div.name", {}, u.name), h("div.meta", {}, u.error ?? "올리는 중… 텍스트를 추출하고 있습니다."))),
    ),
    ...state.docs.map((d) =>
      h(
        "li",
        {},
        fileIcon(d.kind),
        h(
          "div.info",
          {},
          h("div.name", {}, d.name),
          h("div.meta", {}, [`${d.segmentCount}개 구간`, fmtSize(d.size), `작성일 ${fmtDate(d.modifiedAt ?? d.uploadedAt)}`, d.version ? `v${d.version}` : null, `업로드 ${fmtDate(d.uploadedAt)}`].filter(Boolean).join(" · ")),
          d.warnings?.length ? h("div.warn", {}, d.warnings.join(" ")) : null,
        ),
        h("a.icon-btn", { href: `/api/documents/${encodeURIComponent(d.id)}/file`, target: "_blank", rel: "noopener", title: "원문 열기", "aria-label": `${d.name} 원문 열기` }, icon("i-external")),
        h("button.icon-btn", { type: "button", title: "삭제", "aria-label": `${d.name} 삭제`, onclick: () => deleteDoc(d) }, icon("i-trash")),
      ),
    ),
  ];
  if (items.length === 0) items.push(h("li.empty", {}, "아직 올린 자료가 없습니다."));
  list.replaceChildren(...items);
}

async function deleteDoc(doc) {
  if (!confirm(`'${doc.name}'을(를) 삭제할까요? 팀 전체에서 이 자료가 사라집니다.`)) return;
  try {
    await api(`/api/documents/${encodeURIComponent(doc.id)}`, { method: "DELETE" });
    await refreshDocs();
    toast("자료를 삭제했습니다.");
  } catch (err) {
    toast(err.message);
  }
}

async function uploadFiles(files) {
  const list = [...files];
  if (list.length === 0) return;
  let ok = 0;
  const problems = [];
  for (const file of list) {
    const ext = file.name.split(".").pop().toLowerCase();
    if (!SUPPORTED.includes(ext)) {
      problems.push(`${file.name}: 지원하지 않는 형식`);
      continue;
    }
    if (file.size > state.maxUploadMb * 1024 * 1024) {
      problems.push(`${file.name}: ${state.maxUploadMb}MB 초과`);
      continue;
    }
    const pending = { name: file.name };
    pendingUploads.push(pending);
    renderDocList();
    toast(`'${file.name}' 올리는 중…`, 0);
    try {
      const doc = await api("/api/documents", {
        method: "POST",
        headers: { "X-Filename": encodeURIComponent(file.name), "X-Last-Modified": String(file.lastModified || "") },
        body: file,
      });
      ok += 1;
      if (doc.warnings?.length) problems.push(`${doc.name}: ${doc.warnings.join(" ")}`);
      pendingUploads.splice(pendingUploads.indexOf(pending), 1);
    } catch (err) {
      pending.error = err.message;
      problems.push(`${file.name}: ${err.message}`);
      setTimeout(() => {
        pendingUploads.splice(pendingUploads.indexOf(pending), 1);
        renderDocList();
      }, 6000);
    }
    await refreshDocs().catch(() => {});
  }
  toast([ok ? `자료 ${ok}건을 올렸습니다.` : null, ...problems].filter(Boolean).join("\n"), problems.length ? 7000 : 3000);
}

// ---------- 화면 요소 연결 ----------

let toastTimer;
function toast(text, ms = 3000) {
  const el = $("toast");
  el.textContent = text;
  el.style.whiteSpace = "pre-line";
  el.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function resizeInput() {
  const input = $("input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

function setupComposer() {
  const input = $("input");
  input.addEventListener("input", resizeInput);
  input.addEventListener("keydown", (e) => {
    // 한글 입력 중(조합 중) Enter는 글자 확정이므로 보내지 않습니다.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      send(input.value);
    }
  });
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    send(input.value);
  });
  $("stop").addEventListener("click", () => state.controller?.abort());
  $("attach").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", (e) => {
    uploadFiles(e.target.files);
    e.target.value = "";
  });
  $("new-chat").addEventListener("click", () => {
    if (state.busy) return;
    state.convId = null;
    saveConvId(null);
    clearMessages();
    input.focus();
  });
}

function setupDialogs() {
  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog || e.target.closest("[data-close]")) dialog.close();
    });
  }
  $("open-docs").addEventListener("click", () => {
    renderDocList();
    $("docs-dialog").showModal();
  });
  $("open-guide").addEventListener("click", () => $("guide-dialog").showModal());
  $("pick-files").addEventListener("click", () => $("file-input").click());

  const zone = $("dropzone");
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove("over");
    uploadFiles(e.dataTransfer.files);
  });

  // 화면 어디에 끌어 놓아도 업로드됩니다.
  const overlay = $("drop-overlay");
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e) || $("docs-dialog").open) return;
    depth += 1;
    overlay.hidden = false;
  });
  window.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });
  window.addEventListener("dragover", (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    uploadFiles(e.dataTransfer.files);
  });
}

function setupWelcome() {
  $("suggestions").replaceChildren(...SUGGESTIONS.map((text) => h("button.suggestion", { type: "button", onclick: () => send(text) }, text)));
}

async function init() {
  setupComposer();
  setupDialogs();
  setupWelcome();
  try {
    const status = await api("/api/status");
    $("project-name").textContent = status.projectName;
    document.title = `AI 프로젝트 비서 · ${status.projectName}`;
    state.maxUploadMb = status.maxUploadMb;
    $("max-mb").textContent = status.maxUploadMb;
    if (!status.hasApiKey) {
      const banner = $("banner");
      banner.replaceChildren("Claude API 키가 설정되지 않았습니다. ", h("code", {}, "ai-assistant/.env"), " 파일에 ", h("code", {}, "ANTHROPIC_API_KEY"), "를 넣고 서버를 다시 시작해 주세요.");
      banner.hidden = false;
    }
    await refreshDocs();
  } catch (err) {
    toast(`서버에 연결하지 못했습니다: ${err.message}`, 0);
  }
  const saved = readConvId();
  if (saved) {
    try {
      await loadConversation(saved);
    } catch {
      saveConvId(null);
    }
  }
  $("input").focus();
}

init();
