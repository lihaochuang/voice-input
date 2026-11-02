'use strict';
// Key 归属自动探测（设计决策.md 追加需求二·二）。
//
// 这功能存在的理由只有一条：**百炼和 OpenAI 的 Key 都是 sk- 开头**，
// 靠前缀猜必然猜错，所以只能拿 Key 去打各家的轻量端点看谁认它。
// 本文件盯的就是「不许靠前缀猜」和「失败时给得出可操作的原因」。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempDataDir } = require('./_helpers');

useTempDataDir();
const asr = require('../src/main/asr');

const { detectKey, keyShape, PROBE_TARGETS } = asr;

/** 假 fetch：按 URL 决定回什么。 */
function fakeFetch(map) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, auth: opts && opts.headers && opts.headers.Authorization });
    for (const [frag, val] of Object.entries(map)) {
      if (url.includes(frag)) {
        if (val instanceof Error) throw val;
        return { ok: val >= 200 && val < 300, status: val };
      }
    }
    return { ok: false, status: 404 };
  };
  fn.calls = calls;
  return fn;
}

const KEY = 'sk-abcdefghijklmnopqrstuvwxyz';

test('探测目标就是三家云端后端，顺序以百炼为先（它是推荐项）', () => {
  assert.deepStrictEqual(PROBE_TARGETS.map((t) => t.id), ['dashscope', 'groq', 'openai']);
  assert.strictEqual(PROBE_TARGETS[0].name, '阿里云百炼');
  for (const t of PROBE_TARGETS) assert.match(t.url, /^https:\/\//);
  // 探的是「列模型」这类轻量端点，不是真发一次识别请求
  for (const t of PROBE_TARGETS) assert.match(t.url, /\/models$/);
});

test('命中百炼：200 就认它，且不再往后打', async () => {
  const f = fakeFetch({ dashscope: 200, groq: 401, openai: 401 });
  const r = await detectKey({ key: KEY, fetchImpl: f });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.id, 'dashscope');
  assert.strictEqual(r.name, '阿里云百炼');
  assert.strictEqual(f.calls.length, 1, '命中就该停，别再拿用户的 Key 去打别家');
});

test('命中 Groq：前两家的结果都记在 attempts 里', async () => {
  const f = fakeFetch({ dashscope: 401, groq: 200, openai: 200 });
  const r = await detectKey({ key: KEY, fetchImpl: f });
  assert.strictEqual(r.id, 'groq');
  assert.deepStrictEqual(r.attempts, [{ id: 'dashscope', status: 401 }, { id: 'groq', status: 200 }]);
});

test('命中 OpenAI', async () => {
  const r = await detectKey({ key: KEY, fetchImpl: fakeFetch({ dashscope: 401, groq: 403, openai: 200 }) });
  assert.strictEqual(r.id, 'openai');
});

test('**不许靠前缀猜**：同样的 sk- 开头，谁回 200 就是谁', async () => {
  const asDash = await detectKey({ key: KEY, fetchImpl: fakeFetch({ dashscope: 200, groq: 401, openai: 401 }) });
  const asOpenai = await detectKey({ key: KEY, fetchImpl: fakeFetch({ dashscope: 401, groq: 401, openai: 200 }) });
  assert.strictEqual(asDash.id, 'dashscope');
  assert.strictEqual(asOpenai.id, 'openai');
  // 源码里不许出现按前缀分流的判断
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/asr/index.js'), 'utf8');
  const detectPart = src.slice(src.indexOf('PROBE_TARGETS'), src.indexOf('function statusOf'));
  assert.doesNotMatch(detectPart, /startsWith\(\s*['"]sk-/, '不许用前缀判断是哪一家');
  assert.doesNotMatch(detectPart, /gsk_|sk-proj/, '不许靠各家前缀特征猜');
});

test('三家都明确拒绝 → all-rejected（Key 本身不对）', async () => {
  const r = await detectKey({ key: KEY, fetchImpl: fakeFetch({ dashscope: 401, groq: 401, openai: 401 }) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'all-rejected');
  assert.strictEqual(r.attempts.length, 3);
});

test('全都连不上 → all-unreachable（和「Key 不对」是两种处境，必须分开）', async () => {
  const net = new Error('getaddrinfo ENOTFOUND');
  net.name = 'TypeError';
  const r = await detectKey({ key: KEY, fetchImpl: fakeFetch({ dashscope: net, groq: net, openai: net }) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'all-unreachable');
  assert.ok(r.attempts.every((a) => a.error));
});

test('打得通但都不是 401/403 → all-inconclusive（比如要先在控制台开通模型）', async () => {
  const r = await detectKey({ key: KEY, fetchImpl: fakeFetch({ dashscope: 400, groq: 404, openai: 500 }) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'all-inconclusive');
});

test('形状筛查：空 / 带空白 / 非 ASCII / 太短 / 太长，根本不发请求', async () => {
  assert.strictEqual(keyShape('').ok, false);
  assert.strictEqual(keyShape('   ').reason, 'empty');
  assert.strictEqual(keyShape('sk-abc def ghi jklmno').reason, 'whitespace');
  assert.strictEqual(keyShape('sk-short').reason, 'too-short');
  assert.strictEqual(keyShape(`sk-${'x'.repeat(300)}`).reason, 'too-long');
  assert.strictEqual(keyShape(KEY).ok, true);
  // 非 ASCII 必须在形状这一层拦掉：它进了 Authorization 头会让 fetch 抛
  // TypeError，于是「你粘错东西了」会被报成「连不上，检查代理」。实测踩过。
  assert.strictEqual(keyShape('sk-这是中文的假key0000000').reason, 'non-ascii');
  assert.strictEqual(keyShape('sk-emoji🙂00000000000').reason, 'non-ascii');
  // 形状不过时一次网络都不许发
  const f = fakeFetch({ dashscope: 200 });
  const r = await detectKey({ key: 'sk-short', fetchImpl: f });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'shape-too-short');
  assert.strictEqual(f.calls.length, 0);
  const r2 = await detectKey({ key: 'sk-这是中文的假key0000000', fetchImpl: f });
  assert.strictEqual(r2.reason, 'shape-non-ascii');
  assert.strictEqual(f.calls.length, 0);
});

test('Key 原样放进 Authorization: Bearer，前后空白先剥掉', async () => {
  const f = fakeFetch({ dashscope: 200 });
  await detectKey({ key: `  ${KEY}\n`, fetchImpl: f });
  assert.strictEqual(f.calls[0].auth, `Bearer ${KEY}`);
});

test('失败时不把 Key 带进返回值（它只回「是哪家」）', async () => {
  const r = await detectKey({ key: KEY, fetchImpl: fakeFetch({ dashscope: 401, groq: 401, openai: 401 }) });
  assert.doesNotMatch(JSON.stringify(r), /abcdefghijkl/, '返回值里绝不能出现 Key');
});

test('ipc.js 的 key:detect 只回归属，且拒绝非法载荷', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/ipc.js'), 'utf8');
  const part = src.slice(src.indexOf('KEY_DETECT'), src.indexOf('KEY_SET'));
  assert.match(part, /invalid-key/);
  assert.match(part, /typeof key !== 'string'/);
  assert.match(part, /\/\\s\/\.test\(trimmed\)|\/\\s\/\.test/);
});
