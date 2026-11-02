'use strict';
// 历史 jsonl（§10.3）。存的是 **ASR 原文**（纠错、清理之前）：
// 原真性优先，而且挖热词要的就是原话。纯本地，不上传。
//
// 字段名、顺序、类型与 asr_shim.py 的 record_history 逐字一致，一个都不许改——
// 存量 历史/*.jsonl 和 挖热词.py 要读得通。新增字段只许追加：
// 第 7 个字段**叫 provider，不是 providerId**，旧行缺这个键一律显示「未知」。
//
// 「记录历史」开关的门控在 pipeline（FEAT-003），本模块只管写。

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const logger = require('./logger');

const UNKNOWN_PROVIDER = '未知';

/** ISO8601 秒精度、无毫秒、无时区后缀，本地时区（对齐 Python 的 isoformat(timespec='seconds')）。 */
function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 追加一条。
 * @param {{t?:string, mode:string, dur:number|null, peak:number, rms:number, text:string, provider?:string}} row
 * @returns {string|null} 写入的文件路径；失败返回 null（历史写失败不能打断主流程）
 */
function append(row) {
  const now = new Date();
  const out = {
    t: row.t ?? localStamp(now),
    mode: row.mode,
    dur: typeof row.dur === 'number' ? Math.round(row.dur * 10) / 10 : null,
    peak: row.peak,
    rms: row.rms,
    text: row.text,
  };
  if (row.provider) out.provider = row.provider;
  try {
    const file = paths.historyPath(now);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(out)}\n`, 'utf8');
    return file;
  } catch (e) {
    logger.warn('history', `历史写入失败：${e.message}`);
    return null;
  }
}

/** 月份文件名（YYYY-MM.jsonl）按月份倒序。 */
function monthFiles() {
  try {
    return fs
      .readdirSync(paths.historyDir())
      .filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * 最近 n 条，新的在前。坏行逐行跳过——一行坏 JSON 不能毁掉整月。
 * 缺 provider 的旧行读出来是「未知」；dur 保持 number|null，渲染侧自己容忍 null。
 */
function listRecent(n = 20) {
  const out = [];
  for (const name of monthFiles()) {
    let lines;
    try {
      lines = fs.readFileSync(path.join(paths.historyDir(), name), 'utf8').split(/\r?\n/).filter(Boolean);
    } catch {
      continue;
    }
    for (let i = lines.length - 1; i >= 0 && out.length < n; i -= 1) {
      try {
        const row = JSON.parse(lines[i]);
        out.push({ ...row, dur: typeof row.dur === 'number' ? row.dur : null, provider: row.provider || UNKNOWN_PROVIDER });
      } catch {
        /* 坏行跳过 */
      }
    }
    if (out.length >= n) break;
  }
  return out;
}

/** 全部行（挖热词用），旧的在前，只取 text 非空的行。 */
function allTexts() {
  const texts = [];
  for (const name of [...monthFiles()].reverse()) {
    let lines;
    try {
      lines = fs.readFileSync(path.join(paths.historyDir(), name), 'utf8').split(/\r?\n/).filter(Boolean);
    } catch {
      continue;
    }
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row.text) texts.push(row.text);
      } catch {
        /* 坏行跳过 */
      }
    }
  }
  return texts;
}

/** 按月文件整体删除过期历史。keep_days ≤ 0 视为不清理；当月永不删。 */
function prune(days) {
  if (!days || days <= 0) return [];
  const cutoff = new Date(Date.now() - days * 86400000);
  const keepFrom = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}`;
  const removed = [];
  for (const name of monthFiles()) {
    if (name.slice(0, 7) >= keepFrom) continue;
    try {
      fs.unlinkSync(path.join(paths.historyDir(), name));
      removed.push(name);
    } catch {
      /* 删不掉下次再说 */
    }
  }
  return removed;
}

module.exports = { UNKNOWN_PROVIDER, localStamp, append, listRecent, allTexts, prune, monthFiles };
