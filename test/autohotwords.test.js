'use strict';
// 热词自动提炼（设计决策.md 追加需求二·四）。
//
// 这个功能的风险是**错误自我强化**：ASR 把「客单价」听成「课单价」，
// 「课单价」成了高频词，自动入表后模型更倾向输出错词。
// 所以本文件盯的不是「能不能自动加词」，而是五道对冲是不是真的在：
// 更高的门槛、独立分段、台账、黑名单、以及「用户手写的热词一个字都不许动」。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { useTempDataDir } = require('./_helpers');

useTempDataDir();
const auto = require('../src/main/autohotwords');
const hotwords = require('../src/main/hotwords');
const mine = require('../src/main/mine');
const paths = require('../src/main/paths');

const { SECTION_BEGIN, SECTION_END, DEFAULT_MIN_COUNT, MAX_PER_RUN } = auto;

/** 每个用例一套干净的数据目录。 */
function reset(hotwordText = '# 我自己写的\n口径 复盘 迭代\n') {
  useTempDataDir();
  fs.mkdirSync(paths.dataDir(), { recursive: true });
  hotwords.save(hotwordText);
  fs.rmSync(auto.ledgerPath(), { force: true });
}

// 每条历史的上下文都不一样，只有目标词重复——真实历史就是这样。
// ⚠ 不要用同一句固定 filler 造 n 条：那样「filler+词」的长 n-gram 和词本身同频，
// 长词优先的剪枝会留下「边看一下出单」这种跨词碎片，词本身反而被丢掉。
// 这不是 bug，是 mine 的既有行为（照抄挖热词.py），测试素材得像真的。
const CONTEXT = [
  ['昨天复盘的时候提到', '这个指标'],
  ['我看了一下', '，比上周好一些'],
  ['他问我', '到底怎么算'],
  ['数据里', '有点异常'],
  ['下周要把', '拆到网格'],
  ['那张看板上', '的口径不一致'],
  ['先确认', '的分母是什么'],
  ['会上说', '要重新定义'],
];

/** 造 n 条都提到 word 的历史文本，上下文逐条不同。 */
const rowsSaying = (word, n) =>
  Array.from({ length: n }, (_, i) => {
    const [a, b] = CONTEXT[i % CONTEXT.length];
    return `${a}${word}${b}。`;
  });

// ───────────────── 门槛（对冲①） ─────────────────

test('门槛默认 5，比手动挖词的 MIN_COUNT=3 严', () => {
  assert.strictEqual(DEFAULT_MIN_COUNT, 5);
  assert.ok(DEFAULT_MIN_COUNT > mine.MIN_COUNT);
});

test('出现 4 次不收，5 次才收', () => {
  reset();
  const r4 = auto.runOnce({ rows: rowsSaying('客单价', 4) });
  assert.deepStrictEqual(r4.added, [], '4 次没到阈值');
  reset();
  const r5 = auto.runOnce({ rows: rowsSaying('客单价', 5) });
  assert.ok(r5.added.some((w) => w.word === '客单价'), `5 次该收：${JSON.stringify(r5.added)}`);
});

test('mine 的 minCount 参数真的透传下去了', () => {
  const rows = rowsSaying('客单价', 4);
  assert.ok(mine.mine(rows, [], { minCount: 3 }).some((c) => c.word === '客单价'));
  assert.ok(!mine.mine(rows, [], { minCount: 5 }).some((c) => c.word === '客单价'));
  // 不传时仍是原来的 3（手动那条路的行为一个字没改）
  assert.ok(mine.mine(rows, []).some((c) => c.word === '客单价'));
});

test('阈值可配：传 3 就按 3 收', () => {
  reset();
  const r = auto.runOnce({ rows: rowsSaying('客单价', 3), minCount: 3 });
  assert.ok(r.added.some((w) => w.word === '客单价'));
});

// ───────────────── 独立分段（对冲②） ─────────────────

