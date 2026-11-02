'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const polish = require('../src/main/polish');

const { isPureDeletion, normalizePolishBaseUrl, polishUrl } = polish;

test('只删词 → 通过', () => {
  assert.strictEqual(isPureDeletion('嗯这个我觉得可以先灰度一下', '我觉得可以先灰度一下'), true);
});

test('只改标点 → 通过', () => {
  assert.strictEqual(isPureDeletion('那我们就这么定了对吧', '那我们就这么定了，对吧？'), true);
});

test('「再还有」被顺成「再看看」→ 判 false（编造必须拦住）', () => {
  assert.strictEqual(isPureDeletion('再还有一个问题', '再看看一个问题'), false);
});

test('加字、调语序 → 判 false', () => {
  assert.strictEqual(isPureDeletion('先做灰度', '我们先做一下灰度'), false);
  assert.strictEqual(isPureDeletion('先灰度再放量', '先放量再灰度'), false);
});

test("isPureDeletion('café 很好','cafe 很好') === false（JS 的 \\w 只有 ASCII，不许照抄 Python 的剥字符正则）", () => {
  assert.strictEqual(isPureDeletion('café 很好', 'cafe 很好'), false);
});

test('core 只剥标点与空白，带音标的字母要留着', () => {
  assert.strictEqual(polish.core('café，很好！ ok'), 'café很好ok');
});

test('normalizePolishBaseUrl：四种输入归一成同一个请求 URL', () => {
  const inputs = [
    'https://dashscope.aliyuncs.com/compatible-mode',
    'https://dashscope.aliyuncs.com/compatible-mode/',
    'https://dashscope.aliyuncs.com/compatible-mode/v1',
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  ];
  const urls = new Set(inputs.map(polishUrl));
  assert.strictEqual(urls.size, 1, [...urls].join(' | '));
  assert.strictEqual([...urls][0], 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  for (const i of inputs) assert.ok(!normalizePolishBaseUrl(i).includes('/v1'), '存的 base 不许含 /v1');
});

test('normalizePolishBaseUrl：空值回默认 base', () => {
  assert.strictEqual(normalizePolishBaseUrl(''), polish.DEFAULT_BASE_URL);
  assert.strictEqual(normalizePolishBaseUrl(undefined), polish.DEFAULT_BASE_URL);
});

const fakeFetch = (content, { ok = true, status = 200 } = {}) => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok, status, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  impl.calls = calls;
  return impl;
};

test('polish：正常删词路径返回清理结果', async () => {
  const f = fakeFetch('我觉得可以先灰度一下');
  const r = await polish.polish('嗯这个我觉得可以先灰度一下', { key: 'k', fetchImpl: f });
  assert.strictEqual(r.text, '我觉得可以先灰度一下');
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.reason, null);
  assert.strictEqual(f.calls[0].url, polishUrl(undefined));
  assert.strictEqual(JSON.parse(f.calls[0].init.body).model, 'qwen-flash');
  assert.ok(JSON.parse(f.calls[0].init.body).messages[0].content.includes('嗯这个我觉得可以先灰度一下'));
});

test('polish：不足 8 字直接跳过，不发请求', async () => {
  const f = fakeFetch('被改过的');
  const r = await polish.polish('好的收到', { key: 'k', fetchImpl: f });
  assert.strictEqual(r.text, '好的收到');
  assert.strictEqual(f.calls.length, 0);
});

test('polish：结果增长超过 1.4 倍 → 弃用，返回原文', async () => {
  const src = '先做灰度再放量看数据';
  const r = await polish.polish(src, { key: 'k', fetchImpl: fakeFetch(`${src}${src}` ) });
  assert.strictEqual(r.text, src);
  assert.match(r.reason, /变长/);
});

test('polish：改了字 → 弃用，返回原文', async () => {
  const r = await polish.polish('再还有一个问题要确认', { key: 'k', fetchImpl: fakeFetch('再看看一个问题要确认') });
  assert.strictEqual(r.text, '再还有一个问题要确认');
  assert.match(r.reason, /改了字/);
});

test('polish：空返回、HTTP 错、网络抛错、没有 key —— 一律返回原文', async () => {
  const src = '这句话足够长了可以清理';
  assert.strictEqual((await polish.polish(src, { key: 'k', fetchImpl: fakeFetch('') })).text, src);
  assert.strictEqual((await polish.polish(src, { key: 'k', fetchImpl: fakeFetch('x', { ok: false, status: 500 }) })).text, src);
  const boom = async () => {
    throw new Error('ECONNRESET');
  };
  assert.strictEqual((await polish.polish(src, { key: 'k', fetchImpl: boom })).text, src);
  assert.strictEqual((await polish.polish(src, { fetchImpl: fakeFetch('短了') })).text, src);
});

test('提示词里没有残留的 {hotwords} 模板参数', () => {
  assert.ok(!polish.POLISH_PROMPT.includes('{hotwords}'));
  assert.ok(polish.POLISH_PROMPT.includes('{text}'));
});
