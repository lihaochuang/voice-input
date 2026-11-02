'use strict';
// WAV 读写 + 电平计算。
//
// 录音时 PCM 是边录边追加写的，长度字段只能最后回填（崩溃残留就靠 repair() 修）。
//
// levels() 的硬约束（评审 M6）：peak / rms 必须在**去直流之后**算。
// 阈值仍是 500，正常音频行为不变；但声卡故障给出的「恒定偏置」
// （整段都是同一个非零值，听上去是绝对静音）原来算出 peak=3000 会被当成有声音，
// 去直流后 peak=0，能被静音拦截挡住。

const fs = require('fs');

const HEADER_BYTES = 44;
const SILENCE_PEAK = 500; // 16bit 满量程 32767，正常说话峰值几千以上；低于此视为静音

/** 44 字节标准 PCM 头。dataBytes 不确定时传 0，录完用 patchHeader 回填。 */
function buildHeader(dataBytes = 0, { sampleRate = 16000, channels = 1, bits = 16 } = {}) {
  const byteRate = (sampleRate * channels * bits) / 8;
  const h = Buffer.alloc(HEADER_BYTES);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE((channels * bits) / 8, 32); // block align
  h.writeUInt16LE(bits, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** 建文件并写入长度字段为 0 的头。 */
function writeHeader(file, opts = {}) {
  fs.writeFileSync(file, buildHeader(0, opts));
  return file;
}

/** 追加 PCM。接受 Buffer 或 Int16Array。 */
function appendPcm(file, pcm) {
  const buf = Buffer.isBuffer(pcm)
    ? pcm
    : Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  fs.appendFileSync(file, buf);
  return buf.length;
}

/** 用实际文件大小回填两个长度字段。 */
function patchHeader(file) {
  const size = fs.statSync(file).size;
  if (size < HEADER_BYTES) throw new Error(`WAV 文件比头还短：${size} 字节`);
  const dataBytes = size - HEADER_BYTES;
  const fd = fs.openSync(file, 'r+');
  try {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(36 + dataBytes, 0);
    fs.writeSync(fd, b, 0, 4, 4);
    b.writeUInt32LE(dataBytes, 0);
    fs.writeSync(fd, b, 0, 4, 40);
  } finally {
    fs.closeSync(fd);
  }
  return dataBytes;
}

/**
 * 修补崩溃残留：长度字段为 0 或与实际大小不符时按实际大小回填。
 * @returns {boolean} 是否动过文件
 */
function repair(file) {
  const size = fs.statSync(file).size;
  if (size < HEADER_BYTES) throw new Error(`WAV 文件比头还短：${size} 字节`);
  const head = Buffer.alloc(HEADER_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, HEADER_BYTES, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.readUInt32LE(40) === size - HEADER_BYTES) return false;
  patchHeader(file);
  return true;
}

/** 解析头。入参是 Buffer 或文件路径。 */
function parse(input) {
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV：RIFF/WAVE 标记对不上');
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      // 长度字段可能是 0（录音中崩溃）或超出实际大小，一律按实际剩余字节算
      const avail = buf.length - body;
      data = { offset: body, bytes: size > 0 && size <= avail ? size : avail };
      break;
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('不是 WAV：缺 fmt 或 data 块');
  const frameBytes = (fmt.channels * fmt.bits) / 8;
  return { ...fmt, frames: Math.floor(data.bytes / frameBytes), dataOffset: data.offset, dataBytes: data.bytes };
}

/** 读出整段 PCM 为 Int16Array（单声道 16bit）。 */
function readPcm(input) {
  const buf = Buffer.isBuffer(input) ? input : fs.readFileSync(input);
  const info = parse(buf);
  if (info.bits !== 16) throw new Error(`只支持 16bit，实际 ${info.bits}`);
  const out = new Int16Array(info.frames * info.channels);
  for (let i = 0; i < out.length; i += 1) out[i] = buf.readInt16LE(info.dataOffset + i * 2);
  return out;
}

/** 头 + PCM 拼成完整 WAV Buffer（测试与切片落盘都用它）。 */
function encode(int16, opts = {}) {
  const body = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
  return Buffer.concat([buildHeader(body.length, opts), body]);
}

/** peak / rms，**先去直流再算**（评审 M6）。 */
function levels(int16) {
  const n = int16.length;
  if (!n) return { peak: 0, rms: 0 };
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += int16[i];
  const mean = sum / n;
  let peak = 0;
  let sq = 0;
  for (let i = 0; i < n; i += 1) {
    const v = int16[i] - mean;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sq += v * v;
  }
  return { peak: Math.round(peak), rms: Math.round(Math.sqrt(sq / n)) };
}

/** 静音拦截判据。pipeline 用它决定「不发请求、不写历史」。 */
const isSilent = (int16) => levels(int16).peak < SILENCE_PEAK;

module.exports = {
  HEADER_BYTES,
  SILENCE_PEAK,
  buildHeader,
  writeHeader,
  appendPcm,
  patchHeader,
  repair,
  parse,
  readPcm,
  encode,
  levels,
  isSilent,
};
