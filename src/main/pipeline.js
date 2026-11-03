'use strict';
// 唯一调用顺序事实源（design.md §7 的顺序是硬约束，不变量 1/2/3/4/8/17/19）。
//
// 顺序：
//   汇合 opus+PCM（等两个条件，超时 3 秒以已有数据继续）
//   → 算电平
//   → 静音拦截（isSilent 命中就直接返回空：**不发请求、不写历史**）
//   → 落盘到 待处理/
//   → ASR
//   → 热词回显检测（命中整条丢弃）
//   → 写历史（**存 ASR 原文**，纠错与清理之前）
//   → 纠错
//   → 口语清理（三条件同时成立才做）
//   → 输出（短输入 paste.deliver / 长录音 archive.save）
//   → finally: pending.cleanupTmp
//
// 依赖全部注入，所以这个顺序本身能被测试覆盖（现有 Python 版靠注释维持）。
// 本模块加载期只 require 纯逻辑模块，不碰 electron。
const logger = require('./logger');

const MOD = 'pipeline';

const JOIN_TIMEOUT_MS = 3000; // 双轨汇合超时：到点就以已有数据继续
const PCM_ZERO_ERROR_SEC = 1; // 录音 > 1 秒还一个 PCM 块都没有 = bug（§15-42）

/**
 * 口语清理的门控（纯函数，便于断言）。三条件**同时**成立才做：
 *   mode === '短输入' 且 配置.口语清理 === true 且 非补转
 * 长录音与补转一律跳过、**不看配置**（不变量 17：放进界面文案等于把原真性
 * 托付给用户的记性）。
 */
const shouldPolish = ({ mode, cfg, isRetry }) =>
  mode === '短输入' && !!(cfg && cfg.口语清理) && !isRetry;

/**
 * 跑一次完整链路。
 *
 * @param {object} o
 * @param {string} o.sessionId
 * @param {'短输入'|'长录音'} o.mode
 * @param {boolean} [o.isRetry]  补转路径（结果存文件、不粘贴、不清理）
 * @param {object} o.cfg         配置对象（config.load() 的结果）
 * @param {object} o.deps        全部依赖，见下面的解构
 */
