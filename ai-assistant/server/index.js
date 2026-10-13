import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { config, APP_ROOT } from "./config.js";
import { Store } from "./store.js";
import { UnsupportedFileError } from "./parsers.js";
import { runTurn, friendlyError } from "./assistant.js";

const CONTENT_TYPES = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
};

/**
 * @param {{ store: Store, client: Anthropic, options?: Partial<typeof config> }} deps
 */
export function createApp({ store, client, options = {} }) {
  const opts = { ...config, ...options };
  const app = express();
  const busy = new Set();

  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'self'",
    });
    next();
  });
  if (opts.appPassword) app.use(basicAuth(opts.appPassword));

  app.use(express.static(path.join(APP_ROOT, "public")));
  app.get("/vendor/marked.esm.js", (req, res) => res.sendFile(path.join(APP_ROOT, "node_modules/marked/lib/marked.esm.js")));
  app.get("/vendor/purify.es.mjs", (req, res) => res.sendFile(path.join(APP_ROOT, "node_modules/dompurify/dist/purify.es.mjs")));

  app.get("/api/status", (req, res) => {
    res.json({
      projectName: opts.projectName,
      model: opts.model,
      hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
      documentCount: store.documents.length,
      maxUploadMb: opts.maxUploadMb,
    });
  });

  // ---------- 자료 ----------

  app.get("/api/documents", (req, res) => res.json(store.listDocuments()));

  app.post("/api/documents", express.raw({ type: () => true, limit: `${opts.maxUploadMb}mb` }), async (req, res) => {
    let filename;
    try {
      filename = decodeURIComponent(req.get("x-filename") ?? "");
    } catch {
      filename = "";
    }
    if (!filename || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "파일이 비어 있거나 이름이 없습니다." });
    }
    try {
      const doc = await store.addDocument({ buffer: req.body, filename, modifiedAt: req.get("x-last-modified") });
      res.status(201).json(doc);
    } catch (err) {
      if (err instanceof UnsupportedFileError) return res.status(400).json({ error: err.message });
      console.error("[upload]", filename, err);
      res.status(422).json({ error: `'${filename}'을(를) 읽지 못했습니다. 파일이 손상되었거나 암호가 걸려 있을 수 있습니다.` });
    }
  });

  app.delete("/api/documents/:id", async (req, res) => {
    const ok = await store.removeDocument(req.params.id);
    res.status(ok ? 204 : 404).end();
  });

  app.get("/api/documents/:id/file", (req, res) => {
    const doc = store.getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: "자료를 찾을 수 없습니다." });
    res.set("Content-Type", CONTENT_TYPES[doc.ext] ?? "application/octet-stream");
    const disposition = doc.ext === "pdf" || CONTENT_TYPES[doc.ext]?.startsWith("text/") ? "inline" : "attachment";
    res.set("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(doc.name)}`);
    res.sendFile(store.originalPath(doc));
  });

  // ---------- 대화 ----------

  app.post("/api/conversations", async (req, res) => {
    const conv = await store.createConversation();
    res.status(201).json({ id: conv.id, title: conv.title, turns: [] });
  });

  app.get("/api/conversations/:id", async (req, res) => {
    const conv = await store.getConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: "대화를 찾을 수 없습니다." });
    res.json({ id: conv.id, title: conv.title, turns: conv.turns });
  });

  app.post("/api/conversations/:id/messages", express.json({ limit: "200kb" }), async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "질문을 입력해 주세요." });
    const conv = await store.getConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: "대화를 찾을 수 없습니다." });
    if (busy.has(conv.id)) return res.status(409).json({ error: "이전 답변을 작성하는 중입니다. 잠시만 기다려 주세요." });
    busy.add(conv.id);

    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    res.status(200).set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    res.flushHeaders();

    const now = new Date().toISOString();
    if (conv.turns.length === 0) conv.title = text.length > 40 ? `${text.slice(0, 40)}…` : text;
    conv.turns.push({ role: "user", text, at: now });
    const turn = { role: "assistant", at: now, events: [] };
    conv.turns.push(turn);
    const emit = (event) => {
      if (event.t !== "status") turn.events.push(event);
      if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
    };

    try {
      await runTurn({ client, store, conv, userText: text, emit, signal: controller.signal, model: opts.model, effort: opts.effort, projectName: opts.projectName });
      emit({ t: "done" });
    } catch (err) {
      if (controller.signal.aborted) {
        turn.events.push({ t: "notice", text: "답변을 중단했습니다." });
      } else {
        console.error("[turn]", err);
        emit({ t: "error", message: friendlyError(err) });
      }
    } finally {
      busy.delete(conv.id);
      await store.saveConversation(conv).catch((err) => console.error("[save]", err));
      res.end();
    }
  });

  app.use("/api", (req, res) => res.status(404).json({ error: "없는 주소입니다." }));
  app.use((err, req, res, next) => {
    if (err.type === "entity.too.large") return res.status(413).json({ error: `파일이 너무 큽니다(최대 ${opts.maxUploadMb}MB).` });
    console.error(err);
    res.status(500).json({ error: "서버 오류가 발생했습니다." });
  });
  return app;
}

function basicAuth(password) {
  const expected = crypto.createHash("sha256").update(password).digest();
  return (req, res, next) => {
    const [scheme, encoded] = (req.get("authorization") ?? "").split(" ");
    const supplied = scheme === "Basic" && encoded ? Buffer.from(encoded, "base64").toString().split(":").slice(1).join(":") : "";
    const actual = crypto.createHash("sha256").update(supplied).digest();
    if (crypto.timingSafeEqual(expected, actual)) return next();
    res.set("WWW-Authenticate", 'Basic realm="AI Project Assistant", charset="UTF-8"').status(401).send("비밀번호가 필요합니다.");
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const store = new Store(config.dataDir);
  await store.init();
  const app = createApp({ store, client: new Anthropic() });
  app.listen(config.port, config.host, () => {
    console.log(`AI 프로젝트 비서: http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`);
    console.log(`모델 ${config.model} · effort ${config.effort} · 자료 ${store.documents.length}건 · 데이터 ${config.dataDir}`);
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      console.warn("주의: ANTHROPIC_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.");
    }
  });
}
