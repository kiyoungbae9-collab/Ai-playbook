// 자료 검색: 구간을 작은 조각(chunk)으로 나누고 BM25로 순위를 매깁니다.
// 한국어는 조사가 붙어 단어가 바뀌므로("투자비는", "투자비를") 두 글자씩 끊어(bigram) 비교합니다.

const CHUNK_CHARS = 1200;
const K1 = 1.2;
const B = 0.75;
const LONG_LINE = new RegExp(`[\\s\\S]{1,${CHUNK_CHARS}}`, "g");

/**
 * @typedef {{ docId: string, segIndex: number, label: string, text: string }} Chunk
 */

export function tokenize(text) {
  const normalized = text.normalize("NFKC").toLowerCase().replace(/(\d),(?=\d{3})/g, "$1");
  const tokens = [];
  // "15대", "KenCity의"처럼 붙어 있는 한글과 영문·숫자는 따로 나눕니다.
  for (const word of normalized.match(/\p{Script=Hangul}+|[[\p{L}\p{N}]--\p{Script=Hangul}]+/gv) ?? []) {
    if (/\p{Script=Hangul}/u.test(word)) {
      if (word.length === 1) tokens.push(word);
      for (let i = 0; i < word.length - 1; i++) tokens.push(word.slice(i, i + 2));
    } else {
      tokens.push(word);
    }
  }
  return tokens;
}

/** 구간 텍스트를 줄 경계에서 약 CHUNK_CHARS 크기로 자릅니다. 앞 조각의 마지막 줄을 겹쳐 문맥을 잇습니다. */
export function chunkSegment(text) {
  // 줄 하나가 너무 길면(문단 전체가 한 줄인 PDF 등) 먼저 잘라 둡니다.
  const lines = text.split("\n").flatMap((l) => (l.length <= CHUNK_CHARS ? [l] : l.match(LONG_LINE)));
  const chunks = [];
  let buf = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length > CHUNK_CHARS && buf.length) {
      chunks.push(buf.join("\n"));
      const last = buf[buf.length - 1];
      buf = last.length < CHUNK_CHARS / 4 ? [last] : [];
      size = buf.reduce((a, l) => a + l.length + 1, 0);
    }
    buf.push(line);
    size += line.length + 1;
  }
  if (buf.length) chunks.push(buf.join("\n"));
  return chunks.filter((c) => c.trim() !== "");
}

export class SearchIndex {
  constructor() {
    /** @type {(Chunk & { tf: Map<string, number>, length: number })[]} */
    this.entries = [];
    this.df = new Map();
  }

  /** 문서 하나의 구간들을 색인에 추가합니다. 파일 이름도 함께 색인해 "운영비 추정표"처럼 이름으로 찾을 수 있게 합니다. */
  addDocument(docId, docName, segments) {
    segments.forEach((seg, segIndex) => {
      for (const text of chunkSegment(seg.text)) {
        const tokens = tokenize(`${docName} ${seg.label}\n${text}`);
        const tf = new Map();
        for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
        for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
        this.entries.push({ docId, segIndex, label: seg.label, text, tf, length: tokens.length });
      }
    });
  }

  removeDocument(docId) {
    const kept = [];
    for (const e of this.entries) {
      if (e.docId !== docId) {
        kept.push(e);
        continue;
      }
      for (const t of e.tf.keys()) {
        const n = this.df.get(t) - 1;
        if (n > 0) this.df.set(t, n);
        else this.df.delete(t);
      }
    }
    this.entries = kept;
  }

  /**
   * @param {string} query
   * @param {{ docIds?: string[], limit?: number }} [options]
   * @returns {(Chunk & { score: number })[]}
   */
  search(query, { docIds, limit = 6 } = {}) {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0 || this.entries.length === 0) return [];
    const n = this.entries.length;
    const avgLen = this.entries.reduce((a, e) => a + e.length, 0) / n;
    const filter = docIds?.length ? new Set(docIds) : null;

    const scored = [];
    for (const e of this.entries) {
      if (filter && !filter.has(e.docId)) continue;
      let score = 0;
      for (const t of terms) {
        const f = e.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * e.length) / avgLen));
      }
      if (score > 0) scored.push({ docId: e.docId, segIndex: e.segIndex, label: e.label, text: e.text, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}
