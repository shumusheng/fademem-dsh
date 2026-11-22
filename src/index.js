// DSH 插件入口。
//
// 设计上尽量「不假设」：服务名、事件名都按 DSH 文档里写的那套用，但每一处
// 都做存在性判断。插件挂不上时应该安静地不工作，而不是把宿主的对话搞崩。

import os from 'node:os';
import path from 'node:path';

import { extract } from './extract.js';
import { assemble, DEFAULT_PERSONA } from './prompt.js';
import { MemoryStore } from './store.js';
import { renderMemoryUsage, renderStyle } from './style.js';

export const name = 'fademem-dsh';

export const DEFAULT_FILE = path.join(os.homedir(), '.fademem', 'dsh-memory.json');

export function apply(ctx, config = {}) {
  const cfg = normalize(config);
  const log = makeLogger(ctx);

  let store;
  try {
    store = new MemoryStore(cfg.memoryFile, {
      baseStabilityDays: cfg.baseStabilityDays,
      maxPerSession: cfg.maxPerSession,
    });
  } catch (err) {
    log.error(`记忆库打不开（${cfg.memoryFile}）：${err.message}`);
    return;
  }

  // 每个会话最近一句用户输入：既是抽取的原料，也是召回的查询。
  const latest = new Map();
  // 装配发生在用户消息之后，所以「最近一条消息的会话」就是当前会话。
  // 宿主没暴露 ctx.session 时靠它兜底，否则写入和读取会用两个不同的桶。
  let lastSessionId = 'default';
  let sectionDispose = null;

  try {
    ctx.on('session/event', (session, event) => {
      try {
        if (!event || event.type !== 'user/message') return;
        const text = textOf(event);
        if (!text) return;
        const sid = sessionIdOf(session, event);
        lastSessionId = sid;
        latest.set(sid, text);
        for (const candidate of extract(text, cfg.extraction)) {
          store.add(sid, candidate);
        }
      } catch (err) {
        log.warn(`抽取失败：${err.message}`);
      }
    });
  } catch (err) {
    log.warn(`没能监听会话事件，记忆不会自动增长：${err.message}`);
  }

  try {
    const prompt = ctx.systemPrompt;
    if (!prompt || typeof prompt.section !== 'function') {
      log.warn('没有 systemPrompt 服务，人设注入不可用');
      return;
    }
    sectionDispose = prompt.section({
      name: 'fademem:roleplay',
      order: cfg.order,
      // 每次装配重新求值：记忆的衰减、复习带来的强化，都发生在这一瞬间。
      text: () => {
        try {
          return build(ctx, store, cfg, latest, lastSessionId);
        } catch (err) {
          log.warn(`拼装失败：${err.message}`);
          return '';
        }
      },
      interpolate: false,
    });
    log.info(`已接管角色设定：${cfg.persona.name}，记忆库 ${cfg.memoryFile}`);
  } catch (err) {
    log.error(`注入人设失败：${err.message}`);
  }

  if (typeof ctx.effect === 'function' && sectionDispose) {
    ctx.effect(() => () => {
      try {
        sectionDispose();
      } catch {
        /* 宿主已在拆卸，忽略 */
      }
    });
  }
}

function build(ctx, store, cfg, latest, fallbackSession) {
  const persona = resolvePersona(ctx, cfg);
  const sid = currentSessionId(ctx) || fallbackSession || 'default';
  const query = latest.get(sid) || '';
  const hits = store.recall(sid, query, {
    limit: cfg.maxItems,
    alpha: cfg.alpha,
    beta: cfg.beta,
    ambient: cfg.ambientItems,
    reinforceOnRecall: cfg.reinforceOnRecall,
  });
  const block = assemble({
    persona,
    hits,
    style: cfg.style ? renderStyle(persona, cfg.extraStyleRules) : '',
    usage: cfg.style ? renderMemoryUsage() : '',
  });
  return block;
}

function resolvePersona(ctx, cfg) {
  // 优先用配置里的；其次看 DSH 自己的 persona 配置；都没有才用默认角色。
  if (cfg.persona && cfg.persona.name) return { ...DEFAULT_PERSONA, ...cfg.persona };
  try {
    const dep = ctx.config?.persona || ctx.config?.agent?.persona;
    if (dep && typeof dep === 'object') return { ...DEFAULT_PERSONA, ...dep };
  } catch {
    /* 宿主没有这个配置就忽略 */
  }
  return DEFAULT_PERSONA;
}

/** 宿主暴露的当前会话 id；不知道就返回 null，交给调用方兜底。 */
function currentSessionId(ctx) {
  try {
    const id = ctx.session?.id || ctx.scope?.session?.id;
    if (id) return String(id);
  } catch {
    /* 宿主没这个字段就忽略 */
  }
  return null;
}

function sessionIdOf(session, event) {
  const candidates = [session?.id, session?.header?.id, event?.sessionId, event?.session];
  for (const c of candidates) if (c) return String(c);
  return 'default';
}

function textOf(event) {
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || depth > 4) return '';
    if (typeof node === 'string') return node;
    if (typeof node !== 'object' || seen.has(node)) return '';
    seen.add(node);
    for (const key of ['text', 'content', 'message', 'data', 'blocks', 'parts', 'body']) {
      const value = node[key];
      if (typeof value === 'string' && value.trim()) return value;
      if (Array.isArray(value)) {
        const joined = value
          .map((v) => (typeof v === 'string' ? v : v && typeof v.text === 'string' ? v.text : ''))
          .join('')
          .trim();
        if (joined) return joined;
      }
      const nested = value && typeof value === 'object' ? walk(value, depth + 1) : '';
      if (nested) return nested;
    }
    return '';
  };
  return walk(event, 0).slice(0, 600);
}

function normalize(config = {}) {
  const persona = config.persona && typeof config.persona === 'object' ? config.persona : {};
  return {
    persona,
    memoryFile: config.memoryFile || DEFAULT_FILE,
    baseStabilityDays: numberOr(config.baseStabilityDays, 6.0),
    maxPerSession: numberOr(config.maxPerSession, 400),
    maxItems: numberOr(config.maxItems, 8),
    alpha: numberOr(config.alpha, 1.4),
    beta: numberOr(config.beta, 0.9),
    ambientItems: numberOr(config.ambientItems, 2),
    reinforceOnRecall: config.reinforceOnRecall !== false,
    style: config.style !== false,
    extraStyleRules: Array.isArray(config.extraStyleRules) ? config.extraStyleRules : [],
    extraction: { max: 6, allowGeneric: config.allowGeneric !== false },
    order: numberOr(config.order, 800),
  };
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function makeLogger(ctx) {
  let logger = null;
  try {
    logger = typeof ctx.logger === 'function' ? ctx.logger('fademem') : null;
  } catch {
    logger = null;
  }
  const emit = (level, msg) => {
    if (logger && typeof logger[level] === 'function') logger[level](msg);
    else if (level !== 'info') console.warn(`[fademem] ${msg}`);
  };
  return {
    info: (msg) => emit('info', msg),
    warn: (msg) => emit('warn', msg),
    error: (msg) => emit('error', msg),
  };
}
