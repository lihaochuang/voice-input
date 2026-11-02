'use strict';
// 静音拦截（§6.1）。阈值 500，判据是**去直流之后**的 peak（评审 M6 的 A 案）。
const { test } = require('node:test');
const assert = require('node:assert');
const { sine, constant, concat } = require('./_helpers');

const wav = require('../src/main/wav');

test('阈值就是 500', () => {
  assert.strictEqual(wav.SILENCE_PEAK, 500);
});

test('全零 → 拦截', () => {
  assert.strictEqual(wav.isSilent(constant(1, 0)), true);
});

test('peak=499 → 拦截，peak=501 → 不拦截', () => {
  // 用对称方波，均值为 0，去直流不影响 peak
  const square = (amp) => {
    const out = new Int16Array(16000);
    for (let i = 0; i < out.length; i += 1) out[i] = i % 2 ? amp : -amp;
    return out;
  };
  assert.strictEqual(wav.levels(square(499)).peak, 499);
  assert.strictEqual(wav.isSilent(square(499)), true);
  assert.strictEqual(wav.levels(square(501)).peak, 501);
  assert.strictEqual(wav.isSilent(square(501)), false);
});

test('正常说话量级不被拦截', () => {
  assert.strictEqual(wav.isSilent(sine(1, { amp: 8000 })), false);
});

test('恒定值 3000 的纯直流 PCM 被拦截（评审 M6：声卡故障的直流偏置听上去是绝对静音）', () => {
  const dc = constant(2, 3000);
  assert.strictEqual(wav.levels(dc).peak, 0, '去直流后 peak 必须是 0');
  assert.strictEqual(wav.isSilent(dc), true);
});

test('负向直流同样被拦截', () => {
  assert.strictEqual(wav.isSilent(constant(1, -12000)), true);
});

test('直流偏置上叠加真实说话声，不该被拦截', () => {
  const dc = 3000;
  const voiced = sine(1, { amp: 6000 }).map((v) => v + dc);
  assert.strictEqual(wav.isSilent(voiced), false);
});

test('前半静音后半说话 → 不拦截（整段取 peak）', () => {
  assert.strictEqual(wav.isSilent(concat([constant(1, 0), sine(1, { amp: 5000 })])), false);
});
