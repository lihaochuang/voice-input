'use strict';
// 热词自动提炼并自动加入（设计决策.md「追加需求二·四」）。
//
// 用户要的是「录音都在本地，隔一段时间自动把高频词变成热词，别让我手动确认」。
// 但这件事本身是**危险的正反馈**，不能照字面放任：
//
//   ASR 听错的词同样会高频出现。实测案例：用户说「客单价」被反复听成「课单价」，
//   「课单价」于是成了高频词；把它自动加进热词表，模型会更倾向输出那个错词，
//   错误自我强化，而且用户几乎不可能发现是自己的热词表在推着它错。
//
// 所以这里有五道对冲，一道都不能省：
//   ① 门槛更高：只采纳出现次数 ≥ 阈值（默认 5，手动模式的 MIN_COUNT 才 3）；
//   ② 自动加的词写在 热词.txt 的**独立分段**里，和手写的分开，能整段回滚；
//   ③ 台账（自动热词.json）记下每个词的来源次数与添加时间，界面可逐个移除；
//   ④ 黑名单：移除过的词可以标「永不自动添加」，不会下次又被加回来；
//   ⑤ 每次添加后给一次低调通知，**绝不静默**——静默是最危险的那种自动化。
//
// 提炼算法完全复用 mine.mine（它已经做了「先剔除已知热词再 n-gram」那一步，
// 少了这步挖出来全是跨词碎片），只把 minCount 提到阈值。
//
// 加载期不碰 electron（评审 M8）。

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const paths = require('./paths');
const hotwordsMod = require('./hotwords');
const mine = require('./mine');

const MOD = 'autohotwords';

const DEFAULT_MIN_COUNT = 5; // 自动入表的门槛，比手动的 MIN_COUNT=3 更严
const MAX_PER_RUN = 20; // 一次最多自动加这么多，免得某天历史暴增一次灌几百个
const FREQ_MS = { weekly: 7 * 86400000, monthly: 30 * 86400000 };

// 分段标记。整段可删 = 可整体回滚（对冲②）。
const SECTION_BEGIN = '# ══ 以下由「热词自动提炼」自动添加，可整段删除 ══';
const SECTION_END = '# ══ 自动添加结束 ══';

const ymd = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 台账路径：<userData>/自动热词.json */
const ledgerPath = () => path.join(paths.dataDir(), '自动热词.json');

/** 台账。坏文件按空台账处理——它不是事实源，热词.txt 才是。 */
function loadLedger() {
  try {
    const j = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
    return {
      words: Array.isArray(j.words) ? j.words.filter((w) => w && typeof w.word === 'string') : [],
      blacklist: Array.isArray(j.blacklist) ? j.blacklist.filter((w) => typeof w === 'string') : [],
      lastRunAt: typeof j.lastRunAt === 'number' ? j.lastRunAt : 0,
    };
  } catch {
    return { words: [], blacklist: [], lastRunAt: 0 };
  }
}

