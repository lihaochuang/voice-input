'use strict';
// IPC 注册与外部输入校验（design.md §16）。
//
// 三条硬约束：
// ① 通道名只从 ipc-channels.js 取，不写字面量。
// ② 每个 ipcMain.handle **与** ipcMain.on 回调的第一件事都是校验发送方 frame
//    的 url 属于本应用 file://。只覆盖 handle 会漏掉流量最大的 pcm:chunk
//    （它走 send → on）。senderFrame 为 null 一律丢弃并记 debug。
// ③ 载荷校验照 §16 那张表，全部在 main 做。
//
// 加载期不碰 electron（评审 M8）：require('electron') 写在 register() 里。
const path = require('path');
const logger = require('./logger');
const paths = require('./paths');
const { CHANNELS, ERROR_KINDS } = require('./ipc-channels');

const MOD = 'ipc';
const PCM_MAX_BYTES = 64 * 1024;
const OPUS_MAX_BYTES = 32 * 1024 * 1024;
const MSG_MAX_CHARS = 500;
const TEXT_MAX_CHARS = 100000;
const HOTWORDS_MAX_CHARS = 20000;
const PROVIDER_IDS = ['dashscope', 'groq', 'openai', 'custom', 'whispercpp'];
/** hotwords:auto 的封闭动作集。不在表里的一律拒，不做字符串拼装。 */
const AUTO_ACTIONS = ['list', 'remove', 'clear', 'blacklist', 'unblacklist', 'run'];
/** hotkey:capture 的封闭动作集。 */
const CAPTURE_ACTIONS = ['start', 'cancel'];

/** 本应用自己的 file:// 源？（纯函数，便于测试） */
function isOwnUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('file://')) return false;
  try {
    const p = decodeURIComponent(new URL(url).pathname);
    return p.startsWith(paths.appRoot() + path.sep) || p.startsWith(path.join(paths.appRoot(), ''));
  } catch {
    return false;
  }
}

/** 发送方校验。senderFrame 为 null → 丢弃 + debug（不当成通过）。 */
function isOwnFrame(event, channel) {
  let frame = null;
  try {
    frame = event && event.senderFrame;
  } catch {
    frame = null; // frame 已销毁时读属性也会抛
  }
  if (!frame) {
    logger.debug(MOD, `丢弃 ${channel}：senderFrame 为 null`);
    return false;
  }
  if (!isOwnUrl(frame.url)) {
    logger.warn(MOD, `丢弃 ${channel}：发送方不是本应用 (${frame.url})`);
    return false;
  }
  return true;
}

/** PCM 块：非空、≤64KB、偶数字节。 */
function validPcmBytes(bytes) {
  if (!bytes || typeof bytes.length !== 'number') return false;
  return bytes.length > 0 && bytes.length <= PCM_MAX_BYTES && bytes.length % 2 === 0;
}

/** opus：非空、≤32MB。超限丢弃并降级走 WAV。 */
function validOpusBytes(bytes) {
  return !!bytes && typeof bytes.length === 'number' && bytes.length > 0 && bytes.length <= OPUS_MAX_BYTES;
}

const clampMsg = (s) => (typeof s === 'string' ? s.slice(0, MSG_MAX_CHARS) : '');

/**
 * shell:openPath 只接受 main 自己产出过的转录文件（比对转录目录前缀），
 * 以及转录目录本身（设置页的「打开文件夹」按钮用它）。不接受任意路径。
 */
function underTranscriptDir(p, transcriptDir) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || !transcriptDir) return false;
  const base = path.resolve(transcriptDir);
  const target = path.resolve(p);
  return target === base || target.startsWith(base + path.sep);
}

/**
 * 注册全部 IPC。deps 全注入，缺的能力返回 {ok:false,reason:'unavailable'}
 * 而不是抛错（FEAT-004 才补 importer / sponsor）。
 */
