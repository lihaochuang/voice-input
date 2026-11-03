'use strict';
// 静音拦截（§6.1）。判据是两条：**去直流之后**的整段 peak（评审 M6 的 A 案）
// 加上最大 200ms 窗 RMS。单看 peak 的旧版把作者正常说话（peak=333）删掉过，
// 单把 peak 降到 200 又拦不住这台机器的底噪（窗 peak 就有 202~250），
// 所以两条判据缺一不可，数值依据见 src/main/wav.js 文件头。
const { test } = require('node:test');
const assert = require('node:assert');
const { sine, constant, concat } = require('./_helpers');

const wav = require('../src/main/wav');

/** 对称方波，均值为 0，去直流不影响 peak。 */
const square = (amp, n = 16000) => {
  const out = new Int16Array(n);
  for (let i = 0; i < out.length; i += 1) out[i] = i % 2 ? amp : -amp;
  return out;
};

/**
 * 合成底噪：低幅连续噪声 + 稀疏尖峰。
 * 照真机实测的形态做——整段 peak 爬到 240（超过 SILENCE_PEAK），
 * 但窗 RMS 只有 70 上下（实测底噪 60~75），只有窗判据能拦住它。
 */
function roomNoise(seconds) {
  const out = sine(seconds, { amp: 100, freq: 60 });
  for (let i = 0; i < out.length; i += 1000) out[i] = i % 2000 ? 240 : -240;
  return out;
}

test('阈值：peak 200、窗 RMS 120、说话级放行 1200', () => {
  assert.strictEqual(wav.SILENCE_PEAK, 200);
  assert.strictEqual(wav.SILENCE_WIN_RMS, 120);
  assert.strictEqual(wav.SPEECH_PEAK_PASS, 1200);
});

test('全零 → 拦截', () => {
  assert.strictEqual(wav.isSilent(constant(1, 0)), true);
});

test('peak=199 → 拦截，peak=201 且窗能量足够 → 不拦截', () => {
  assert.strictEqual(wav.levels(square(199)).peak, 199);
  assert.strictEqual(wav.isSilent(square(199)), true);
  assert.strictEqual(wav.levels(square(201)).peak, 201);
  // 方波 amp=201 的窗 rms ≈ 201 > 120，判为有声
  assert.ok(wav.maxWindowRms(square(201)) > wav.SILENCE_WIN_RMS);
  assert.strictEqual(wav.isSilent(square(201)), false);
});

test('合成底噪（peak 240、窗 RMS ≈70）→ 拦截', () => {
  const noise = roomNoise(3);
  assert.ok(wav.levels(noise).peak >= wav.SILENCE_PEAK, '底噪的整段 peak 本来就超过 200，单看 peak 拦不住');
  assert.ok(wav.maxWindowRms(noise) < wav.SILENCE_WIN_RMS, `窗 RMS 实测 ${wav.maxWindowRms(noise)}`);
  assert.strictEqual(wav.isSilent(noise), true);
});

test('轻声说话量级（窗 RMS 远超 120）→ 不拦截', () => {
  const quiet = sine(3, { amp: 2500 });
  assert.ok(wav.maxWindowRms(quiet) > wav.SILENCE_WIN_RMS);
  assert.strictEqual(wav.isSilent(quiet), false);
});

test('高 peak 低窗能量的单次脉冲 → 不拦截（SPEECH_PEAK_PASS 放行分支）', () => {
  const spike = new Int16Array(1);
  spike[0] = 1500;
  const pulse = concat([constant(2, 0), spike, constant(2, 0)]);
  assert.ok(wav.levels(pulse).peak >= wav.SPEECH_PEAK_PASS);
  assert.ok(wav.maxWindowRms(pulse) < wav.SILENCE_WIN_RMS, '窗能量低，只能靠 peak 放行');
  assert.strictEqual(wav.isSilent(pulse), false, '宁可多花一次请求，也不丢用户的话');
});

test('maxWindowRms 对纯直流返回 0（每窗各自去直流）', () => {
  assert.strictEqual(wav.maxWindowRms(constant(2, 3000)), 0);
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
