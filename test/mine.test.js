'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { useTempDataDir } = require('./_helpers');

const paths = require('../src/main/paths');
const mine = require('../src/main/mine');

const rows = (text, n) => Array.from({ length: n }, () => ({ text }));
const words = (cands) => cands.map((c) => c.word);

test('已知热词先替换成分隔符，不挖出跨词碎片', () => {
  const cands = mine.mine(rows('留存率和转化率都要看', 5), ['留存率', '转化率']);
  assert.ok(!words(cands).includes('率和转'), `挖出了跨词碎片：${words(cands)}`);
  assert.ok(!words(cands).some((w) => w.includes('率和')));
});

test('MIN_COUNT 生效：说不到 3 次的不进候选', () => {
  const twice = mine.mine(rows('调度派单成功率', 2), []);
  const thrice = mine.mine(rows('调度派单成功率', 3), []);
  assert.deepStrictEqual(twice, []);
  assert.ok(words(thrice).length > 0);
});

test('长词优先剪枝：短碎片被长词包含且频次没明显更高 → 丢弃', () => {
  const cands = mine.mine(rows('调度派单', 5), []);
  assert.ok(words(cands).includes('调度派单'));
  assert.ok(!words(cands).includes('调度派'), `没剪掉被包含的碎片：${words(cands)}`);
  assert.ok(!words(cands).includes('度派单'));
});

test('短词频次明显更高（>1.4 倍）时保留', () => {
  // 「调度」出现 6 次，包含它的长词各只 3 次：6 > 3×1.4，不该被剪
  const cands = mine.mine([...rows('调度派单', 3), ...rows('调度中心很忙', 3)], []);
  assert.ok(words(cands).includes('调度'), `高频短词被误剪：${words(cands)}`);
});

test('数字当分隔符，金额数量不进热词表', () => {
  const cands = mine.mine(rows('车辆300台要调度', 5), []);
  assert.ok(!words(cands).some((w) => /[0-9０-９]/.test(w)));
  assert.ok(!words(cands).includes('台要调'));
});

test('长度限制 2–6，纯停用字组合被排除', () => {
  const cands = mine.mine(rows('这个那个就是然后', 5), []);
  assert.deepStrictEqual(cands, []);
  for (const { word } of mine.mine(rows('城市运营配置批量下发任务', 5), [])) {
    assert.ok(word.length >= mine.MIN_LEN && word.length <= mine.MAX_LEN);
  }
});

test('首尾虚字的候选被 EDGE_BAD 排除', () => {
  const cands = mine.mine(rows('这个指派量级的', 5), []);
  for (const { word } of cands) {
    assert.ok(!/^(这|那|就|还)/.test(word), `首字是虚字：${word}`);
    assert.ok(!/(的|了|吧|呢)$/.test(word), `尾字是虚字：${word}`);
  }
});

test('只读 text 非空的行；纯字符串数组也吃', () => {
  const mixed = [{ text: '调度派单' }, { text: '' }, {}, null, '调度派单', '调度派单'];
  assert.ok(words(mine.mine(mixed, [])).includes('调度派单'));
});

test('已在热词表里的词不再作为候选', () => {
  const cands = mine.mine(rows('调度派单', 5), ['调度派单']);
  assert.ok(!words(cands).includes('调度派单'));
});

test('英文缩写挖不出来（已知取材限制，不许顺手改进）', () => {
  const cands = mine.mine(rows('这次用 ASR 做的', 5), []);
  assert.ok(!words(cands).includes('ASR'));
});

test('结果按频次降序', () => {
  const cands = mine.mine([...rows('城市运营配置', 4), ...rows('批量下发任务', 9)], []);
  for (let i = 1; i < cands.length; i += 1) assert.ok(cands[i - 1].count >= cands[i].count);
});

test('writePending 顶部保留「错词也会高频出现」的警告', () => {
  useTempDataDir();
  const p = mine.writePending([{ word: '调度派单', count: 5 }], { rows: 3, chars: 12 });
  const text = fs.readFileSync(p, 'utf8');
  assert.ok(text.includes('识别错的词也会高频出现'));
  assert.ok(text.includes('调度派单  # 5'));
});

test('merge：注释行带当天日期，然后每 10 词一行', () => {
  useTempDataDir();
  fs.mkdirSync(paths.dataDir(), { recursive: true });
  fs.writeFileSync(paths.hotwordsPath(), '原有词\n', 'utf8');
  const list = Array.from({ length: 23 }, (_, i) => `词${i}`);
  mine.merge(list);
  const lines = fs.readFileSync(paths.hotwordsPath(), 'utf8').trim().split('\n');
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.strictEqual(lines[0], '原有词', '原有内容必须留着（追加写）');
  assert.strictEqual(lines[1], '', '注释行前空一行，与原脚本一致');
  assert.strictEqual(lines[2], `# ── 自动挖掘并确认（${date}）──`);
  assert.strictEqual(lines.length, 3 + 3, '23 个词 → 3 行');
  assert.strictEqual(lines[3].split(' ').length, 10);
  assert.strictEqual(lines[5].split(' ').length, 3);
});

test('merge：空列表什么都不做', () => {
  useTempDataDir();
  fs.mkdirSync(paths.dataDir(), { recursive: true });
  fs.writeFileSync(paths.hotwordsPath(), '原有词\n', 'utf8');
  mine.merge([]);
  assert.strictEqual(fs.readFileSync(paths.hotwordsPath(), 'utf8'), '原有词\n');
});