test('自动加的词写在独立分段里，用户手写的部分一个字不动', () => {
  reset('# 我自己写的\n口径 复盘 迭代\n');
  auto.runOnce({ rows: rowsSaying('客单价', 6) });
  const text = hotwords.loadRaw();
  assert.match(text, /# 我自己写的/, '用户的注释还在');
  assert.match(text, /口径 复盘 迭代/, '用户的词还在');
  assert.ok(text.includes(SECTION_BEGIN) && text.includes(SECTION_END), '要有分段标记');
  // 自动的词只在分段里，不混进用户那几行
  const userPart = text.slice(0, text.indexOf(SECTION_BEGIN));
  assert.ok(!userPart.includes('客单价'));
  assert.ok(auto.wordsInAutoSection(text).includes('客单价'));
});

test('分段带添加日期，便于整段回滚', () => {
  reset();
  auto.runOnce({ rows: rowsSaying('客单价', 6), now: new Date('2026-11-02T10:00:00') });
  assert.match(hotwords.loadRaw(), /# ── 2026-11-02 自动添加 \d+ 个 ──/);
});

test('splitSections / renderWithAuto 是纯函数，没有分段时原样返回', () => {
  const plain = '# 注释\n口径 复盘\n';
  const s = auto.splitSections(plain);
  assert.deepStrictEqual(s.auto, []);
  assert.deepStrictEqual(auto.wordsInAutoSection(plain), []);
  // 台账为空 → 整个分段连标记一起消失，文件回到没开过这功能的样子
  const withAuto = auto.renderWithAuto(plain, [{ word: '客单价', count: 9, addedAt: Date.now() }]);
  assert.ok(withAuto.includes(SECTION_BEGIN));
  const back = auto.renderWithAuto(withAuto, []);
  assert.ok(!back.includes(SECTION_BEGIN), '清空后不该留空壳分段');
  assert.match(back, /# 注释/);
  assert.match(back, /口径 复盘/);
});

test('第二次提炼不重复写已经加过的词', () => {
  reset();
  const first = auto.runOnce({ rows: rowsSaying('客单价', 8) });
  assert.ok(first.added.length > 0);
  const second = auto.runOnce({ rows: rowsSaying('客单价', 8) });
  assert.ok(!second.added.some((w) => w.word === '客单价'), '同一个词不该加两遍');
  const occurrences = hotwords.loadRaw().split('客单价').length - 1;
  assert.strictEqual(occurrences, 1);
});

test('一次最多加 MAX_PER_RUN 个，历史暴增也不会灌几百个进去', () => {
  reset();
  const rows = [];
  // 造 30 个互不相干的三字词，每个说 6 遍
  const a = '出留转承渗复召沉拉激唤转裂留召';
  const b = '单存化载透购回默新活醒介变存回';
  const c = '率率率率率率率率率率率率率率';
  for (let i = 0; i < a.length; i += 1) {
    for (const w of [`${a[i]}${b[i]}${c[i]}`, `${a[i]}${b[i]}值`]) rows.push(...rowsSaying(w, 6));
  }
  const r = auto.runOnce({ rows });
  assert.ok(r.added.length > 0, '总得挖出点东西来');
  assert.ok(r.added.length <= MAX_PER_RUN, `加了 ${r.added.length} 个，上限 ${MAX_PER_RUN}`);
  assert.ok(r.candidates > r.added.length, '候选应该比实际加的多，说明上限真的在截');
});

// ───────────────── 台账与移除（对冲③） ─────────────────

test('台账记下来源次数与添加时间，列表给界面用', () => {
  reset();
  const at = new Date('2026-11-02T10:00:00');
  auto.runOnce({ rows: rowsSaying('客单价', 7), now: at });
  const l = auto.list();
  const w = l.words.find((x) => x.word === '客单价');
  assert.ok(w, '台账里要有这个词');
  assert.strictEqual(typeof w.count, 'number');
  assert.ok(w.count >= 5, '来源次数要记真实值');
  assert.strictEqual(w.addedAt, at.getTime());
  assert.ok(l.inFile.includes('客单价'), 'list 要能对照文件里的现状');
  assert.strictEqual(l.lastRunAt, at.getTime());
});

test('单个移除：从台账和热词文件里一起消失', () => {
  reset();
  auto.runOnce({ rows: [...rowsSaying('客单价', 6), ...rowsSaying('留存率', 6)] });
  const before = auto.list().words.map((w) => w.word);
  assert.ok(before.includes('客单价'));
  auto.remove('客单价');
  assert.ok(!auto.list().words.some((w) => w.word === '客单价'));
  assert.ok(!auto.wordsInAutoSection(hotwords.loadRaw()).includes('客单价'));
  // 其他自动词不受影响
  if (before.includes('留存率')) assert.ok(auto.wordsInAutoSection(hotwords.loadRaw()).includes('留存率'));
});

test('批量清空：自动分段清掉，用户手写的留着', () => {
  reset('# 我的\n口径 复盘\n');
  auto.runOnce({ rows: rowsSaying('客单价', 6) });
  const r = auto.clear();
  assert.ok(r.cleared > 0);
  assert.deepStrictEqual(auto.list().words, []);
  const text = hotwords.loadRaw();
  assert.match(text, /# 我的/);
  assert.match(text, /口径 复盘/);
  assert.ok(!text.includes(SECTION_BEGIN));
  // 默认不整批拉黑：那等于永久关掉这功能的一半
  assert.deepStrictEqual(auto.list().blacklist, []);
});

// ───────────────── 黑名单（对冲④） ─────────────────

test('移除默认同时拉黑，下次提炼不会把它加回来', () => {
  reset();
  auto.runOnce({ rows: rowsSaying('课单价', 8) });
  assert.ok(auto.list().words.some((w) => w.word === '课单价'));
  const r = auto.remove('课单价');
  assert.strictEqual(r.blacklisted, true);
  assert.ok(auto.list().blacklist.includes('课单价'));
  // 这是整个功能最关键的一条：听错的词被我删过，就别再自动加回来
  const again = auto.runOnce({ rows: rowsSaying('课单价', 20) });
  assert.ok(!again.added.some((w) => w.word === '课单价'), '黑名单词绝不能被重新加入');
  assert.ok(again.skippedBlacklist.includes('课单价'));
});

test('移除时可以选择不拉黑', () => {
  reset();
  auto.runOnce({ rows: rowsSaying('客单价', 6) });
  auto.remove('客单价', { blacklist: false });
  assert.deepStrictEqual(auto.list().blacklist, []);
});

test('黑名单可以直接加、也可以解除', () => {
  reset();
  auto.blacklistAdd('课单价');
  assert.ok(auto.list().blacklist.includes('课单价'));
  const r = auto.runOnce({ rows: rowsSaying('课单价', 10) });
  assert.ok(!r.added.some((w) => w.word === '课单价'));
  auto.blacklistRemove('课单价');
  assert.ok(!auto.list().blacklist.includes('课单价'));
  const r2 = auto.runOnce({ rows: rowsSaying('课单价', 10) });
  assert.ok(r2.added.some((w) => w.word === '课单价'), '解除黑名单后应该能被加进来');
});

// ───────────────── 频率与调度 ─────────────────

test('dueNow：off 永不跑；没跑过就立刻跑；到期才跑', () => {
  const now = Date.parse('2026-11-02T00:00:00Z');
  assert.strictEqual(auto.dueNow({ freq: 'off', lastRunAt: 0, now }), false);
  assert.strictEqual(auto.dueNow({ freq: 'weekly', lastRunAt: 0, now }), true, '没跑过要跑一次');
  assert.strictEqual(auto.dueNow({ freq: 'weekly', lastRunAt: now - 6 * 86400000, now }), false);
  assert.strictEqual(auto.dueNow({ freq: 'weekly', lastRunAt: now - 8 * 86400000, now }), true);
  assert.strictEqual(auto.dueNow({ freq: 'monthly', lastRunAt: now - 10 * 86400000, now }), false);
  assert.strictEqual(auto.dueNow({ freq: 'monthly', lastRunAt: now - 31 * 86400000, now }), true);
  // 未知频率按 weekly 兜底，不要变成「永不跑」
  assert.strictEqual(auto.dueNow({ freq: '每天', lastRunAt: 0, now }), true);
});

test('跑完就记 lastRunAt，哪怕一个词都没加（否则会每次都重算一遍）', () => {
  reset();
  const at = new Date('2026-11-02T10:00:00');
  const r = auto.runOnce({ rows: ['就这么一句话'], now: at });
  assert.deepStrictEqual(r.added, []);
  assert.strictEqual(auto.loadLedger().lastRunAt, at.getTime());
});

// ───────────────── 健壮性 ─────────────────

test('台账文件坏掉 → 按空台账继续，不抛错（热词.txt 才是事实源）', () => {
  reset();
  fs.writeFileSync(auto.ledgerPath(), '{这不是 JSON', 'utf8');
  const l = auto.loadLedger();
  assert.deepStrictEqual(l, { words: [], blacklist: [], lastRunAt: 0 });
  assert.doesNotThrow(() => auto.runOnce({ rows: rowsSaying('客单价', 6) }));
});

test('已经在用户手写部分里的词不会被当候选再加一遍', () => {
  reset('# 我的\n客单价 口径\n');
  const r = auto.runOnce({ rows: rowsSaying('客单价', 20) });
  assert.ok(!r.added.some((w) => w.word === '客单价'), '已知热词不该进候选');
});

test('提炼仍然先剔除已知热词再 n-gram（不然挖出来全是跨词碎片）', () => {
  const src = fs.readFileSync(`${__dirname}/../src/main/mine.js`, 'utf8');
  assert.match(src, /for \(const w of known\) t = t\.split\(w\)\.join/);
  // autohotwords 不许自己另写一套算法
  const a = fs.readFileSync(`${__dirname}/../src/main/autohotwords.js`, 'utf8');
  assert.match(a, /mine\.mine\(/);
  assert.doesNotMatch(a.replace(/\/\/.*$/gm, ''), /n-?gram.*=|\\u4e00/);
});
