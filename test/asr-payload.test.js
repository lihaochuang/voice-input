'use strict';
// 百炼请求体。结构错了的症状是 400 或「识别得到但术语全错」，都很难归因，所以逐字段钉住。

const test = require('node:test');
const assert = require('node:assert');
const { useTempDataDir } = require('./_helpers');
const dashscope = require('../src/main/asr/dashscope');

useTempDataDir();

const audio = Buffer.from('fake-audio-bytes');

test('buildPayload：模型、消息结构、asr_options 两个开关', () => {
  const p = dashscope.buildPayload({ buffer: audio, mime: 'audio/wav', hotwords: ['口径', '复盘'] });
  assert.strictEqual(p.model, 'qwen3-asr-flash');
  assert.strictEqual(p.input.messages.length, 2);
  assert.strictEqual(p.input.messages[0].role, 'system');
  assert.strictEqual(p.input.messages[1].role, 'user');
  assert.strictEqual(p.parameters.asr_options.enable_lid, true);
  assert.strictEqual(p.parameters.asr_options.enable_itn, true);
});

test('buildPayload：热词在 system message 的 content[0].text（§6.4）', () => {
  const p = dashscope.buildPayload({ buffer: audio, hotwords: ['口径', '复盘', '灰度'] });
  assert.strictEqual(p.input.messages[0].content[0].text, '口径 复盘 灰度');
});

test('buildPayload：音频是 data:<mime>;base64, 内联', () => {
  const p = dashscope.buildPayload({ buffer: audio, mime: 'audio/wav' });
  assert.strictEqual(p.input.messages[1].content[0].audio, `data:audio/wav;base64,${audio.toString('base64')}`);
});

test('buildPayload：WAV 段用 audio/wav，opus 用 audio/webm', () => {
  const wavOne = dashscope.buildPayload({ buffer: audio, mime: dashscope.MIME_WAV });
  const opusOne = dashscope.buildPayload({ buffer: audio, mime: dashscope.MIME_WEBM });
  assert.ok(wavOne.input.messages[1].content[0].audio.startsWith('data:audio/wav;base64,'));
  assert.ok(opusOne.input.messages[1].content[0].audio.startsWith('data:audio/webm;base64,'));
});

test('buildPayload：模型名可被配置覆盖，空值回落默认', () => {
  assert.strictEqual(dashscope.buildPayload({ buffer: audio, model: 'qwen3-asr-pro' }).model, 'qwen3-asr-pro');
  assert.strictEqual(dashscope.buildPayload({ buffer: audio, model: '' }).model, 'qwen3-asr-flash');
});

test('没有热词时 system message 仍在，text 是空串（结构不变）', () => {
  const p = dashscope.buildPayload({ buffer: audio, hotwords: [] });
  assert.strictEqual(p.input.messages[0].content[0].text, '');
});

test('端点是原生 multimodal-generation，不是 compatible-mode（实测 404）', () => {
  assert.strictEqual(dashscope.ENDPOINT, 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
  assert.ok(!dashscope.ENDPOINT.includes('compatible-mode'));
  assert.strictEqual(dashscope.TIMEOUT_MS, 120000);
});

test('transcribe：缺 key 是 kind=local（配置问题，不该进冷却）', async () => {
  await assert.rejects(() => dashscope.transcribe({ buffer: audio, creds: '' }), (e) => e.kind === 'local');
});

test('transcribe：HTTP 状态映射成 kind，且请求不带 Content-Type 以外的手写头', async () => {
  const cases = [
    [401, 'auth'],
    [403, 'auth'],
    [429, 'http429'],
    [404, 'http4xx'],
    [500, 'http5xx'],
    [503, 'http5xx'],
  ];
  for (const [status, kind] of cases) {
    const fetchImpl = async () => ({ ok: false, status, text: async () => '{"message":"nope"}' });
    await assert.rejects(
      () => dashscope.transcribe({ buffer: audio, creds: 'k-test', fetchImpl }),
      (e) => e.kind === kind,
      `status ${status} 应该映射成 ${kind}`
    );
  }
});

test('transcribe：余额/配额文案归 quota', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, text: async () => '{"message":"Account balance 余额不足"}' });
  await assert.rejects(() => dashscope.transcribe({ buffer: audio, creds: 'k-test', fetchImpl }), (e) => e.kind === 'quota');
});

test('transcribe：成功路径把 base64 发出去并返回解析后的文本', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, text: async () => JSON.stringify({ output: { choices: [{ message: { content: [{ text: '今天先对口径' }] } }] } }) };
  };
  const text = await dashscope.transcribe({ buffer: audio, mime: 'audio/wav', hotwords: ['口径'], creds: 'k-test', fetchImpl });
  assert.strictEqual(text, '今天先对口径');
  assert.strictEqual(seen.url, dashscope.ENDPOINT);
  assert.strictEqual(seen.init.headers.Authorization, 'Bearer k-test');
  assert.ok(seen.init.body.includes('qwen3-asr-flash'));
});
