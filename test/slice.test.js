'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { sine, constant, concat } = require('./_helpers');

const slice = require('../src/main/slice');
const wav = require('../src/main/wav');

const RATE = 16000;
const p = (id, maxSeconds, maxBytes = Infinity, extra = {}) => ({ id, limits: { maxSeconds, maxBytes, ...extra } });

test('常量照抄 asr_shim.py', () => {
  assert.strictEqual(slice.SPLIT_SECONDS, 170);
  assert.strictEqual(slice.SEGMENT_SECONDS, 150);
  assert.strictEqual(slice.SEARCH_WINDOW, 25);
  assert.strictEqual(slice.MAX_PARALLEL, 3);
});

test('总时长 ≤ 传入阈值 → 单段（阈值作参数传，不吃默认值）', () => {
  const pcm = sine(10);
  assert.strictEqual(slice.split(pcm, { sampleRate: RATE, thresholdSec: 170 }).length, 1);
  assert.strictEqual(slice.split(pcm, { sampleRate: RATE, thresholdSec: 10 }).length, 1);
  // 超过阈值才切，且段数由 segmentSec 决定
  assert.ok(slice.split(pcm, { sampleRate: RATE, thresholdSec: 9, segmentSec: 4 }).length > 1);
});

test('400 秒音频在第 130 秒插 1 秒静音 → 切点落在该静音段内，不是 150 秒整', () => {
  const pcm = concat([sine(130, { amp: 8000 }), constant(1, 0), sine(269, { amp: 8000 })]);
  const segs = slice.split(pcm, { sampleRate: RATE, thresholdSec: 170, segmentSec: 150 });
  const cut = segs[0].end / RATE;
  assert.ok(cut >= 130 && cut <= 131, `切点 ${cut} 秒不在 [130,131] 静音段里`);
  assert.notStrictEqual(Math.round(cut), 150);
});

test('多段：切点严格递增、首尾覆盖全程、每段能被 wav.parse() 读通', () => {
  const pcm = concat([sine(130), constant(1, 0), sine(269)]);
  const segs = slice.split(pcm, { sampleRate: RATE, thresholdSec: 170, segmentSec: 150 });
  assert.strictEqual(segs.length, 3);
  assert.strictEqual(segs[0].start, 0);
  assert.strictEqual(segs.at(-1).end, pcm.length);
  for (let i = 1; i < segs.length; i += 1) {
    assert.ok(segs[i].start > segs[i - 1].start, '切点必须严格递增');
    assert.strictEqual(segs[i].start, segs[i - 1].end, '段之间不许有空洞或重叠');
  }
  for (const s of segs) {
    const info = wav.parse(wav.encode(s.pcm));
    assert.strictEqual(info.frames, s.end - s.start);
    assert.ok(info.frames / RATE <= 150 + slice.SEARCH_WINDOW);
  }
});

test('quietestFrame 在区间里找到静音位置', () => {
  const pcm = concat([sine(5), constant(1, 0), sine(5)]);
  const at = slice.quietestFrame(pcm, 0, 11 * RATE) / RATE;
  assert.ok(at >= 5 && at <= 6, `找到的是 ${at} 秒`);
});

test('sliceThresholdSec：谁的时长上限最小听谁的', () => {
  assert.strictEqual(slice.sliceThresholdSec([p('dashscope', 180)]), 170);
  assert.strictEqual(slice.sliceThresholdSec([p('dashscope', 180), p('groq', 60)]), 60);
  assert.strictEqual(slice.sliceThresholdSec([]), 170);
});

test('segmentSecondsFor 把 maxBytes 折算进来（评审 M3）', () => {
  // 字节不设限时就是 150
  assert.strictEqual(slice.segmentSecondsFor([p('whispercpp', 7200)]), 150);
  // maxBytes=4MB（十进制口径）：base64 内联后可用裸字节 = 4e6*3/4，扣 44 字节头，
  // 除以 32000 字节/秒 → 93 秒。必须小于 150，否则每段都会超限。
  assert.ok(slice.segmentSecondsFor([p('dashscope', 180, 4_000_000)]) <= 93);
  // 同一个数按 4MiB 算是 98 秒，一样被字节约束压到 150 以下——两种口径都不许回到 150
  assert.ok(slice.segmentSecondsFor([p('dashscope', 180, 4 * 1024 * 1024)]) < 150);
  // 时长上限更小时听时长的
  assert.strictEqual(slice.segmentSecondsFor([p('groq', 40, 25 * 1024 * 1024)]), 40);
});

test('multipart 后端直接比裸字节，比 base64 内联能多装 1/3', () => {
  const inline = slice.bytesToSeconds(p('dashscope', 180, 4_000_000));
  const multipart = slice.bytesToSeconds(p('groq', 170, 4_000_000, { inlineBase64: false }));
  assert.strictEqual(inline, 93);
  assert.strictEqual(multipart, 124);
});

test('maxBytes 极小时不会返回 0 或负数', () => {
  assert.strictEqual(slice.bytesToSeconds(p('custom', 170, 100)), 1);
});