function saveLedger(ledger) {
  fs.mkdirSync(paths.dataDir(), { recursive: true });
  fs.writeFileSync(ledgerPath(), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  return ledgerPath();
}

/**
 * 把热词原文拆成「用户手写的部分」与「自动分段」。纯函数。
 * 自动分段不存在时 auto 为空数组，before/after 合起来就是全文。
 */
function splitSections(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const b = lines.indexOf(SECTION_BEGIN);
  if (b < 0) return { before: lines, auto: [], after: [] };
  const e = lines.indexOf(SECTION_END, b + 1);
  if (e < 0) return { before: lines.slice(0, b), auto: lines.slice(b + 1), after: [] };
  return { before: lines.slice(0, b), auto: lines.slice(b + 1, e), after: lines.slice(e + 1) };
}

/** 自动分段里现有的词（用来算差集，避免重复写同一个词）。 */
function wordsInAutoSection(text) {
  const { auto } = splitSections(text);
  return hotwordsMod.parse(auto.join('\n'));
}

/**
 * 用台账重写自动分段。**只动自动分段，用户手写的部分一个字不碰。**
 * 台账空了就把整个分段连标记一起去掉，文件回到「没开过这功能」的样子。
 */
function renderWithAuto(text, ledgerWords) {
  const { before, after } = splitSections(text);
  const keep = (arr) => {
    const out = [...arr];
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    return out;
  };
  const head = keep(before);
  const tail = after.filter((l, i) => !(i === 0 && l.trim() === ''));
  if (ledgerWords.length === 0) {
    const body = [...head, ...(tail.length ? ['', ...tail] : [])];
    return `${body.join('\n').replace(/\n+$/, '')}\n`;
  }
  // 按添加日期分组，每组一行注释 + 每 10 词一行（与手动 merge 的排版一致）
  const byDate = new Map();
  for (const w of ledgerWords) {
    const d = w.addedAt ? ymd(new Date(w.addedAt)) : ymd();
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(w.word);
  }
  const section = [SECTION_BEGIN];
  for (const [date, list] of [...byDate.entries()].sort()) {
    section.push(`# ── ${date} 自动添加 ${list.length} 个 ──`);
    for (let i = 0; i < list.length; i += 10) section.push(list.slice(i, i + 10).join(' '));
  }
  section.push(SECTION_END);
  const body = [...head, '', ...section, ...(tail.length ? ['', ...tail] : [])];
  return `${body.join('\n').replace(/\n+$/, '')}\n`;
}

/** 该不该跑了。off 永不跑；没跑过就立刻跑一次。 */
function dueNow({ freq = 'weekly', lastRunAt = 0, now = Date.now() } = {}) {
  if (freq === 'off') return false;
  const span = FREQ_MS[freq] || FREQ_MS.weekly;
  return now - (lastRunAt || 0) >= span;
}

/**
 * 跑一次自动提炼。
 * @param {object} o
 * @param {string[]} o.rows 历史文本（history.allTexts()）
 * @param {number} [o.minCount] 阈值，默认 5
 * @param {Date}   [o.now]
 * @returns {{added:{word,count,addedAt}[], skippedBlacklist:string[], candidates:number, path:string|null}}
 */
function runOnce({ rows = [], minCount = DEFAULT_MIN_COUNT, now = new Date() } = {}) {
  const ledger = loadLedger();
  const text = hotwordsMod.loadRaw();
  const known = hotwordsMod.parse(text); // 含自动分段里的词：已经加过的不要再算候选
  const cands = mine.mine(rows, known, { minCount });
  const black = new Set(ledger.blacklist);
  const already = new Set(wordsInAutoSection(text));
  const skippedBlacklist = [];
  const picked = [];
  for (const c of cands) {
    if (black.has(c.word)) { skippedBlacklist.push(c.word); continue; }
    if (already.has(c.word)) continue;
    picked.push({ word: c.word, count: c.count, addedAt: now.getTime() });
    if (picked.length >= MAX_PER_RUN) break;
  }
  ledger.lastRunAt = now.getTime();
  if (picked.length === 0) {
    saveLedger(ledger);
    logger.info(MOD, `自动提炼：候选 ${cands.length} 个，没有可加的（黑名单跳过 ${skippedBlacklist.length} 个）`);
    return { added: [], skippedBlacklist, candidates: cands.length, path: null };
  }
  ledger.words = [...ledger.words, ...picked];
  const p = hotwordsMod.save(renderWithAuto(text, ledger.words));
  saveLedger(ledger);
  logger.info(MOD, `自动提炼：加了 ${picked.length} 个热词（${picked.map((w) => `${w.word}×${w.count}`).join(' ')}）`);
  return { added: picked, skippedBlacklist, candidates: cands.length, path: p };
}

/** 台账 + 热词文件里自动分段的现状，给设置页列表用。 */
function list() {
  const ledger = loadLedger();
  return {
    words: [...ledger.words].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)),
    blacklist: ledger.blacklist,
    lastRunAt: ledger.lastRunAt,
    inFile: wordsInAutoSection(hotwordsMod.loadRaw()),
  };
}

/**
 * 移除一个自动添加的词。blacklist=true 时同时标「永不自动添加」，
 * 否则下次提炼还会把它加回来（移除的意思本来就是「我不要这个词」）。
 */
function remove(word, { blacklist = true } = {}) {
  const ledger = loadLedger();
  const before = ledger.words.length;
  ledger.words = ledger.words.filter((w) => w.word !== word);
  if (blacklist && !ledger.blacklist.includes(word)) ledger.blacklist.push(word);
  hotwordsMod.save(renderWithAuto(hotwordsMod.loadRaw(), ledger.words));
  saveLedger(ledger);
  logger.info(MOD, `移除自动热词 ${word}${blacklist ? '（已加入永不自动添加）' : ''}`);
  return { ok: true, removed: before - ledger.words.length, blacklisted: blacklist };
}

/** 清空自动分段。默认**不**整批拉黑：那样等于永久关掉这功能的一半。 */
function clear({ blacklist = false } = {}) {
  const ledger = loadLedger();
  const words = ledger.words.map((w) => w.word);
  if (blacklist) for (const w of words) if (!ledger.blacklist.includes(w)) ledger.blacklist.push(w);
  ledger.words = [];
  hotwordsMod.save(renderWithAuto(hotwordsMod.loadRaw(), []));
  saveLedger(ledger);
  logger.info(MOD, `清空自动热词 ${words.length} 个${blacklist ? '并全部拉黑' : ''}`);
  return { ok: true, cleared: words.length };
}

/** 直接往黑名单加一个词（不要求它当前在表里）。 */
function blacklistAdd(word) {
  const ledger = loadLedger();
  if (!ledger.blacklist.includes(word)) ledger.blacklist.push(word);
  ledger.words = ledger.words.filter((w) => w.word !== word);
  hotwordsMod.save(renderWithAuto(hotwordsMod.loadRaw(), ledger.words));
  saveLedger(ledger);
  return { ok: true, blacklist: ledger.blacklist };
}

function blacklistRemove(word) {
  const ledger = loadLedger();
  ledger.blacklist = ledger.blacklist.filter((w) => w !== word);
  saveLedger(ledger);
  return { ok: true, blacklist: ledger.blacklist };
}

module.exports = {
  DEFAULT_MIN_COUNT,
  MAX_PER_RUN,
  FREQ_MS,
  SECTION_BEGIN,
  SECTION_END,
  ledgerPath,
  loadLedger,
  saveLedger,
  splitSections,
  wordsInAutoSection,
  renderWithAuto,
  dueNow,
  runOnce,
  list,
  remove,
  clear,
  blacklistAdd,
  blacklistRemove,
};
