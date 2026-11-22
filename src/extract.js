// 从用户的一句话里抽事实。零模型调用，纯规则，跑得比一次网络往返快得多。
// 只抽「稳定事实」，不抽情绪和临时状态——那些记下来只会变成噪音。

const RULES = [
  { kind: 'identity', importance: 0.92, re: /(?:我叫|我的名字是|叫我)\s*([^\s，。！？,.!?]{1,10})/g, fmt: (m) => `叫${m[1]}` },
  { kind: 'location', importance: 0.66, re: /我(?:住在|家在|搬家到|搬到)\s*([^\s，。！？,.!?]{2,14})/g, fmt: (m) => `住在${m[1]}` },
  {
    kind: 'pet',
    importance: 0.62,
    // 允许「三花猫」「小土狗」这种带修饰的叫法，别要求动物字打头
    re: /我(?:养了|养着|有一只|有只|养过)\s*(?:一只|只|条|个)?\s*([^\s，。！？,.!?]{0,4}(?:猫|狗|仓鼠|兔子|鹦鹉|乌龟|金鱼|蛇|蜥蜴)[^\s，。！？,.!?]{0,12})/g,
    fmt: (m) => `养着${m[1]}`,
  },
  { kind: 'preference', importance: 0.6, re: /我(?:最|很|特别|超)?(?:喜欢|爱吃|爱喝|偏好)\s*([^\s，。！？,.!?]{1,16})/g, fmt: (m) => `喜欢${m[1]}` },
  { kind: 'dislike', importance: 0.64, re: /我(?:最|很|特别|超)?(?:讨厌|不喜欢|受不了|吃不了)\s*([^\s，。！？,.!?]{1,16})/g, fmt: (m) => `讨厌${m[1]}` },
  {
    kind: 'work',
    importance: 0.72,
    re: /我(?:在|是)(?:一家|一个|一名|做)?\s*([^\s，。！？,.!?]{2,16}?)(?:工作|上班|公司|当|干)/g,
    fmt: (m) => `在做${m[1]}`,
  },
  {
    kind: 'family',
    importance: 0.74,
    re: /我(?:有|有个|有一个)\s*(?:一个|个)?\s*((?:哥哥|姐姐|弟弟|妹妹|儿子|女儿|爸爸|妈妈|老公|老婆|男朋友|女朋友)[^\s，。！？,.!?]{0,10})/g,
    fmt: (m) => `有${m[1]}`,
  },
  { kind: 'birthday', importance: 0.88, re: /我(?:的)?生日(?:是)?\s*(\d{1,2}\s*月\s*\d{1,2}\s*[日号])/g, fmt: (m) => `生日是${m[1]}` },
  { kind: 'promise', importance: 0.7, re: /我(?:答应|保证|会|明天|后天)[^\s，。！？,.!?]{0,24}/g, fmt: (m) => m[0] },
];

const SENSITIVE = /(身份证|银行卡|密码|手机号|1[3-9]\d{9})/;

export function extract(text, options = {}) {
  const max = options.max ?? 6;
  const allowGeneric = options.allowGeneric !== false;
  const out = [];
  const input = String(text || '');
  if (!input || input.length > 800) return out;
  if (SENSITIVE.test(input)) return out; // 敏感信息不记，宁可少记

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(input)) !== null) {
      const value = (m[1] || '').trim();
      if (!value && rule.kind !== 'promise') continue;
      const built = rule.fmt(m).trim();
      if (!built || built.length < 2) continue;
      if (out.some((c) => c.text === built)) continue;
      out.push({
        kind: rule.kind,
        text: built,
        subject: value || built.slice(0, 10),
        importance: rule.importance,
        salience: 0.25,
      });
      if (out.length >= max) return out;
      if (m.index === rule.re.lastIndex) rule.re.lastIndex += 1;
    }
  }

  if (!out.length && allowGeneric) {
    // 兜底：一句话里带「我」且足够具体，才当成一般事实收下，权重压低。
    const clause = input.split(/[。！？!?\n]/).map((s) => s.trim()).find((s) => s.includes('我') && s.length >= 6);
    if (clause && clause.length <= 60) {
      out.push({ kind: 'fact', text: clause, subject: clause.slice(0, 10), importance: 0.38, salience: 0.15 });
    }
  }
  return out;
}
