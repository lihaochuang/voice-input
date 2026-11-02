'use strict';
// 长音频切段。常量与算法照抄 asr_shim.py（SEGMENT_SECONDS / SEARCH_WINDOW / MAX_PARALLEL
// 在 :290-292，_quietest_frame 在 :308）。
//
// 为什么要在停顿处下刀：一句话中间切会把字切坏，宁可段长不均匀。
//
// 本文件是评审 H1 / M3 的纯逻辑落点：
// H1 —— 组链过滤要按「单个请求的时长」而不是整段时长，所以切片阈值必须随 chain 变（sliceThresholdSec）。
// M3 —— 后端的 maxBytes 也得进切片口径，否则段时长合法但请求体超限（segmentSecondsFor）。

const SPLIT_SECONDS = 170; // 超过这个时长才切段（短输入上限也是它）
const SEGMENT_SECONDS = 150; // 单段目标时长。百炼单次限 3 分钟，留 30 秒余量
const SEARCH_WINDOW = 25; // 在目标切点前这么多秒内找最安静处下刀
const MAX_PARALLEL = 3; // 并行转写的段数。RPM 限 100，这个值很保守

const BYTES_PER_SECOND = 32000; // 16kHz / 16bit / 单声道
const WAV_HEADER_BYTES = 44;

/**
 * 在 [lo, hi) 样本区间里找最安静的位置当切点。
 * 采约 200 个点就够找到停顿，不必逐帧扫（照抄 Python 的 step/window 口径）。
 */
function quietestFrame(int16, lo, hi) {
  const step = Math.max(1, Math.floor((hi - lo) / 200));
  const window = step * 2;
  let best = lo;
  let bestRms = null;
  for (let f = lo; f < hi - window; f += step) {
    let sq = 0;
    for (let i = f; i < f + window; i += 1) sq += int16[i] * int16[i];
    const rms = Math.sqrt(sq / window);
    if (bestRms === null || rms < bestRms) {
      best = f;
      bestRms = rms;
    }
  }
  return best;
}

/**
 * 切段。总时长 ≤ thresholdSec 直接返回单段。
 * @returns {{start:number,end:number,pcm:Int16Array}[]} 样本下标区间，切点严格递增
 */
function split(int16, { sampleRate = 16000, thresholdSec = SPLIT_SECONDS, segmentSec = SEGMENT_SECONDS } = {}) {
  const total = int16.length;
  const seg = (start, end) => ({ start, end, pcm: int16.subarray(start, end) });
  if (total / sampleRate <= thresholdSec) return [seg(0, total)];

  const segFrames = Math.floor(segmentSec * sampleRate);
  const search = Math.floor(SEARCH_WINDOW * sampleRate);
  const out = [];
  let pos = 0;
  while (pos < total) {
    let end;
    if (pos + segFrames >= total) {
      end = total;
    } else {
      const target = pos + segFrames;
      end = quietestFrame(int16, Math.max(pos + 1, target - search), target);
    }
    out.push(seg(pos, end));
    pos = end;
  }
  return out;
}

const maxSecondsOf = (p) => (p && p.limits && Number.isFinite(p.limits.maxSeconds) ? p.limits.maxSeconds : Infinity);

/**
 * maxBytes 折算成秒。
 * base64 内联的后端（百炼）比的是编码后的体积，可用裸字节只有 maxBytes 的 3/4；
 * multipart 的后端直接比裸字节。两者都要扣掉 44 字节 WAV 头。
 *
 * TODO(FEAT-002)：形态目前靠 limits.inlineBase64 标记，缺失时按 id==='dashscope' 推断。
 *   asr/types.js 的 LIMITS 落地时请把这个布尔显式写上，别继续靠 id 猜。
 */
function bytesToSeconds(p) {
  const max = p && p.limits ? p.limits.maxBytes : undefined;
  if (!Number.isFinite(max)) return Infinity;
  const inline = p.limits.inlineBase64 ?? p.id === 'dashscope';
  const usable = (inline ? Math.floor((max * 3) / 4) : max) - WAV_HEADER_BYTES;
  return Math.max(1, Math.floor(usable / BYTES_PER_SECOND));
}

/** 切不切段的阈值：谁的上限最小听谁的。 */
function sliceThresholdSec(chain = []) {
  return Math.min(SPLIT_SECONDS, ...chain.map(maxSecondsOf));
}

/** 单段目标时长：时长上限与字节上限里最小的那个。 */
function segmentSecondsFor(chain = []) {
  return Math.min(SEGMENT_SECONDS, ...chain.map(maxSecondsOf), ...chain.map(bytesToSeconds));
}

module.exports = {
  SPLIT_SECONDS,
  SEGMENT_SECONDS,
  SEARCH_WINDOW,
  MAX_PARALLEL,
  BYTES_PER_SECOND,
  quietestFrame,
  split,
  bytesToSeconds,
  sliceThresholdSec,
  segmentSecondsFor,
};
