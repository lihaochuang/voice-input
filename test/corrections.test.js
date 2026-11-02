'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { useTempDataDir } = require('./_helpers');

const paths = require('../src/main/paths');
const corrections = require('../src/main/corrections');

test('parse：解析 错 => 对，忽略注释与空行', () => {
  const { rules, badLines } = corrections.parse('# 注释\n\n留存绿 => 留存率\n幂等姓 => 幂等性 # 行内注释\n');
  assert.deepStrictEqual(rules, [
    { from: '留存绿', to: '留存率' },
    { from: '幂等姓', to: '幂等性' },
  ]);
  assert.deepStrictEqual(badLines, []);
});

test('parse：非法行跳过并回报行号（1 起）', () => {
  const { rules, badLines } = corrections.parse('好的\n留存绿 => 留存率\n=> 只有右边\n左边 =>\n');
  assert.strictEqual(rules.length, 1);
  assert.deepStrictEqual(badLines, [1, 3, 4]);
});

test('parse：规则按 from 长度降序', () => {
  const { rules } = corrections.parse('率 => 比率\n留存绿率 => 留存率\n留存绿 => 留存率\n');
  assert.deepStrictEqual(rules.map((r) => r.from), ['留存绿率', '留存绿', '率']);
});

test('apply：长 key 优先（留存绿率 不会被 留存绿 先拆掉）', () => {
  const { rules } = corrections.parse('留存绿 => 留存率\n留存绿率 => 留存率\n');
  const { text } = corrections.apply('这个月的留存绿率比上月的留存绿好', rules);
  assert.strictEqual(text, '这个月的留存率比上月的留存率好');
});

test('apply：全局替换并回报命中次数', () => {
  const { rules } = corrections.parse('幂等姓 => 幂等性\n');
  const { text, hits } = corrections.apply('幂等姓和幂等姓', rules);
  assert.strictEqual(text, '幂等性和幂等性');
  assert.deepStrictEqual(hits, [{ from: '幂等姓', to: '幂等性', count: 2 }]);
});

test('apply：没命中就原样返回，hits 为空', () => {
  const { rules } = corrections.parse('幂等姓 => 幂等性\n');
  const { text, hits } = corrections.apply('今天没说那个词', rules);
  assert.strictEqual(text, '今天没说那个词');
  assert.deepStrictEqual(hits, []);
});

test('load：文件缺失 → 从示例落地一份，且示例是空表（全注释）', () => {
  useTempDataDir();
  const { rules } = corrections.load();
  assert.ok(fs.existsSync(paths.correctionsPath()));
  assert.deepStrictEqual(rules, [], '示例里不该有生效的规则');
  const sample = fs.readFileSync(paths.correctionsPath(), 'utf8');
  assert.ok(sample.includes('用规则掩盖识别错误'), '示例必须保留那段为什么别开早的说明');
});

test('load：每次重读，改完存盘即生效', () => {
  useTempDataDir();
  fs.mkdirSync(paths.dataDir(), { recursive: true });
  fs.writeFileSync(paths.correctionsPath(), '甲 => 乙\n', 'utf8');
  assert.strictEqual(corrections.load().rules.length, 1);
  fs.writeFileSync(paths.correctionsPath(), '甲 => 乙\n丙 => 丁\n', 'utf8');
  assert.strictEqual(corrections.load().rules.length, 2);
});
