'use strict';
// 音频采集自愈的三级升级链。纯状态机，裸 Node 可跑（模块不 require electron/fs）。
const test = require('node:test');
const assert = require('node:assert');
const audiohealth = require('../src/main/audiohealth');

/** 跑一串 [chunkCount, durationSec]，收集每次的 action。 */
function actions(h, seq) {
  return seq.map(([chunkCount, durationSec]) => h.onSession({ chunkCount, durationSec }).action);
}

test('正常会话（收到块）一直是 none，计数不涨', () => {
  const h = audiohealth.create({});
  assert.deepStrictEqual(actions(h, [[11, 3], [14, 4], [27, 8]]), ['none', 'none', 'none']);
  assert.strictEqual(h.onSession({ chunkCount: 11, durationSec: 3 }).consecutiveZero, 0);
});

test('单次零块 → rebuild（renderer 内重建音频图）', () => {
  const h = audiohealth.create({});
  const r = h.onSession({ chunkCount: 0, durationSec: 3 });
  assert.strictEqual(r.action, 'rebuild');
  assert.strictEqual(r.consecutiveZero, 1);
});

test('连续两次零块 → rebuild 然后 reload（销毁重建隐藏窗）', () => {
  const h = audiohealth.create({});
  assert.deepStrictEqual(actions(h, [[0, 3], [0, 3]]), ['rebuild', 'reload']);
});

test('连续四次零块 → rebuild / reload / alert / alert（第三次起不再静默重试）', () => {
  const h = audiohealth.create({});
  assert.deepStrictEqual(
    actions(h, [[0, 3], [0, 3], [0, 3], [0, 3]]),
    ['rebuild', 'reload', 'alert', 'alert'],
  );
  assert.strictEqual(h.onSession({ chunkCount: 0, durationSec: 3 }).consecutiveZero, 5);
});

test('中间插一次成功 → 计数归零，下一次零块重新从 rebuild 开始', () => {
  const h = audiohealth.create({});
  assert.deepStrictEqual(
    actions(h, [[0, 3], [0, 3], [0, 3], [5, 3], [0, 3]]),
    ['rebuild', 'reload', 'alert', 'none', 'rebuild'],
  );
});

test('太短的零块会话不计数（0.5s 判不了），随后 3s 的零块仍是 rebuild', () => {
  const h = audiohealth.create({});
  const short = h.onSession({ chunkCount: 0, durationSec: 0.5 });
  assert.strictEqual(short.action, 'none');
  assert.strictEqual(short.consecutiveZero, 0);
  assert.strictEqual(h.onSession({ chunkCount: 0, durationSec: 3 }).action, 'rebuild');
});

test('太短的会话既不归零也不累加（夹在两次零块中间不该打断升级链）', () => {
  const h = audiohealth.create({});
  assert.deepStrictEqual(
    actions(h, [[0, 3], [0, 0.4], [0, 3]]),
    ['rebuild', 'none', 'reload'],
  );
});

test('deviceError 标记被消费一次就清掉', () => {
  const h = audiohealth.create({});
  assert.strictEqual(h.pendingRebuild(), false);
  h.deviceError();
  assert.strictEqual(h.pendingRebuild(), true);
  assert.strictEqual(h.pendingRebuild(), false);
});

test('reset 同时清零块计数与 deviceError 标记（换了渲染进程，旧账作废）', () => {
  const h = audiohealth.create({});
  h.onSession({ chunkCount: 0, durationSec: 3 });
  h.deviceError();
  h.reset();
  assert.strictEqual(h.pendingRebuild(), false);
  assert.strictEqual(h.onSession({ chunkCount: 0, durationSec: 3 }).action, 'rebuild');
});

test('minSec 可调，且 create() 不传参数也能用', () => {
  const h = audiohealth.create({ minSec: 5 });
  assert.strictEqual(h.onSession({ chunkCount: 0, durationSec: 4 }).action, 'none');
  assert.strictEqual(h.onSession({ chunkCount: 0, durationSec: 6 }).action, 'rebuild');
  assert.strictEqual(audiohealth.create().onSession({ chunkCount: 0, durationSec: 3 }).action, 'rebuild');
});

test('缺字段或非数字不抛，按 0 处理（renderer 侧载荷不可信）', () => {
  const h = audiohealth.create({});
  assert.strictEqual(h.onSession({}).action, 'none');
  assert.strictEqual(h.onSession().action, 'none');
  assert.strictEqual(h.onSession({ chunkCount: NaN, durationSec: 3 }).action, 'rebuild');
});
