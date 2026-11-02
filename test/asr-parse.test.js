'use strict';
// 响应解析。四种 fixture 照 §6.6 定的形态来；外加分段拼接的空格纪律（评审 N1）。

const test = require('node:test');
const assert = require('node:assert');
const { useTempDataDir } = require('./_helpers');
const dashscope = require('../src/main/asr/dashscope');
const asr = require('../src/main/asr');

useTempDataDir();

const wrap = (content) => ({ output: { choices: [{ message: { content } }] } });

test('fixture 正常：取 content 里的 text 并 trim', () => {
  assert.strictEqual(dashscope.parseResponse(wrap([{ text: '  今天先对口径  ' }])), '今天先对口径');
});

test('fixture choices 空 / 缺失 → kind:shape，消息带响应体前 300 字', () => {
  assert.throws(
    () => dashscope.parseResponse({ output: { choices: [] } }),
    (e) => e.kind === 'shape' && e.message.includes('choices')
  );
  assert.throws(() => dashscope.parseResponse({ output: {} }), (e) => e.kind === 'shape');
  assert.throws(() => dashscope.parseResponse({}), (e) => e.kind === 'shape');
  const big = { output: { choices: [] }, blah: 'x'.repeat(600) };
  const err = (() => {
    try {
      dashscope.parseResponse(big);
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.ok(err.message.length < 400, '响应体要截断，不能把整个 body 塞进错误消息');
});

test('fixture content 多段：中文之间不加空格（照抄 asr_shim.py:462 的 "".join）', () => {
  assert.strictEqual(dashscope.parseResponse(wrap([{ text: '今天' }, { text: '先对' }, { text: '口径' }])), '今天先对口径');
});

test('fixture content 项缺 text：当空串处理，不抛', () => {
  assert.strictEqual(dashscope.parseResponse(wrap([{ text: '前半' }, { foo: 1 }, { text: '后半' }])), '前半后半');
  assert.strictEqual(dashscope.parseResponse(wrap([])), '');
});

test('中间段为空串时，拼接结果没有连续空格、没有首尾空格', () => {
  // 单次响应内部（join('')）
  assert.strictEqual(dashscope.parseResponse(wrap([{ text: '前半' }, { text: '' }, { text: '后半' }])), '前半后半');
  // 跨分段拼接（join(' ')，先丢空段 —— 不丢的话会出现连续空格或首尾空格）
  const joined = asr.joinSegments(['前半', '', '后半']);
  assert.strictEqual(joined, '前半 后半');
  assert.ok(!/ {2}/.test(joined));
  assert.strictEqual(joined, joined.trim());
  assert.strictEqual(asr.joinSegments(['', '只有这一段', '']), '只有这一段');
  assert.strictEqual(asr.joinSegments(['', '', '']), '');
  assert.strictEqual(asr.joinSegments([' 带空白 ', '第二段']), '带空白 第二段');
});
