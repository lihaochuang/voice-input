'use strict';
// 长录音归档（§10.2）：Markdown 落盘 + 原始音频留一份。
//
// 字段与措辞照抄 main.swift 的 stamp() / keepAudio() / saveTranscript()
// （按函数名定位，不要按行号——各处文档写的行号都不准）。三处有意改动：
// ① 同一分钟内的第二次归档加 -2 / -3 后缀，**不覆盖**已有文件；
// ② stamp 由调用方算一次，同时用于 .md 与音频文件名（评审 N2：原实现 stamp() 被调两次，
//    跨分钟会让 md 里的「原始音频」行指向一个不存在的文件）；
// ③ 「时间」一行由 stamp 推导而不是再读一次 Date()，同理由，顺带让产物可测。

const fs = require('fs');
const path = require('path');

/** yyyy-MM-dd_HHmm（本地时区）。调用方算一次，.md 与音频共用。 */
function stampOf(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 从 stamp 还原成「2026-11-02 13:07」。 */
function humanTime(stamp) {
  const m = /^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})/.exec(stamp);
  return m ? `${m[1]} ${m[2]}:${m[3]}` : stamp;
}

/** 同分钟冲突时取 stamp、stamp-2、stamp-3…… 第一个 .md 不存在的。 */
function uniqueStamp(dir, stamp) {
  for (let i = 1; i < 1000; i += 1) {
    const s = i === 1 ? stamp : `${stamp}-${i}`;
    if (!fs.existsSync(path.join(dir, `${s}.md`))) return s;
  }
  throw new Error(`同一分钟已经有 1000 份转录了，这不正常：${stamp}`);
}

/**
 * 产物正文。录音归档与 §24 的导入产物共用这一套结构，
 * 导入路径多给一个 provider（「识别后端」那一行），录音路径不给、那行就不出现。
 */
function renderMarkdown({ stamp, text, durationSec, audioName, provider }) {
  const total = Math.max(0, Math.round(durationSec || 0));
  const lines = [
    `# 录音转录 ${stamp}`,
    '',
    `- 时间：${humanTime(stamp)}`,
    `- 时长：${Math.floor(total / 60)} 分 ${total % 60} 秒`,
    `- 字数：${[...String(text ?? '')].length}`,
  ];
  if (audioName) lines.push(`- 原始音频：${audioName}`);
  if (provider) lines.push(`- 识别后端：${provider}`);
  lines.push('', '---', '', `${text}`, '');
  return lines.join('\n');
}

/**
 * 归档一次长录音。
 * @param {object} a
 * @param {string} a.text 全文，原样写入，不做任何换行重排
 * @param {number} a.durationSec
 * @param {string|string[]} [a.audioPath] 候选音频，按优先级给（webm 在前、修补后的 WAV 在后）
 * @param {string} a.dir 转录目录
 * @param {string} a.stamp 调用方算好的时间戳
 * @param {boolean} [a.deleteTmp=true] 归档完是否删掉 tmp 里的候选音频
 * @returns {{mdPath:string, audioPath:string|null, stamp:string}}
 */
function save({ text, durationSec, audioPath, dir, stamp, deleteTmp = true }) {
  if (!dir) throw new Error('archive.save 缺 dir');
  if (!stamp) throw new Error('archive.save 缺 stamp（必须由调用方算一次）');
  fs.mkdirSync(dir, { recursive: true });
  const s = uniqueStamp(dir, stamp);

  const candidates = (Array.isArray(audioPath) ? audioPath : [audioPath]).filter(Boolean);
  const src = candidates.find((p) => fs.existsSync(p)) || null;
  let kept = null;
  if (src) {
    const dest = path.join(dir, `${s}${path.extname(src)}`);
    try {
      fs.copyFileSync(src, dest); // 复制语义：失败也不至于把用户的录音弄丢
      kept = dest;
    } catch {
      kept = null; // 音频归档失败，md 里就不出现「原始音频」那一行
    }
  }

  const mdPath = path.join(dir, `${s}.md`);
  fs.writeFileSync(mdPath, renderMarkdown({ stamp: s, text, durationSec, audioName: kept ? path.basename(kept) : null }), 'utf8');

  if (deleteTmp) {
    for (const p of candidates) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        /* 删不掉只是占点空间，不影响用户拿到转录 */
      }
    }
  }
  return { mdPath, audioPath: kept, stamp: s };
}

module.exports = { stampOf, humanTime, uniqueStamp, renderMarkdown, save };
