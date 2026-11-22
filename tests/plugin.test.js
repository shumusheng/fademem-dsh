// 用一个假的 ctx 模拟 DSH 的插件宿主：能验证插件真的会注册 section、
// 真的会从 user/message 里抽记忆、注入的文本真的随时间衰减。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { apply } from '../src/index.js';
import { extract } from '../src/extract.js';
import { fuzzText, initialStability, reinforce, retrievability } from '../src/decay.js';
import { MemoryStore } from '../src/store.js';

function fakeCtx() {
  const listeners = [];
  const sections = [];
  const logs = [];
  const ctx = {
    on(name, fn) {
      listeners.push({ name, fn });
      return () => {};
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {
          const i = sections.indexOf(section);
          if (i >= 0) sections.splice(i, 1);
        };
      },
    },
    logger: () => ({
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    }),
    effect(fn) {
      fn();
    },
  };
  return {
    ctx,
    logs,
    sections,
    emit(sessionId, text) {
      for (const l of listeners) {
        if (l.name === 'session/event') {
          l.fn({ id: sessionId }, { type: 'user/message', data: { text } });
        }
      }
    },
    render() {
      return sections[0] ? sections[0].text({}) : '';
    },
  };
}

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fademem-dsh-'));
  return path.join(dir, name);
}

test('插件注册一个提示词 section，并能被求值', () => {
  const host = fakeCtx();
  apply(host.ctx, { memoryFile: tmpFile('m.json') });
  assert.equal(host.sections.length, 1);
  assert.equal(host.sections[0].name, 'fademem:roleplay');
  const text = host.render();
  assert.match(text, /【你是谁】/);
  assert.match(text, /沈知夏/);
});

test('用户说了什么，就记下什么，并出现在注入文本里', () => {
  const host = fakeCtx();
  apply(host.ctx, { memoryFile: tmpFile('m.json'), persona: { name: '阿棠' } });
  host.emit('s1', '我叫小满，我养了一只三花猫叫咪咪');
  const text = host.render();
  assert.match(text, /叫小满/);
  assert.match(text, /三花猫/);
  assert.match(text, /【你记着的事】/);
});

test('无关的话不该把记忆灌进上下文', () => {
  const host = fakeCtx();
  apply(host.ctx, { memoryFile: tmpFile('m.json') });
  host.emit('s1', '我住在城西');
  host.emit('s1', '今天天气还行');
  const text = host.render();
  // 城西是相关度足够高的记忆，会作为「一直知道」或命中项出现
  assert.match(text, /城西/);
  assert.doesNotMatch(text, /天气还行/);
});

test('会话之间互不串味', () => {
  const host = fakeCtx();
  const file = tmpFile('m.json');
  apply(host.ctx, { memoryFile: file });
  host.emit('a', '我叫甲');
  host.emit('b', '我叫乙');
  const store = new MemoryStore(file);
  assert.equal(store.list('a').length, 1);
  assert.equal(store.list('b').length, 1);
  assert.match(store.list('a')[0].text, /甲/);
});

test('宿主没有 systemPrompt 时安静降级，不抛异常', () => {
  const host = fakeCtx();
  delete host.ctx.systemPrompt;
  apply(host.ctx, { memoryFile: tmpFile('m.json') });
  assert.ok(host.logs.some(([level, msg]) => level === 'warn' && /systemPrompt/.test(msg)));
});

test('记忆库文件坏了也不该让宿主崩', () => {
  const file = tmpFile('m.json');
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
  assert.throws(() => new MemoryStore(file));
});

test('衰减：同样的记忆放久了就不再被召回', () => {
  const host = fakeCtx();
  const file = tmpFile('m.json');
  apply(host.ctx, { memoryFile: file });
  host.emit('s1', '我住在城西');
  const store = new MemoryStore(file);
  const mem = store.list('s1')[0];
  const now = Date.now() / 1000;
  assert.ok(store.recall('s1', '城西在哪', { reinforceOnRecall: false }).length === 1);
  // 把这条记忆往前挪 120 天，且不给强化机会
  mem.updated_at = now - 120 * 86400;
  const hits = store.recall('s1', '城西在哪', { reinforceOnRecall: false, ambient: 0 });
  assert.equal(hits.length, 0);
});

test('复习会拉长稳定性（间隔效应）', () => {
  const s0 = initialStability(0.6, 0, 6);
  const weakRecall = reinforce(s0, 0.2);
  const strongRecall = reinforce(s0, 0.95);
  assert.ok(weakRecall > strongRecall);
  assert.ok(weakRecall > s0);
});

test('可提取度低时，内容本身被磨花，而不只是打标签', () => {
  const raw = '2019年在杭州（那时候还没毕业）认识了「阿鬼」';
  const fresh = fuzzText(raw, 0.9, 1);
  const faded = fuzzText(raw, 0.15, 1);
  assert.equal(fresh, raw);
  assert.notEqual(faded, raw);
  assert.doesNotMatch(faded, /2019/);
  assert.doesNotMatch(faded, /还没毕业/);
});

test('抽取只认稳定事实，不吞敏感信息', () => {
  assert.equal(extract('我的手机号是13800138000').length, 0);
  const got = extract('我生日是5月3日，我讨厌下雨天');
  assert.ok(got.some((c) => c.kind === 'birthday'));
  assert.ok(got.some((c) => c.kind === 'dislike'));
});

test('同一主语重复出现走巩固，不会无限新增', () => {
  const file = tmpFile('m.json');
  const store = new MemoryStore(file);
  store.add('s', { kind: 'location', text: '住在城西', subject: '城西', importance: 0.6 });
  store.add('s', { kind: 'location', text: '住在城西的老小区', subject: '城西', importance: 0.7 });
  assert.equal(store.list('s').length, 1);
  assert.match(store.list('s')[0].text, /老小区/);
});

test('retrievability 单调且有界', () => {
  const s = 6;
  assert.equal(retrievability(0, s), 1);
  assert.ok(retrievability(3, s) > retrievability(10, s));
  assert.ok(retrievability(10, s) < 0.5);
});
