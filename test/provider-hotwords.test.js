'use strict';
// 热词注入位置：三个后端三种写法（§6.4）。
//
// 为什么每个 provider 都要单独一条断言：抄错注入方式的症状是「识别能跑但术语全错」，
// 既不报错也不掉成功率，极难归因。这几条断言是唯一能挡住它的手段。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { useTempDataDir } = require('./_helpers');
const logger = require('../src/main/logger');
const dashscope = require('../src/main/asr/dashscope');
const oc = require('../src/main/asr/openai-compat');
const whispercpp = require('../src/main/asr/whispercpp');

useTempDataDir();
const audio = Buffer.from('fake-audio-bytes');
const WORDS = ['口径', '复盘', '灰度'];

test('dashscope：热词在 input.messages[0].content[0].text', () => {
  const p = dashscope.buildPayload({ buffer: audio, mime: 'audio/wav', hotwords: WORDS });
  assert.strictEqual(p.input.messages[0].role, 'system');
  assert.strictEqual(p.input.messages[0].content[0].text, '口径 复盘 灰度');
  // 不许同时塞进 user message
  assert.ok(!JSON.stringify(p.input.messages[1]).includes('口径'));
});

test('openai 兼容：热词在 FormData 的 prompt，不在任何 message 字段里', () => {
  const form = oc.buildForm({ buffer: audio, mime: 'audio/wav', hotwords: WORDS, model: 'whisper-1' });
  assert.strictEqual(form.get('prompt'), '口径 复盘 灰度');
  const keys = [...form.keys()];
  assert.ok(!keys.some((k) => /message/i.test(k)), `不该有 message 字段，实际字段：${keys.join(',')}`);
  assert.deepStrictEqual(keys.sort(), ['file', 'language', 'model', 'prompt', 'response_format']);
});

test('whispercpp exec：热词紧跟在 --prompt 之后，参数是数组，-l zh 在', () => {
  const args = whispercpp.buildArgs({ execPath: '/opt/whisper/main', modelPath: '/模型/ggml.bin', wavPath: '/tmp/带空格 的.wav', hotwords: WORDS });
  assert.ok(Array.isArray(args), '必须是数组给 spawn，不能拼 shell 字符串');
  const at = args.indexOf('--prompt');
  assert.ok(at >= 0);
  assert.strictEqual(args[at + 1], '口径 复盘 灰度');
  assert.strictEqual(args[args.indexOf('-l') + 1], 'zh');
  assert.strictEqual(args[args.indexOf('-m') + 1], '/模型/ggml.bin');
  assert.strictEqual(args[args.indexOf('-f') + 1], '/tmp/带空格 的.wav');
  assert.ok(args.includes('--no-timestamps') && args.includes('--output-txt'));
});

test('whispercpp server：热词走 openai-compat 的 prompt（同一份实现）', async () => {
  let form = null;
  const fetchImpl = async (url, init) => {
    form = init.body;
    return { ok: true, status: 200, text: async () => JSON.stringify({ text: '本地跑的' }) };
  };
  const text = await whispercpp.transcribe({
    buffer: audio,
    mime: 'audio/wav',
    hotwords: WORDS,
    cfg: { mode: 'server', serverUrl: 'http://127.0.0.1:8080' },
    fetchImpl,
  });
  assert.strictEqual(text, '本地跑的');
  assert.strictEqual(form.get('prompt'), '口径 复盘 灰度');
});

test('openai 侧超长热词表被截断，并记一条 warn', () => {
  const long = Array.from({ length: 300 }, (_, i) => `词${i}`); // 远超 PROMPT_MAX_CHARS
  const { prompt, truncated } = oc.truncatePrompt(long);
  assert.strictEqual(truncated, true);
  assert.ok(prompt.length <= oc.PROMPT_MAX_CHARS);
  assert.ok(prompt.startsWith('词0 词1'), '截断要留前面那一截（whisper 只有开头生效）');
  assert.ok(!prompt.endsWith(' '), '截断点不留尾随空格');

  const form = oc.buildForm({ buffer: audio, hotwords: long, model: 'whisper-1' });
  assert.ok(form.get('prompt').length <= oc.PROMPT_MAX_CHARS);
  const log = fs.readFileSync(logger.logFile(), 'utf8');
  assert.ok(/WARN.*已截断/.test(log), '截断必须留痕，否则用户以为整张表都生效了');
});

test('短热词表不截断、不记 warn', () => {
  const { prompt, truncated } = oc.truncatePrompt(WORDS);
  assert.strictEqual(truncated, false);
  assert.strictEqual(prompt, '口径 复盘 灰度');
});

test('whispercpp parseOutput：优先读 txt 产物，读不到退回 stdout 并剥时间戳', () => {
  const dir = process.env.VI_DATA_DIR;
  const txt = `${dir}/out.txt`;
  fs.writeFileSync(txt, '  txt 里的内容  ');
  assert.strictEqual(whispercpp.parseOutput('stdout 的内容', txt), 'txt 里的内容');
  assert.strictEqual(whispercpp.parseOutput('stdout 的内容', `${dir}/不存在.txt`), 'stdout 的内容');
  const stamped = '[00:00:00.000 --> 00:00:02.000]  先对口径\n[00:00:02.000 --> 00:00:04.000]  再看留存\n';
  assert.strictEqual(whispercpp.parseOutput(stamped, null), '先对口径再看留存');
});

test('whispercpp isConfigured：没配可执行文件/模型 → false（不是错误）', () => {
  assert.strictEqual(whispercpp.isConfigured({ mode: 'exec', execPath: '', modelPath: '' }), false);
  assert.strictEqual(whispercpp.isConfigured({ mode: 'exec', execPath: '/不存在/main', modelPath: '/不存在/m.bin' }), false);
  assert.strictEqual(whispercpp.isConfigured({ mode: 'server', serverUrl: 'http://127.0.0.1:8080' }), true);
  assert.strictEqual(whispercpp.isConfigured({ mode: 'server', serverUrl: 'http://evil.com' }), false);
  assert.strictEqual(whispercpp.limits.needsWav, true);
  assert.strictEqual(whispercpp.TIMEOUT_MS, 600000);
});
