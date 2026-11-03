'use strict';
// 音频采集健康状态机（v0.1.1 ④）。纯逻辑：不碰 electron、不碰 fs，裸 Node 可加载。
//
// 为什么要有这个模块，而不是在 renderer 里就地自愈：
// 实测日志（15:49~15:53）里连续四次「PCM 块 0 个、opus 0 字节」，
// recorder.js 的 onstop 零块判定**一次都没触发**——麦克风权限框弹着的时候
// getUserMedia 挂住，MediaRecorder 从来没起来，自然没有 onstop。
// 所以权威的零块判定只能放在 main 侧 collect()（那里每次会话都有 chunkCount），
// 本模块就是 collect() 要问的那张「该升级到第几级」的表。
//
// 为什么要分级而不是一律重建：实测两次都是整个应用重启才恢复，renderer 内
// 重建音频图不够（僵尸 context 会自报 state=running，见 recorder.js 的注释）。
// 一级 rebuild 便宜但可能无效，二级 reload 等于换一个渲染进程，三级就别再
// 静默重试了——连三次都救不回来，用户需要知道「退出重开」这件事。

/** 低于这个时长的会话判不了零块（按都没按稳），照 pipeline.PCM_ZERO_ERROR_SEC 的同一条线。 */
const DEFAULT_MIN_SEC = 1;

/**
 * @param {{minSec?:number}} [opts]
 * @returns {{
 *   onSession: (s:{chunkCount:number, durationSec:number}) => {action:'none'|'rebuild'|'reload'|'alert', consecutiveZero:number},
 *   deviceError: () => void,
 *   pendingRebuild: () => boolean,
 *   reset: () => void,
 * }}
 */
function create({ minSec = DEFAULT_MIN_SEC } = {}) {
  const min = Number.isFinite(minSec) ? minSec : DEFAULT_MIN_SEC;
  let consecutiveZero = 0;
  let pending = false;

  return {
    /** 一次热键会话结束时调。返回该做哪一级自愈。 */
    onSession({ chunkCount, durationSec } = {}) {
      const n = Number.isFinite(chunkCount) ? chunkCount : 0;
      const sec = Number.isFinite(durationSec) ? durationSec : 0;
      // 太短：判不了。**计数不动**——不能归零（上一次的零块还没解决），
      // 也不能累加（用户只是手滑点了一下）。
      if (sec <= min) return { action: 'none', consecutiveZero };
      if (n > 0) {
        consecutiveZero = 0;
        return { action: 'none', consecutiveZero };
      }
      consecutiveZero += 1;
      const action = consecutiveZero === 1 ? 'rebuild'
        : consecutiveZero === 2 ? 'reload'
          : 'alert';
      return { action, consecutiveZero };
    },

    /**
     * 收到设备层错误（Chromium 那条 'The AudioContext encountered an error…'，
     * 只能从 main 的 console-message 截到，见 recorder.js ④-c 的注释）。
     * 不立刻重建：这条消息实测晚到 10 秒，那会儿录音已经结束了，重建没人看。
     * 标记下来，**下次录音开始前**先重建。
     */
    deviceError() {
      pending = true;
    },

    /** 读即消费：问过一次就清掉，否则每次录音都会白重建一遍。 */
    pendingRebuild() {
      const p = pending;
      pending = false;
      return p;
    },

    /** 换了渲染进程（render-process-gone）之后调：之前的连续零块计数作废。 */
    reset() {
      consecutiveZero = 0;
      pending = false;
    },
  };
}

module.exports = { create, DEFAULT_MIN_SEC };