function register(deps) {
  const { ipcMain } = require('electron');

  const on = (channel, fn) => {
    ipcMain.on(channel, (event, payload) => {
      if (!isOwnFrame(event, channel)) return;
      try {
        fn(payload, event);
      } catch (e) {
        logger.error(MOD, `${channel} 处理失败：${e && e.name} ${e && e.message}`);
      }
    });
  };
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (event, payload) => {
      if (!isOwnFrame(event, channel)) return { ok: false, reason: 'rejected' };
      try {
        return await fn(payload, event);
      } catch (e) {
        logger.error(MOD, `${channel} 处理失败：${e && e.name} ${e && e.message}`);
        return { ok: false, reason: 'error', message: String((e && e.message) || e) };
      }
    });
  };

  // ───── recorder → main ─────
  on(CHANNELS.PCM_CHUNK, ({ sessionId, bytes } = {}) => {
    if (sessionId !== deps.activeSessionId()) {
      logger.warn(MOD, `丢弃 pcm:chunk：会话不匹配 ${sessionId}`);
      return;
    }
    if (!validPcmBytes(bytes)) {
      logger.warn(MOD, `丢弃 pcm:chunk：长度非法 ${bytes && bytes.length}`);
      return;
    }
    deps.onPcm(sessionId, Buffer.from(bytes));
  });

  on(CHANNELS.OPUS_DONE, ({ sessionId, bytes } = {}) => {
    if (sessionId !== deps.activeSessionId() && !deps.isPendingOpus(sessionId)) {
      logger.warn(MOD, `丢弃 opus:done：会话不匹配 ${sessionId}`);
      return;
    }
    if (!validOpusBytes(bytes)) {
      logger.warn(MOD, `丢弃 opus:done：长度非法 ${bytes && bytes.length}`);
      return;
    }
    deps.onOpus(sessionId, Buffer.from(bytes));
  });

  on(CHANNELS.RECORDER_ERROR, ({ kind, msg } = {}) => {
    if (!ERROR_KINDS.includes(kind)) {
      logger.warn(MOD, `丢弃 recorder:error：未知 kind ${kind}`);
      return;
    }
    deps.onRecorderError(kind, clampMsg(msg));
  });

  on(CHANNELS.DECODE_CHUNK, ({ jobId, bytes } = {}) => {
    if (!deps.isActiveDecodeJob(jobId)) {
      logger.warn(MOD, `丢弃 decode:chunk：jobId 不匹配 ${jobId}`);
      return;
    }
    if (!validPcmBytes(bytes)) return;
    deps.onDecodeChunk(jobId, Buffer.from(bytes));
  });

  on(CHANNELS.DECODE_DONE, ({ jobId, ok, reason } = {}) => {
    if (!deps.isActiveDecodeJob(jobId)) {
      logger.warn(MOD, `丢弃 decode:done：jobId 不匹配 ${jobId}`);
      return;
    }
    deps.onDecodeDone(jobId, !!ok, clampMsg(reason));
  });

  // ───── settings → main ─────
  handle(CHANNELS.CONFIG_GET, () => deps.getConfig());
  handle(CHANNELS.CONFIG_SET, (patch) => {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, reason: 'shape' };
    }
    return deps.setConfig(patch);
  });

  handle(CHANNELS.HOTWORDS_GET, () => deps.getHotwords());
  handle(CHANNELS.HOTWORDS_SET, (text) => {
    if (typeof text !== 'string' || text.length > HOTWORDS_MAX_CHARS) {
      return { ok: false, reason: 'too-long' };
    }
    return deps.setHotwords(text);
  });
  handle(CHANNELS.HOTWORDS_MINE, () => deps.mineHotwords());
  handle(CHANNELS.HOTWORDS_AUTO, ({ action, word } = {}) => {
    if (!AUTO_ACTIONS.includes(action)) return { ok: false, reason: 'shape' };
    // 带 word 的那几个动作：word 必须是非空短字符串（它会被写进 热词.txt）
    if (['remove', 'blacklist', 'unblacklist'].includes(action)) {
      if (typeof word !== 'string' || word.trim() === '' || word.length > 64 || /\s/.test(word)) {
        return { ok: false, reason: 'invalid-word' };
      }
    }
    return deps.autoHotwords(action, typeof word === 'string' ? word.trim() : undefined);
  });
  handle(CHANNELS.HOTWORDS_MERGE, (words) => {
    if (!Array.isArray(words) || words.some((w) => typeof w !== 'string')) {
      return { ok: false, reason: 'shape' };
    }
    return deps.mergeHotwords(words);
  });

  // 只回「是哪家」，**不回传、不记录 Key 本身**（§9）。
  handle(CHANNELS.KEY_DETECT, ({ key } = {}) => {
    if (typeof key !== 'string') return { ok: false, reason: 'shape' };
    const trimmed = key.trim();
    if (trimmed === '' || trimmed.length > 200 || /\s/.test(trimmed)) {
      return { ok: false, reason: 'invalid-key' };
    }
    return deps.detectKey(trimmed);
  });

  handle(CHANNELS.KEY_SET, ({ providerId, key } = {}) => {
    if (!PROVIDER_IDS.includes(providerId) && providerId !== 'polish') {
      return { ok: false, reason: 'unknown-provider' };
    }
    if (typeof key !== 'string') return { ok: false, reason: 'shape' };
    const trimmed = key.trim();
    if (trimmed === '' || trimmed.length > 200 || /\s/.test(trimmed)) {
      return { ok: false, reason: 'invalid-key' };
    }
    return deps.setKey(providerId, trimmed);
  });
  // 只回掩码，永不回明文（§9、不变量 7）。
  handle(CHANNELS.KEY_HAS, ({ providerId } = {}) => {
    if (!PROVIDER_IDS.includes(providerId) && providerId !== 'polish') {
      return { ok: false, reason: 'unknown-provider' };
    }
    return deps.hasKey(providerId);
  });
  handle(CHANNELS.KEY_TEST, ({ providerId } = {}) => {
    if (!PROVIDER_IDS.includes(providerId)) return { ok: false, reason: 'unknown-provider' };
    return deps.testKey(providerId);
  });

  handle(CHANNELS.HISTORY_LIST, ({ limit } = {}) => {
    const n = Number.isInteger(limit) && limit >= 1 && limit <= 1000 ? limit : 50;
    return deps.listHistory(n);
  });
  handle(CHANNELS.CLIPBOARD_COPY, ({ text } = {}) => {
    if (typeof text !== 'string' || text.length > TEXT_MAX_CHARS) {
      return { ok: false, reason: 'shape' };
    }
    return deps.copyText(text);
  });

  handle(CHANNELS.IMPORT_FILES, (list) => {
    if (!Array.isArray(list) || list.some((p) => typeof p !== 'string' || !path.isAbsolute(p))) {
      return { ok: false, reason: 'shape' };
    }
    if (!deps.importFiles) return { ok: false, reason: 'unavailable' };
    return deps.importFiles(list);
  });

  handle(CHANNELS.HOTKEY_REGISTER, ({ which, accelerator } = {}) => {
    if (which !== 'short' && which !== 'long') return { ok: false, reason: 'shape' };
    if (typeof accelerator !== 'string') return { ok: false, reason: 'shape' };
    return deps.registerHotkey(which, accelerator);
  });

  // 单键键位录制。录到的键码由 main 自己从钩子拿，renderer 只能说「开始/取消录哪一个」。
  handle(CHANNELS.HOTKEY_CAPTURE, ({ action, which } = {}) => {
    if (which !== 'short' && which !== 'long') return { ok: false, reason: 'shape' };
    if (!CAPTURE_ACTIONS.includes(action)) return { ok: false, reason: 'shape' };
    return deps.captureHotkey(action, which);
  });

  handle(CHANNELS.DIALOG_PICK_DIR, ({ kind } = {}) => deps.pickDir(typeof kind === 'string' ? kind : 'transcript'));
  handle(CHANNELS.SHELL_OPEN_DATA_DIR, () => deps.openDataDir());
  handle(CHANNELS.SHELL_OPEN_PATH, ({ path: p } = {}) => {
    if (!underTranscriptDir(p, deps.transcriptDir())) {
      logger.warn(MOD, 'shell:openPath 拒绝：路径不在转录目录内');
      return { ok: false, reason: 'rejected' };
    }
    return deps.openPath(p);
  });

  handle(CHANNELS.SPONSOR_GET, () =>
    deps.getSponsor ? deps.getSponsor() : { has: false, text: '赞助资源不可用' });

  // 设置页的 provider 状态点与「重置后端状态」按钮。
  handle(CHANNELS.ASR_STATUS, () => deps.asrStatus());
  handle(CHANNELS.ASR_RESET, ({ providerId } = {}) => {
    // 不传 providerId = 清全部冷却；传了就必须是已知 id
    if (providerId !== undefined && !PROVIDER_IDS.includes(providerId)) {
      return { ok: false, reason: 'unknown-provider' };
    }
    return deps.asrReset(providerId);
  });

  logger.info(MOD, 'IPC 已注册');
}

module.exports = {
  register,
  isOwnUrl,
  isOwnFrame,
  validPcmBytes,
  validOpusBytes,
  underTranscriptDir,
  clampMsg,
  PCM_MAX_BYTES,
  OPUS_MAX_BYTES,
  PROVIDER_IDS,
  AUTO_ACTIONS,
  CAPTURE_ACTIONS,
};
