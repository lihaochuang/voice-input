'use strict';
// 录音会话状态机（design.md §5.2、不变量 9）。
//
//   idle ──短键──> recording(短输入, 上限 170s) ──短键/到上限──> finishing ──> idle
//   idle ──长键──> recording(长录音, 上限 7200s) ──长键/到上限──> finishing ──> idle
//   recording(短) ──长键──> 忽略（托盘闪一下），反之亦然
//
// 三条容易写错的：
// ① 只认 hotkeys 的 short-toggle / long-toggle，**不关心是 single 还是 combo**，
//    也不重复做防误触判断——两处都判会出现「钩子放过了、状态机又拦掉」的难查问题。
// ② 到上限是**自动收尾并出字**，不是丢弃。
// ③ <0.3 秒是误触：丢弃不发请求，但 tmp 的 wav/webm 是**落盘后立即删除**
//    （PCM 从第一块就在写盘，不存在「不落盘」，评审 M6）。
// 时钟注入（now）便于单测。
const path = require('path');
const logger = require('./logger');
const paths = require('./paths');

const MOD = 'session';

const MAX_SHORT_SEC = 170; // = SPLIT_SECONDS，所以短输入永远单请求、永远走 opus
const MAX_LONG_SEC = 7200; // 纯粹防用户忘记关
const MIN_DURATION_SEC = 0.3; // 对齐 main.swift 的 MIN_DURATION

const MODE_OF = { short: '短输入', long: '长录音' };

/** 会话的两个 tmp 文件路径。 */
function tmpPathsOf(sessionId) {
  const dir = paths.tmpDir();
  return {
    wav: path.join(dir, `rec-${sessionId}.wav`),
    webm: path.join(dir, `rec-${sessionId}.webm`),
  };
}

let seq = 0;
const defaultNewId = () => {
  seq += 1;
  return `${Date.now().toString(36)}${seq.toString(36)}`;
};

/**
 * 工厂。返回一个只做状态判定的对象——启停录音窗、跑 pipeline 都由调用方做。
 *
 * handle(event) 返回：
 *   {action:'start',   sessionId, mode, tmp}
 *   {action:'stop',    sessionId, mode, durationSec, tmp, reason:'user'|'limit'}
 *   {action:'discard', sessionId, mode, durationSec, tmp}   ← <0.3 秒，要删两个文件
 *   {action:'ignored', why}
 */
function create({ now = Date.now, newId = defaultNewId, maxShortSec = MAX_SHORT_SEC, maxLongSec = MAX_LONG_SEC, minDurationSec = MIN_DURATION_SEC } = {}) {
  let state = 'idle';
  let cur = null; // {sessionId, which, mode, startedAt, limitSec}

  const limitOf = (which) => (which === 'short' ? maxShortSec : maxLongSec);

  function startOne(which) {
    const sessionId = newId();
    cur = {
      sessionId,
      which,
      mode: MODE_OF[which],
      startedAt: now(),
      limitSec: limitOf(which),
    };
    state = 'recording';
    logger.info(MOD, `开始录音 ${sessionId}（${cur.mode}，上限 ${cur.limitSec}s）`);
    return { action: 'start', sessionId, mode: cur.mode, tmp: tmpPathsOf(sessionId) };
  }

  function stopOne(reason) {
    const durationSec = (now() - cur.startedAt) / 1000;
    const { sessionId, mode } = cur;
    const tmp = tmpPathsOf(sessionId);
    cur = null;
    state = 'idle'; // finishing 是瞬态：转写异步进行，期间允许开新录音
    if (durationSec < minDurationSec) {
      logger.debug(MOD, `会话 ${sessionId} 仅 ${durationSec.toFixed(3)}s，视为误触丢弃`);
      return { action: 'discard', sessionId, mode, durationSec, tmp };
    }
    logger.info(MOD, `结束录音 ${sessionId}（${durationSec.toFixed(2)}s，${reason}）`);
    return { action: 'stop', sessionId, mode, durationSec, tmp, reason };
  }

  function handle(event) {
    const which = event === 'short-toggle' ? 'short' : event === 'long-toggle' ? 'long' : null;
    if (!which) return { action: 'ignored', why: 'unknown-event' };
    if (state === 'idle') return startOne(which);
    if (which !== cur.which) {
      logger.debug(MOD, `录音中收到 ${event}，忽略`);
      return { action: 'ignored', why: 'other-key-while-recording' };
    }
    return stopOne('user');
  }

  /** 由 main 的秒级定时器调（托盘刷新顺带）。到上限自动收尾并出字。 */
  function tick() {
    if (state !== 'recording') return null;
    const elapsed = (now() - cur.startedAt) / 1000;
    if (elapsed < cur.limitSec) return null;
    logger.info(MOD, `会话 ${cur.sessionId} 到上限 ${cur.limitSec}s，自动收尾`);
    return stopOne('limit');
  }

  /** 强制停止（powerMonitor suspend、麦克风掉线、PCM 超量）。 */
  function forceStop(reason = 'force') {
    if (state !== 'recording') return null;
    return stopOne(reason);
  }

  return {
    handle,
    tick,
    forceStop,
    tmpPathsOf,
    get state() { return state; },
    get activeSessionId() { return cur ? cur.sessionId : null; },
    get current() { return cur ? { ...cur } : null; },
    /** 录音已持续的秒数，给托盘的 🔴 m:ss 用。 */
    elapsedSec() { return cur ? (now() - cur.startedAt) / 1000 : 0; },
  };
}

module.exports = { create, tmpPathsOf, MAX_SHORT_SEC, MAX_LONG_SEC, MIN_DURATION_SEC, MODE_OF };
