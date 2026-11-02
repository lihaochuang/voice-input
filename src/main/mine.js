'use strict';
// 挖热词：挖热词.py 的 JS 移植，算法一字不改（§12）。
//
// 为什么要人工确认、不自动入表：ASR 会把「留存率」听成「留存绿」，
// 把高频错词自动加进热词表，模型会更倾向输出那个错词，错得更稳。
// 正反馈一旦走反方向就自我强化，所以必须留一道人工闸。
//
// 已知取材限制，照抄、不要「顺手改进」（评审 N5）：n-gram 只在 [\u4e00-\u9fa5]{2,}
// 的纯汉字片段上统计，所以英文缩写（ASR、MACD、SKU）永远挖不出来，只能手工加。

const fs = require('fs');
const paths = require('./paths');

const MIN_COUNT = 3; // 至少说过这么多次才算候选
const MIN_LEN = 2;
const MAX_LEN = 6;
const KEEP_RATIO = 1.4; // 短词被长词包含且频次不超过长词这么多倍 → 丢弃

// 通用词和虚词，ASR 本来就认得，进热词表只会稀释真正专有名词的权重
const STOP_CHARS = new Set(
  '的了是在我你他她它这那有和就不都也要会能对吧呢啊吗把被给让从到说看想做为与及或而且但' +
    '如果因为所以可以已经还是没有一个这个那个什么怎么为什么现在然后嗯哦好麻烦辛苦收到感谢' +
    '谢谢请问帮忙一下这边那边可能应该需要您咱们我们他们你们时候问题情况目前这样那样东西'
);
const EDGE_BAD =
  /^(这|那|就|还|也|都|很|太|再|又|没|不|是|有|会|要|能|想|说|看|做|给|让|被|把|从|到|在|和|跟|或|可|如|但|而|所|因|对|我|你|他|它|一|个|上|下|中|前|后|里|些|什|怎|为)|(的|了|吧|呢|啊|吗|嘛|哦|呀|着|过|些|样|话|时|后|前|里|上|下|中|是|有|会|要|能|和|或|与|及)$/;

const HAN_SEG = /[\u4e00-\u9fa5]{2,}/g;
const DIGITS = /[0-9０-９]+/g;

/**
 * 从历史文本里挖候选词。
 * @param {string[]|{text?:string}[]} rows 历史行或纯文本数组（只取 text 非空的）
 * @param {string[]|Set<string>} knownWords 已知热词
 * @param {{minCount?:number}} [opts] minCount 默认 MIN_COUNT=3。
 *        自动入表那条路（追加需求二·四）会把它提到 5——自动加词没有人工闸，
 *        门槛必须更高，否则一次听错重复几遍就进表了。
 * @returns {{word:string,count:number}[]} 按频次降序
 */
function mine(rows = [], knownWords = [], opts = {}) {
  const minCount = Number.isInteger(opts.minCount) && opts.minCount > 0 ? opts.minCount : MIN_COUNT;
  const texts = rows.map((r) => (typeof r === 'string' ? r : r?.text)).filter(Boolean);
  const have = new Set(knownWords);
  // 先把已经认识的词从文本里挖掉，在剩下的片段上统计。
  // 不这么做会挖出大量跨词碎片（「留存率和转化」这种），
  // 因为相邻的两个已知词连在一起也是高频 n-gram。
  const known = [...have].filter((w) => w.length >= 2).sort((a, b) => b.length - a.length);

  const cnt = new Map();
  for (const raw of texts) {
    let t = raw;
    for (const w of known) t = t.split(w).join('\n');
    // 顺便让数字也当分隔符：金额、数量这类不该进热词表
    t = t.replace(DIGITS, '\n');
    for (const seg of t.match(HAN_SEG) || []) {
      for (let n = MIN_LEN; n <= MAX_LEN; n += 1) {
        for (let i = 0; i + n <= seg.length; i += 1) {
          const g = seg.slice(i, i + n);
          if ([...g].every((c) => STOP_CHARS.has(c))) continue;
          cnt.set(g, (cnt.get(g) || 0) + 1);
        }
      }
    }
  }

  // 长词优先，砍掉被长词包含且频次没明显更高的碎片
  const raw = [...cnt.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => b[0].length - a[0].length || b[1] - a[1]);
  const kept = [];
  for (const [w, c] of raw) {
    if (kept.some(([lw, kc]) => lw.includes(w) && c <= kc * KEEP_RATIO)) continue;
    kept.push([w, c]);
  }

  return kept
    .filter(([w]) => !have.has(w) && w.length >= MIN_LEN && w.length <= MAX_LEN && !EDGE_BAD.test(w))
    .sort((a, b) => b[1] - a[1])
    .map(([word, count]) => ({ word, count }));
}

/** 候选写到 待确认热词.txt，顶部保留原脚本那段「错词也会高频出现」的警告。 */
function writePending(cands, { rows = 0, chars = 0 } = {}) {
  const head = [
    `# 待确认热词 —— 从 ${rows} 条记录（${chars} 字）里挖出来的`,
    '# ',
    '# 怎么用：删掉你不要的行（尤其是识别错的词！），留下要的，',
    '#        或者直接在「设置 → 热词」里勾选并入。',
    '# ',
    '# ⚠️ 识别错的词也会高频出现。比如你说「留存率」老被听成「留存绿」，',
    '#    「留存绿」就会出现在这里。把它加进热词表会让错误固化，务必删掉。',
    '# ',
    '# 格式：词  # 出现次数',
    '',
  ].join('\n');
  const body = cands.map(({ word, count }) => `${word}  # ${count}`).join('\n');
  fs.mkdirSync(paths.dataDir(), { recursive: true });
  fs.writeFileSync(paths.pendingHotwordsPath(), `${head}\n${body}${body ? '\n' : ''}`, 'utf8');
  return paths.pendingHotwordsPath();
}

/** 把确认过的词并进 热词.txt：一行注释带当天日期，然后每 10 词一行。 */
function merge(words = []) {
  const list = words.map((w) => (typeof w === 'string' ? w : w.word)).filter(Boolean);
  if (!list.length) return { added: [], path: paths.hotwordsPath() };
  const today = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const date = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  let out = `\n# ── 自动挖掘并确认（${date}）──\n`;
  for (let i = 0; i < list.length; i += 10) out += `${list.slice(i, i + 10).join(' ')}\n`;
  fs.mkdirSync(paths.dataDir(), { recursive: true });
  fs.appendFileSync(paths.hotwordsPath(), out, 'utf8');
  return { added: list, path: paths.hotwordsPath() };
}

module.exports = { MIN_COUNT, MIN_LEN, MAX_LEN, KEEP_RATIO, STOP_CHARS, EDGE_BAD, mine, writePending, merge };
