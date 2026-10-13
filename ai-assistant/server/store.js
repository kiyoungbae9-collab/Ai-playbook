// 자료와 대화를 data/ 폴더에 JSON으로 저장합니다.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { extractDocument } from "./parsers.js";
import { SearchIndex } from "./search.js";

const DOC_ID = /^d_[0-9a-f]{12}$/;
const CONV_ID = /^c_[0-9a-f]{16}$/;
const SOURCE = /^doc:(d_[0-9a-f]{12}):(\d+)$/;

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.docsFile = path.join(dataDir, "documents.json");
    /** @type {any[]} */
    this.documents = [];
    /** @type {Map<string, {label: string, text: string}[]>} */
    this.segments = new Map();
    this.index = new SearchIndex();
  }

  async init() {
    await fs.mkdir(path.join(this.dataDir, "docs"), { recursive: true });
    await fs.mkdir(path.join(this.dataDir, "conversations"), { recursive: true });
    this.documents = await readJson(this.docsFile, []);
    for (const doc of this.documents) {
      const segs = await readJson(path.join(this.docDir(doc.id), "segments.json"), []);
      this.segments.set(doc.id, segs);
      this.index.addDocument(doc.id, doc.name, segs);
    }
  }

  // ---------- 자료 ----------

  listDocuments() {
    return [...this.documents].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  }

  getDocument(id) {
    return DOC_ID.test(id) ? this.documents.find((d) => d.id === id) : undefined;
  }

  getSegments(id) {
    return this.segments.get(id) ?? [];
  }

  docDir(id) {
    return path.join(this.dataDir, "docs", id);
  }

  originalPath(doc) {
    return path.join(this.docDir(doc.id), `original.${doc.ext}`);
  }

  async addDocument({ buffer, filename, modifiedAt }) {
    const name = path.basename(filename).normalize("NFC");
    const { kind, segments, warnings } = await extractDocument(buffer, name);
    if (this.documents.some((d) => d.name === name)) {
      warnings.push("같은 이름의 자료가 이미 있습니다. 이전 버전이 필요 없다면 삭제해 주세요(AI가 두 버전을 모두 참고합니다).");
    }
    const id = `d_${crypto.randomBytes(6).toString("hex")}`;
    const ext = path.extname(name).slice(1).toLowerCase();
    const doc = {
      id,
      name,
      ext,
      kind,
      size: buffer.length,
      version: name.match(/(?:^|[_\-\s(])v(\d+(?:\.\d+)*)/i)?.[1] ?? null,
      modifiedAt: validDate(modifiedAt),
      uploadedAt: new Date().toISOString(),
      segmentCount: segments.length,
      firstLabel: segments[0]?.label ?? null,
      lastLabel: segments.at(-1)?.label ?? null,
      chars: segments.reduce((a, s) => a + s.text.length, 0),
      warnings,
    };
    await fs.mkdir(this.docDir(id), { recursive: true });
    await fs.writeFile(this.originalPath(doc), buffer);
    await writeJson(path.join(this.docDir(id), "segments.json"), segments);
    this.documents.push(doc);
    this.segments.set(id, segments);
    this.index.addDocument(id, name, segments);
    await writeJson(this.docsFile, this.documents);
    return doc;
  }

  async removeDocument(id) {
    const doc = this.getDocument(id);
    if (!doc) return false;
    this.documents = this.documents.filter((d) => d.id !== id);
    this.segments.delete(id);
    this.index.removeDocument(id);
    await writeJson(this.docsFile, this.documents);
    await fs.rm(this.docDir(id), { recursive: true, force: true });
    return true;
  }

  sourceKey(docId, segIndex) {
    return `doc:${docId}:${segIndex}`;
  }

  /** "doc:<id>:<구간번호>" 형태의 출처를 화면에 보여줄 정보로 바꿉니다. */
  resolveSource(source) {
    const m = typeof source === "string" ? source.match(SOURCE) : null;
    if (!m) return null;
    const doc = this.getDocument(m[1]);
    const segIndex = Number(m[2]);
    if (!doc) return { source, missing: true, name: "삭제된 자료", label: "" };
    const seg = this.getSegments(doc.id)[segIndex];
    return {
      source,
      docId: doc.id,
      name: doc.name,
      kind: doc.kind,
      segIndex,
      label: seg?.label ?? "",
      page: doc.kind === "pdf" ? segIndex + 1 : null,
      date: doc.modifiedAt ?? doc.uploadedAt,
      version: doc.version,
    };
  }

  // ---------- 대화 ----------

  async createConversation() {
    const conv = {
      id: `c_${crypto.randomBytes(8).toString("hex")}`,
      title: "새 대화",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [], // Claude API에 보내는 대화 기록(도구 호출 포함)
      turns: [], // 화면 다시 그리기용 기록
    };
    await this.saveConversation(conv);
    return conv;
  }

  async getConversation(id) {
    if (!CONV_ID.test(id)) return null;
    return readJson(this.convPath(id), null);
  }

  async saveConversation(conv) {
    conv.updatedAt = new Date().toISOString();
    await writeJson(this.convPath(conv.id), conv);
  }

  convPath(id) {
    return path.join(this.dataDir, "conversations", `${id}.json`);
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value));
  await fs.rename(tmp, file);
}

function validDate(value) {
  const d = new Date(Number(value) || value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
