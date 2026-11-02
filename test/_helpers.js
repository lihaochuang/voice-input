'use strict';
// 测试公用脚手架。文件名带 _ 前缀，不被 "test/**/*.test.js" 匹配到。
//
// 两条纪律：
// ① 一律用 VI_DATA_DIR 指向 mkdtempSync 的临时目录，绝不碰真实 userData、不碰 safeStorage、不碰网络。
// ② 音频全部代码合成，不落 fixture（*.wav 在 .gitignore 里，而且二进制看不出意图）。

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 建临时数据目录并设 VI_DATA_DIR，返回目录路径。 */
function useTempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-test-'));
  process.env.VI_DATA_DIR = dir;
  process.env.VI_DOCUMENTS_DIR = path.join(dir, 'Documents');
  return dir;
}

/** 正弦波 PCM（16bit 单声道）。 */
function sine(seconds, { amp = 8000, freq = 440, sampleRate = 16000 } = {}) {
  const n = Math.round(seconds * sampleRate);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / sampleRate));
  return out;
}

/** 恒定值 PCM。value=0 是纯静音，非零是「直流偏置」（声卡故障的典型形态）。 */
function constant(seconds, value = 0, sampleRate = 16000) {
  return new Int16Array(Math.round(seconds * sampleRate)).fill(value);
}

/** 把若干段 PCM 接起来。 */
function concat(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Int16Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

module.exports = { useTempDataDir, sine, constant, concat };
