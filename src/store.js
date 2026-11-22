// 记忆库：一个 JSON 文件，按会话分桶。
// 用文件而不是数据库，是因为插件跑在 DSH 进程里，装完就该能用，不想再引入依赖。

import fs from 'node:fs';
import path from 'node:path';
import {
  DAY,
  decayState,
  fuzzText,
  initialStability,
  reinforce,
  retrievability,
} from './decay.js';

export class MemoryStore {
  constructor(file, options = {}) {
    this.file = file;
    this.baseDays = options.baseStabilityDays ?? 6.0;
    this.maxPerSession = options.maxPerSession ?? 400;
    this.data = { version: 1, sessions: {} };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.sessions) this.data = parsed;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  save() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  bucket(sessionId) {
    const key = String(sessionId || 'default');
    if (!this.data.sessions[key]) this.data.sessions[key] = { memories: [], nextId: 1 };
    return this.data.sessions[key];
  }

  list(sessionId) {
    return this.bucket(sessionId).memories;
  }

  add(sessionId, candidate, now = Date.now() / 1000) {
    const text = (candidate.text || '').trim();
    if (!text || text.length < 2) return null;
    const bucket = this.bucket(sessionId);
    const subject = candidate.subject || text.slice(0, 12);

    // 同一主语再次出现：走巩固而不是新增，否则记忆库会被同义句灌满。
    const existing = bucket.memories.find((m) => m.subject === subject && m.kind === candidate.kind);
    if (existing) {
      existing.text = text;
      existing.importance = Math.max(existing.importance, candidate.importance ?? 0.5);
      existing.updated_at = now;
      existing.stability = Math.max(existing.stability, initialStability(existing.importance, 0, this.baseDays));
      existing.hits = (existing.hits || 0) + 1;
      this.save();
      return existing;
    }

    const importance = candidate.importance ?? 0.5;
    const mem = {
      id: bucket.nextId++,
      kind: candidate.kind || 'fact',
      text,
      subject,
      importance,
      salience: candidate.salience ?? 0,
      created_at: now,
      updated_at: now,
      stability: initialStability(importance, candidate.salience ?? 0, this.baseDays),
      hits: 1,
      archived: false,
    };
    bucket.memories.push(mem);
    if (bucket.memories.length > this.maxPerSession) this.trim(bucket);
    this.save();
    return mem;
  }

  trim(bucket) {
    const alive = bucket.memories.filter((m) => !m.archived);
    if (alive.length <= this.maxPerSession) return;
    alive
      .sort((a, b) => this.r(a) - this.r(b))
      .slice(0, alive.length - this.maxPerSession)
      .forEach((m) => {
        m.archived = true;
      });
  }

  r(mem, now = Date.now() / 1000) {
    return retrievability((now - mem.updated_at) / DAY, mem.stability);
  }

  /** 召回：相关度 × R^alpha × 重要度^beta。 */
  recall(sessionId, query, options = {}) {
    const now = Date.now() / 1000;
    const limit = options.limit ?? 8;
    const minScore = options.minScore ?? 0.02;
    const alpha = options.alpha ?? 1.4;
    const beta = options.beta ?? 0.9;
    const ambient = options.ambient ?? 2;
    const ambientMinImportance = options.ambientMinImportance ?? 0.6;
    const reinforceOnRecall = options.reinforceOnRecall ?? true;

    const tokens = tokenize(query);
    const scored = [];

    for (const mem of this.list(sessionId)) {
      if (mem.archived) continue;
      const r = this.r(mem, now);
      const sim = similarity(tokens, tokenize(mem.text));
      const score = (0.08 + sim) * Math.pow(r, alpha) * Math.pow(mem.importance, beta);
      if (sim > 0 && score >= minScore) scored.push({ mem, r, score, ambient: false });
    }

    scored.sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, limit);

    // 背景记忆：有些事是「一直知道」的，不需要被问到才想起来。
    if (ambient > 0 && picked.length < limit) {
      const have = new Set(picked.map((p) => p.mem.id));
      const extra = this.list(sessionId)
        .filter((m) => !m.archived && !have.has(m.id) && m.importance >= ambientMinImportance)
        .map((m) => ({ mem: m, r: this.r(m, now), score: 0, ambient: true }))
        .filter((p) => p.r > 0.05)
        .sort((a, b) => b.r * b.mem.importance - a.r * a.mem.importance)
        .slice(0, ambient);
      picked.push(...extra);
    }

    if (reinforceOnRecall) {
      for (const p of picked) {
        if (p.ambient) continue;
        p.mem.stability = reinforce(p.mem.stability, p.r);
        p.mem.updated_at = now;
        p.mem.hits = (p.mem.hits || 0) + 1;
      }
      this.save();
    }

    return picked.map((p) => ({
      ...p.mem,
      r: p.r,
      state: decayState(p.r),
      display: fuzzText(p.mem.text, p.r, p.mem.id),
      ambient: p.ambient,
    }));
  }
}

const CJK = /[\u4e00-\u9fff]/;

export function tokenize(text) {
  const out = [];
  const lowered = String(text || '').toLowerCase();
  const words = lowered.match(/[a-z0-9]+/g) || [];
  out.push(...words);
  const chars = Array.from(lowered).filter((c) => CJK.test(c));
  for (const c of chars) out.push(c);
  for (let i = 0; i + 1 < chars.length; i += 1) out.push(chars[i] + chars[i + 1]);
  return out;
}

export function similarity(queryTokens, docTokens) {
  if (!queryTokens.length || !docTokens.length) return 0;
  const doc = new Set(docTokens);
  let hit = 0;
  for (const t of new Set(queryTokens)) if (doc.has(t)) hit += 1;
  return hit / Math.sqrt(queryTokens.length * doc.size + 1);
}
