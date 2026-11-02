'use strict';
// 文件日志（§18）。行格式：<ISO8601>  <level>  <module>  <message>
//
// 两条硬约束：
// ① 出口脱敏——任何 sk- 开头的串在落盘前变成 sk-***，密钥不许进日志。
// ② 不记 base64 音频、请求体全文、热词表全文；识别文本只记前 60 字。
//    这两件事在调用方做不住（谁都会顺手 log 一整个 body），所以收在出口。

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const MAX_BYTES = 2 * 1024 * 1024; // 超过就轮转，只留 app.log + app.1.log
const TEXT_PREVIEW = 60;
const KEY_RE = /sk-[A-Za-z0-9_\-]{8,}/g;

/** 出口脱敏。任何写盘/打印路径都要先过这里。 */
const redact = (s) => String(s).replace(KEY_RE, 'sk-***');

/** 识别文本只记前 60 字，调用方拿它拼 message。 */
const preview = (text, n = TEXT_PREVIEW) => {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

function logFile() {
  return path.join(paths.logDir(), 'app.log');
}

function rotateIfNeeded(file) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // 还没有文件
  }
  if (size < MAX_BYTES) return;
  try {
    fs.renameSync(file, path.join(path.dirname(file), 'app.1.log'));
  } catch {
    /* 轮转失败不能影响主流程 */
  }
}

function format(level, moduleName, msg) {
  const line = `${new Date().toISOString()}  ${level}  ${moduleName}  ${String(msg ?? '')}`;
  return `${redact(line.replace(/\r?\n/g, ' '))}\n`;
}

function write(level, moduleName, msg) {
  const line = format(level, moduleName, msg);
  try {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeeded(file);
    fs.appendFileSync(file, line, 'utf8');
  } catch {
    /* 日志写不进去也不能让主流程挂掉 */
  }
  return line;
}

module.exports = {
  info: (m, msg) => write('INFO', m, msg),
  warn: (m, msg) => write('WARN', m, msg),
  error: (m, msg) => write('ERROR', m, msg),
  debug: (m, msg) => write('DEBUG', m, msg),
  redact,
  preview,
  format,
  logFile,
  MAX_BYTES,
  TEXT_PREVIEW,
};
