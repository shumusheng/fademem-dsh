// 遗忘曲线：R = exp(-t/S)，并把「越模糊时想起，记得越牢」写进稳定性更新。
// 与 Python 版 fademem/decay.py 同一套公式，参数一致，方便两边对照。

export const DAY = 86400;

export function initialStability(importance = 0.5, salience = 0.0, baseDays = 6.0) {
  // 重要度与情绪唤醒共同决定第一段半衰期。
  const imp = clamp(importance, 0, 1);
  const sal = clamp(salience, 0, 1);
  return Math.max(0.4, baseDays * (0.45 + 1.1 * imp) * (1 + 0.9 * sal));
}

export function retrievability(dtDays, stability) {
  if (!(stability > 0)) return 0;
  if (dtDays <= 0) return 1;
  return Math.exp(-dtDays / stability);
}

export function reinforce(stability, r, k = 1.5) {
  // 间隔效应：R 越低时复习，增益越大；R 已经很高时几乎不涨（那是「已经记得」）。
  const gain = 1 + k * Math.pow(1 - clamp(r, 0, 1), 1.5);
  return stability * gain;
}

export function halfLife(stability) {
  return stability * Math.LN2;
}

export function decayState(r) {
  if (r >= 0.85) return '清晰';
  if (r >= 0.6) return '清楚';
  if (r >= 0.35) return '模糊';
  if (r >= 0.15) return '只剩印象';
  return '忘了';
}

export function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

// 低可提取度时把细节「磨花」：数字变模糊、括号补充消失、长句截断。
// 只打标签没用——模型看到标签照样能把细节编得头头是道，内容残缺才编不出来。
const PAREN = /[（(][^）)]{1,60}[）)]/g;
const NUM = /\d+/g;
const QUOTED = /[“"「『][^”"」』]{1,40}[”"」』]/g;
const VAGUE_COUNT = ['几个', '好些', '不少', '好几'];

export function fuzzText(text, r, seed = 0) {
  if (!text) return '';
  if (r >= 0.55) return text;
  const loss = Math.min(1, (0.55 - Math.max(0, r)) / 0.55);
  const rand = mulberry32(hashSeed(`${seed}|${r.toFixed(3)}`));

  let out = text.replace(PAREN, '');
  out = out.replace(NUM, (m) => (loss > 0.7 || rand() < loss * 0.85 ? pick(VAGUE_COUNT, rand) : m));
  out = out.replace(QUOTED, (m) => (rand() < loss ? '说了句什么来着' : m));
  out = out.replace(/[，,、]\s*[，,、]/g, '，').replace(/\s{2,}/g, ' ').trim();

  if (loss > 0.62 && out.length > 16) {
    const cut = Math.max(6, Math.floor(out.length * (1 - loss * 0.55)));
    const head = out.slice(0, cut).replace(/[，,、；;。\s]+$/, '');
    return head + pick(['……', '，具体的想不起来了', '，剩下的记不清了'], rand);
  }
  return out;
}

export function pick(list, rand) {
  return list[Math.floor(rand() * list.length) % list.length];
}

export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
