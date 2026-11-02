'use strict';
// 热词表。
//
// 硬约束（不变量 §17）：**每次请求重读文件，禁止任何缓存，包括 mtime 判断**。
// 用户改完热词存盘就该立刻生效，加任何缓存层都会让「改了没用」变成一类难查的投诉。

const fs = require('fs');
const paths = require('./paths');

// 热词文件和示例都读不到时的兜底。故意只放极少量通用词：
// 真正的热词是用户自己领域的专有名词，代码里不该预置任何业务术语（照抄 asr_shim.py:47）。
const DEFAULT_HOTWORDS = '口径 复盘 迭代 灰度 埋点 取数 看板 幂等 并发';

const ECHO_MIN_CHARS = 30;
const ECHO_RATIO = 0.9;

/** 剥 # 注释后按空白切词。 */
const parse = (text) =>
  String(text)
    .split(/\r?\n/)
    .map((l) => l.split('#', 1)[0])
    .join(' ')
    .split(/\s+/)
    .filter(Boolean);

/**
 * 读热词。文件缺失时从 热词.示例.txt 落地一份（用户之后编辑那一份），
 * 示例也读不到就用内置兜底词。
 * @returns {string[]}
 */
function load() {
  const file = paths.hotwordsPath();
  try {
    const words = parse(fs.readFileSync(file, 'utf8'));
    if (words.length) return words;
  } catch (e) {
    if (e.code !== 'ENOENT') return parse(DEFAULT_HOTWORDS);
    let content;
    try {
      content = fs.readFileSync(paths.sampleHotwordsPath(), 'utf8');
    } catch {
      content = DEFAULT_HOTWORDS;
    }
    try {
      fs.mkdirSync(paths.dataDir(), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
    } catch {
      /* 落地失败不影响本次识别 */
    }
    const words = parse(content);
    if (words.length) return words;
  }
  return parse(DEFAULT_HOTWORDS);
}

/**
 * 热词文件**原文**，`#` 注释一并保留——设置页的 textarea 编辑的就是这份
 * （按主题分组是用户的用法，load() 返回的词数组会把注释吃掉）。
 * 文件缺失时先走一遍 load() 把示例落地，再读。
 */
function loadRaw() {
  try {
    return fs.readFileSync(paths.hotwordsPath(), 'utf8');
  } catch {
    load();
    try {
      return fs.readFileSync(paths.hotwordsPath(), 'utf8');
    } catch {
      return DEFAULT_HOTWORDS;
    }
  }
}

/**
 * 整表覆盖写（设置界面与自动热词都走这里）。
 *
 * 必须是 temp + rename：这份文件是**用户手写维护**的（注释与分组都在里面），
 * 而 autohotwords 会在无人看着的时候周期性整表重写它。裸 writeFileSync 写到一半
 * 进程死掉会留下截断文件，下次 load() 读残文件不报错、只静默少几十个词——
 * 「热词突然不准了」属于最难归因的那类投诉。rename 同目录是原子的，失败就不动原文件。
 */
function save(text) {
  fs.mkdirSync(paths.dataDir(), { recursive: true });
  const file = paths.hotwordsPath();
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, String(text), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 残片删不掉也不影响原文件 */ }
    throw e;
  }
  return file;
}

/**
 * 判断 ASR 返回的是不是把热词表原样吐了回来。
 * 静音拦截已经挡掉绝大部分情况，这里兜住剩下的（只有极轻微底噪时）。
 * 判据：结果较长，且绝大多数字都来自热词表。
 */
function looksLikeContextEcho(text, words = load()) {
  const s = String(text ?? '');
  if (s.length < ECHO_MIN_CHARS) return false;
  const vocab = new Set(words.join(''));
  let hit = 0;
  for (const ch of s) if (vocab.has(ch)) hit += 1;
  return hit / s.length > ECHO_RATIO;
}

module.exports = { DEFAULT_HOTWORDS, ECHO_MIN_CHARS, ECHO_RATIO, parse, load, loadRaw, save, looksLikeContextEcho };