async function run({ sessionId, mode, isRetry = false, cfg = {}, durationSec = 0, deps }) {
  const {
    collect, // async ({sessionId, timeoutMs}) => {wavPath, opus, pcm, durationSec, chunkCount}
    levels, // (Int16Array) => {peak, rms}
    isSilent, // (Int16Array) => boolean   ← 用 wav.isSilent，别再自己比 500
    stash, // (sessionId, meta) => {id, wavPath, jsonPath} | null
    transcribe, // (args) => {text, providerId, switched}
    loadHotwords, // () => string[]        ← 每次请求重读，禁止缓存（不变量 6）
    looksLikeContextEcho, // (text, words) => boolean
    appendHistory, // (row) => path|null
    loadCorrections, // () => {rules, badLines}
    applyCorrections, // (text, rules) => {text, hits}
    polish, // (text, {cfg, key}) => {text, changed, reason}
    polishKey, // () => string|null
    deliver, // (text) => {clipboard, pasted, reason?}
    archiveSave, // ({text, durationSec, audioPath, dir, stamp}) => {mdPath,...}
    stampOf, // (Date) => string
    transcriptDir, // () => string
    cleanupTmp, // (sessionId, outcome, meta) => void
    tray, // {busy(), ok(), copied(), warn(msg), silent()} 可选
    log = logger,
  } = deps;

  let outcome = 'failed';
  let pending = null;
  let meta = { mode, durationSec, peak: 0, rms: 0 };
  const out = { sessionId, mode, isRetry, text: '', providerId: null, switched: false };

  try {
    // ① 汇合双轨
    const tracks = await collect({ sessionId, timeoutMs: JOIN_TIMEOUT_MS });
    const pcm = tracks.pcm || null;
    const secs = tracks.durationSec || durationSec || 0;
    meta.durationSec = secs;

    if (!pcm || pcm.length === 0) {
      // 只有 opus 没有 PCM：跳过静音拦截直接上传（宁可多花一次钱，不能把话丢掉）
      const msg = `会话 ${sessionId} 没有 PCM 轨（chunk=${tracks.chunkCount || 0}），跳过静音拦截直接上传`;
      if (secs > PCM_ZERO_ERROR_SEC) {
        // §15-42：sink 没接 / worklet 没加载是 bug，不许只以 warn 沉底
        log.error(MOD, `${msg}——录音 ${secs.toFixed(1)}s 却零块，录音采集异常`);
        if (tray) tray.warn('录音采集异常，请查看日志');
      } else {
        log.warn(MOD, msg);
      }
    } else {
      // ② 算电平 → ③ 静音拦截
      const lv = levels(pcm);
      meta.peak = lv.peak;
      meta.rms = lv.rms;
      if (isSilent(pcm)) {
        outcome = 'silent';
        log.info(MOD, `会话 ${sessionId} 静音（peak=${lv.peak}），不发请求、不写历史`);
        if (tray) tray.silent();
        return { ...out, outcome };
      }
    }

    // ④ 落盘到 待处理/（在任何网络调用之前，不变量 1）
    if (!isRetry) {
      pending = stash(sessionId, meta);
      // 没有 WAV 轨（PCM 零块）时这里必然 null，但 webm 已经在 tmp/ 落好了，
      // cleanupTmp 会在失败时把它移进 待处理/，所以仍然能补转（见 pending.cleanupTmp ①）。
      if (!pending) log.warn(MOD, `会话 ${sessionId} 未能移入 待处理/（可能没有 WAV 轨），失败时按 webm 兜底`);
    }

    // ⑤ ASR
    if (tray) tray.busy();
    const hotwords = loadHotwords();
    const asr = await transcribe({
      tracks: { opus: tracks.opus || null, wavPath: pending ? pending.wavPath : tracks.wavPath },
      durationSec: secs,
      mode,
      hotwords,
      cfg,
    });
    out.providerId = asr.providerId;
    out.switched = !!asr.switched;
    const raw = (asr.text || '').trim();

    // 空识别结果是正常分支、不是失败（不变量 11，不切后端）
    if (raw === '') {
      outcome = meta.peak < 1 && !pcm ? 'failed' : 'empty';
      log.info(MOD, `会话 ${sessionId} 识别结果为空（非静音），音频保留`);
      if (tray) tray.silent();
      return { ...out, outcome };
    }

    // ⑥ 热词回显检测：命中整条丢弃，但**音频保留**（不变量 18）
    if (looksLikeContextEcho(raw, hotwords)) {
      outcome = 'echo';
      log.warn(MOD, `会话 ${sessionId} 命中热词回显，整条丢弃，音频保留在 待处理/`);
      if (tray) tray.silent();
      return { ...out, outcome };
    }

    // ⑦ 写历史——**存 ASR 原文**（纠错、清理之前；挖热词的原料必须是原话）
    if (cfg.记录历史 !== false) {
      try {
        appendHistory({ text: raw, mode, durationSec: secs, provider: asr.providerId });
      } catch (e) {
        log.error(MOD, `写历史失败（吞掉继续）：${e && e.message}`);
      }
    }

    // ⑧ 纠错
    let text = raw;
    try {
      const { rules } = loadCorrections();
      const r = applyCorrections(text, rules);
      text = r.text;
    } catch (e) {
      log.warn(MOD, `纠错失败，用原文：${e && e.message}`);
    }

    // ⑨ 口语清理（三条件同时成立才做）
    if (shouldPolish({ mode, cfg, isRetry })) {
      const r = await polish(text, { cfg, key: polishKey() });
      text = r.text; // polish 内部保证失败时返回原文
    }
    out.text = text;

    // ⑩ 输出
    if (isRetry || mode === '长录音') {
      const stamp = stampOf(new Date());
      const saved = archiveSave({
        text,
        durationSec: secs,
        audioPath: [tracks.webmPath, pending ? pending.wavPath : tracks.wavPath],
        dir: transcriptDir(),
        stamp,
        deleteTmp: false, // 删除收口在 cleanupTmp，不在 archive 里分叉
      });
      out.mdPath = saved.mdPath;
      if (tray) tray.ok();
    } else {
      const d = await deliver(text);
      out.pasted = !!d.pasted;
      out.clipboard = true;
      if (tray) (d.pasted ? tray.ok : tray.copied)();
    }

    outcome = 'success';
    return { ...out, outcome };
  } catch (e) {
    outcome = 'failed';
    log.error(MOD, `会话 ${sessionId} 失败：${(e && e.name) || ''} ${(e && e.message) || e}`);
    if (tray) tray.warn((e && e.message) || '识别失败');
    return { ...out, outcome, error: { name: e && e.name, kind: e && e.kind, message: e && e.message } };
  } finally {
    // 删除唯一收口。不散落到各 catch——散开写必然漏格，而漏格在磁盘上看不出来。
    try {
      cleanupTmp(sessionId, outcome, { ...meta, pending });
    } catch (e) {
      log.warn(MOD, `cleanupTmp 抛错：${e && e.message}`);
    }
  }
}

module.exports = { run, shouldPolish, JOIN_TIMEOUT_MS, PCM_ZERO_ERROR_SEC };
