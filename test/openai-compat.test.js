'use strict';
// OpenAI 兼容后端。自定义端点最常见的两类事故：Base URL 填得五花八门、手写 Content-Type 砸掉 boundary。

const test = require('node:test');
const assert = require('node:assert');
const { useTempDataDir } = require('./_helpers');
const oc = require('../src/main/asr/openai-compat');

useTempDataDir();
const audio = Buffer.from('fake-audio-bytes');

test('normalizeBaseUrl：四种写法归一成同一个结果', () => {
  const want = 'https://x.com/v1';
  for (const raw of ['https://x.com', 'https://x.com/', 'https://x.com/v1', 'https://x.com/v1/']) {
    assert.strictEqual(oc.normalizeBaseUrl(raw), want, `${raw} 应该归一成 ${want}`);
  }
  // 用户把整条路径都填进来也认
  assert.strictEqual(oc.normalizeBaseUrl('https://x.com/v1/audio/transcriptions'), want);
  assert.strictEqual(oc.normalizeBaseUrl('  https://x.com/v1  '), want);
});

test('协议：本地回环允许 http，其他域名的 http 拒绝', () => {
  assert.strictEqual(oc.isUrlAllowed('http://127.0.0.1:8080'), true);
  assert.strictEqual(oc.isUrlAllowed('http://localhost:8080/v1'), true);
  assert.strictEqual(oc.isUrlAllowed('http://evil.com'), false);
  assert.strictEqual(oc.normalizeBaseUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/v1');
  assert.throws(() => oc.normalizeBaseUrl('http://evil.com'), (e) => e.kind === 'local');
  assert.throws(() => oc.normalizeBaseUrl(''), (e) => e.kind === 'local');
  assert.throws(() => oc.normalizeBaseUrl('不是URL'), (e) => e.kind === 'local');
});

test('parseResponse：正常取 text，{error:{message}} 抛 shape 且带上端点给的原因', () => {
  assert.strictEqual(oc.parseResponse({ text: '  今天先对口径 ' }), '今天先对口径');
  assert.throws(
    () => oc.parseResponse({ error: { message: 'model_not_found: whisper-x' } }),
    (e) => e.kind === 'shape' && e.message.includes('model_not_found') && e.endpointMessage === 'model_not_found: whisper-x'
  );
  assert.throws(() => oc.parseResponse({}), (e) => e.kind === 'shape');
  assert.throws(() => oc.parseResponse({ text: 42 }), (e) => e.kind === 'shape');
});

test('buildForm：五个字段齐全，文件名带扩展名，没有任何 message 字段', () => {
  const form = oc.buildForm({ buffer: audio, mime: 'audio/wav', hotwords: ['口径', '复盘'], model: 'whisper-1' });
  assert.strictEqual(form.get('model'), 'whisper-1');
  assert.strictEqual(form.get('prompt'), '口径 复盘');
  assert.strictEqual(form.get('response_format'), 'json');
  assert.strictEqual(form.get('language'), 'zh');
  assert.strictEqual(form.get('file').name, 'audio.wav');
  assert.strictEqual(form.get('messages'), null);
  assert.ok(![...form.keys()].some((k) => /message/i.test(k)), '热词只能在 prompt 里，不许出现任何 message 字段');
  const webm = oc.buildForm({ buffer: audio, mime: 'audio/webm', model: 'm' });
  assert.strictEqual(webm.get('file').name, 'audio.webm');
});

test('post：不手写 Content-Type（否则覆盖 boundary 导致 400），URL 带 /audio/transcriptions', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, text: async () => JSON.stringify({ text: '嗯' }) };
  };
  const text = await oc.post({ baseUrl: 'https://x.com/v1', model: 'whisper-1', buffer: audio, key: 'k-test', fetchImpl });
  assert.strictEqual(text, '嗯');
  assert.strictEqual(seen.url, 'https://x.com/v1/audio/transcriptions');
  assert.ok(seen.init.body instanceof FormData);
  assert.ok(!Object.keys(seen.init.headers).some((h) => /content-type/i.test(h)));
  assert.strictEqual(seen.init.headers.Authorization, 'Bearer k-test');
});

test('post：HTTP 状态映射成 kind', async () => {
  for (const [status, kind] of [[429, 'http429'], [401, 'auth'], [400, 'http4xx'], [502, 'http5xx']]) {
    const fetchImpl = async () => ({ ok: false, status, text: async () => 'boom' });
    await assert.rejects(() => oc.post({ baseUrl: 'https://x.com/v1', buffer: audio, key: 'k', fetchImpl }), (e) => e.kind === kind);
  }
});

test('三个默认值：Groq / OpenAI 有默认 base 与模型，custom 两项都要用户填', () => {
  assert.strictEqual(oc.DEFAULTS.groq.baseUrl, 'https://api.groq.com/openai/v1');
  assert.strictEqual(oc.DEFAULTS.groq.model, 'whisper-large-v3-turbo');
  assert.strictEqual(oc.DEFAULTS.openai.baseUrl, 'https://api.openai.com/v1');
  assert.strictEqual(oc.DEFAULTS.openai.model, 'whisper-1');
  assert.strictEqual(oc.DEFAULTS.custom.baseUrl, '');
});

test('isConfigured：有 key 才算配好；custom 还要 baseUrl 合规', () => {
  const groq = oc.createProvider('groq');
  assert.strictEqual(groq.isConfigured({ id: 'groq' }, ''), false);
  assert.strictEqual(groq.isConfigured({ id: 'groq' }, 'k-test'), true);
  const custom = oc.createProvider('custom');
  assert.strictEqual(custom.isConfigured({ id: 'custom', baseUrl: '' }, 'k-test'), false);
  assert.strictEqual(custom.isConfigured({ id: 'custom', baseUrl: 'http://evil.com' }, 'k-test'), false);
  assert.strictEqual(custom.isConfigured({ id: 'custom', baseUrl: 'https://my.endpoint/v1' }, 'k-test'), true);
});
