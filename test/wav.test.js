'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempDataDir, sine, constant } = require('./_helpers');

const wav = require('../src/main/wav');

test('parse 读出 16k/单声道/16bit 与 frames', () => {
  const pcm = sine(1);
  const info = wav.parse(wav.encode(pcm));
  assert.strictEqual(info.sampleRate, 16000);
  assert.strictEqual(info.channels, 1);
  assert.strictEqual(info.bits, 16);
  assert.strictEqual(info.frames, 16000);
  assert.strictEqual(info.dataOffset, 44);
});

test('不是 WAV 的入参抛错', () => {
  assert.throws(() => wav.parse(Buffer.from('hello world!!')), /不是 WAV/);
});

test('writeHeader + appendPcm + patchHeader 走通，长度字段正确', () => {
  const dir = useTempDataDir();
  const file = path.join(dir, 'rec.wav');
  const pcm = sine(0.5);
  wav.writeHeader(file);
  wav.appendPcm(file, pcm);
  const dataBytes = wav.patchHeader(file);
  assert.strictEqual(dataBytes, pcm.length * 2);
  assert.strictEqual(wav.parse(file).frames, pcm.length);
});

test('长度字段为 0 的崩溃残留，repair() 后能被 parse 读出正确 frames', () => {
  const dir = useTempDataDir();
  const file = path.join(dir, 'crashed.wav');
  const pcm = sine(2);
  wav.writeHeader(file);
  wav.appendPcm(file, pcm);
  const raw = fs.readFileSync(file);
  assert.strictEqual(raw.readUInt32LE(40), 0, '前提：长度字段还是 0');
  assert.strictEqual(wav.repair(file), true);
  assert.strictEqual(fs.readFileSync(file).readUInt32LE(40), pcm.length * 2);
  assert.strictEqual(wav.parse(file).frames, 32000);
  assert.strictEqual(wav.repair(file), false, '已经对的文件不该再被改一遍');
});

test('readPcm 原样读回样本', () => {
  const pcm = sine(0.1, { amp: 1234 });
  const back = wav.readPcm(wav.encode(pcm));
  assert.strictEqual(back.length, pcm.length);
  assert.deepStrictEqual([...back.slice(0, 20)], [...pcm.slice(0, 20)]);
});

test('已知振幅正弦的 peak 误差 ≤1', () => {
  const { peak } = wav.levels(sine(1, { amp: 12000 }));
  assert.ok(Math.abs(peak - 12000) <= 1, `peak=${peak}`);
});

test('正弦的 rms ≈ 振幅/√2', () => {
  const { rms } = wav.levels(sine(1, { amp: 10000 }));
  assert.ok(Math.abs(rms - 10000 / Math.SQRT2) < 10, `rms=${rms}`);
});

test('空 PCM 不抛错', () => {
  assert.deepStrictEqual(wav.levels(new Int16Array(0)), { peak: 0, rms: 0 });
});

test('levels 先去直流：恒定偏置算出来是 0 而不是偏置值', () => {
  assert.deepStrictEqual(wav.levels(constant(0.5, 3000)), { peak: 0, rms: 0 });
});
