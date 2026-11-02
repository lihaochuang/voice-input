'use strict';
// 会话状态机。时钟注入，所以上限与误触都能直接断言。
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { useTempDataDir } = require('./_helpers');
const sessionMod = require('../src/main/session');

useTempDataDir();

/** 可控时钟 + 固定 id，便于断言。 */
function mk(startAt = 0) {
  let t = startAt;
  let n = 0;
  const s = sessionMod.create({
    now: () => t,
    newId: () => { n += 1; return `s${n}`; },
  });
  return { s, advance: (ms) => { t += ms; }, at: () => t };
}

test('idle + short-toggle → 开始录音，带 tmp 两个路径', () => {
  const { s } = mk();
  const r = s.handle('short-toggle');
  assert.strictEqual(r.action, 'start');
  assert.strictEqual(r.mode, '短输入');
  assert.strictEqual(r.sessionId, 's1');
  assert.ok(r.tmp.wav.endsWith(path.join('tmp', 'rec-s1.wav')));
  assert.ok(r.tmp.webm.endsWith(path.join('tmp', 'rec-s1.webm')));
  assert.strictEqual(s.state, 'recording');
  assert.strictEqual(s.activeSessionId, 's1');
});

test('再按同一个键 → 结束，返回时长', () => {
  const { s, advance } = mk();
  s.handle('short-toggle');
  advance(2500);
  const r = s.handle('short-toggle');
  assert.strictEqual(r.action, 'stop');
  assert.strictEqual(r.reason, 'user');
  assert.strictEqual(r.durationSec, 2.5);
  assert.strictEqual(s.state, 'idle', 'finishing 是瞬态：转写异步进行，期间允许开新录音');
  assert.strictEqual(s.activeSessionId, null);
});

test('长录音键开始的会话 mode 是「长录音」', () => {
  const { s, advance } = mk();
  assert.strictEqual(s.handle('long-toggle').mode, '长录音');
  advance(1000);
  assert.strictEqual(s.handle('long-toggle').action, 'stop');
});

test('recording(short) 期间 long-toggle 被忽略', () => {
  const { s, advance } = mk();
  s.handle('short-toggle');
  advance(500);
  const r = s.handle('long-toggle');
  assert.strictEqual(r.action, 'ignored');
  assert.strictEqual(r.why, 'other-key-while-recording');
  assert.strictEqual(s.state, 'recording', '忽略不许把会话弄停');
  assert.strictEqual(s.activeSessionId, 's1');
});

test('recording(long) 期间 short-toggle 被忽略', () => {
  const { s, advance } = mk();
  s.handle('long-toggle');
  advance(500);
  assert.strictEqual(s.handle('short-toggle').action, 'ignored');
  assert.strictEqual(s.state, 'recording');
});

test('短输入到 170 秒自动收尾（注入假时钟）', () => {
  const { s, advance } = mk();
  s.handle('short-toggle');
  advance(169000);
  assert.strictEqual(s.tick(), null, '没到点不许停');
  advance(1000);
  const r = s.tick();
  assert.ok(r, '到 170 秒必须自动收尾');
  assert.strictEqual(r.action, 'stop');
  assert.strictEqual(r.reason, 'limit');
  assert.strictEqual(r.durationSec, 170);
  assert.strictEqual(s.state, 'idle');
});

test('到上限是「自动收尾并出字」，不是 discard', () => {
  const { s, advance } = mk();
  s.handle('long-toggle');
  advance(7200 * 1000);
  const r = s.tick();
  assert.strictEqual(r.action, 'stop', '到点丢弃就违反事实源');
  assert.strictEqual(r.mode, '长录音');
});

test('长录音上限是 7200 秒，远大于短输入', () => {
  const { s, advance } = mk();
  s.handle('long-toggle');
  advance(170000);
  assert.strictEqual(s.tick(), null, '长录音不该在 170 秒停');
  assert.strictEqual(sessionMod.MAX_SHORT_SEC, 170);
  assert.strictEqual(sessionMod.MAX_LONG_SEC, 7200);
});

test('0.2 秒会话 → discard，并携带要删除的两个 tmp 路径', () => {
  const { s, advance } = mk();
  s.handle('short-toggle');
  advance(200);
  const r = s.handle('short-toggle');
  assert.strictEqual(r.action, 'discard');
  assert.strictEqual(r.durationSec, 0.2);
  assert.ok(r.tmp.wav.endsWith('rec-s1.wav'));
  assert.ok(r.tmp.webm.endsWith('rec-s1.webm'));
  assert.strictEqual(s.state, 'idle');
});

test('恰好 0.3 秒不算误触', () => {
  const { s, advance } = mk();
  s.handle('short-toggle');
  advance(300);
  assert.strictEqual(s.handle('short-toggle').action, 'stop');
});

test('idle 时 tick 返回 null', () => {
  const { s } = mk();
  assert.strictEqual(s.tick(), null);
});

test('同一时刻只有一个会话（不变量 9）', () => {
  const { s, advance } = mk();
  const a = s.handle('short-toggle');
  advance(100);
  s.handle('short-toggle'); // 停掉
  advance(100);
  const b = s.handle('short-toggle');
  assert.notStrictEqual(a.sessionId, b.sessionId);
  assert.strictEqual(s.activeSessionId, b.sessionId);
});

test('forceStop：录音中才有效（suspend / 麦克风掉线 / PCM 超量）', () => {
  const { s, advance } = mk();
  assert.strictEqual(s.forceStop('suspend'), null);
  s.handle('short-toggle');
  advance(1000);
  const r = s.forceStop('suspend');
  assert.strictEqual(r.action, 'stop');
  assert.strictEqual(r.reason, 'suspend');
});

test('未知事件被忽略，不影响状态', () => {
  const { s } = mk();
  assert.strictEqual(s.handle('whatever').why, 'unknown-event');
  assert.strictEqual(s.state, 'idle');
});

test('elapsedSec 给托盘的 🔴 m:ss 用', () => {
  const { s, advance } = mk();
  assert.strictEqual(s.elapsedSec(), 0);
  s.handle('short-toggle');
  advance(12300);
  assert.strictEqual(s.elapsedSec(), 12.3);
});
