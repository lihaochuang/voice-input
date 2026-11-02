'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { useTempDataDir } = require('./_helpers');

const paths = require('../src/main/paths');
const hotwords = require('../src/main/hotwords');

const writeHotwords = (text) => {
  fs.mkdirSync(paths.dataDir(), { recursive: true });
  fs.writeFileSync(paths.hotwordsPath(), text, 'utf8');
};

test('剥 # 注释，一行多词按空白切', () => {
  useTempDataDir();
  writeHotwords('# 注释行\n口径 复盘  迭代 # 行内注释\n\n灰度\n');
  assert.deepStrictEqual(hotwords.load(), ['口径', '复盘', '迭代', '灰度']);
});

test('改文件后再 load() 必须反映新内容（证明没有任何缓存，含 mtime 判断）', () => {
  useTempDataDir();
  writeHotwords('口径\n');
  assert.deepStrictEqual(hotwords.load(), ['口径']);
  writeHotwords('口径 埋点\n'); // 同一秒内改写，mtime 可能一样
  assert.deepStrictEqual(hotwords.load(), ['口径', '埋点'], '读到的是旧内容 → 有缓存');
  writeHotwords('取数\n');
  assert.deepStrictEqual(hotwords.load(), ['取数']);
});

test('文件缺失 → 从 热词.示例.txt 落地一份，之后读的是落地的那份', () => {
  useTempDataDir();
  assert.ok(!fs.existsSync(paths.hotwordsPath()));
  const words = hotwords.load();
  assert.ok(fs.existsSync(paths.hotwordsPath()), '没有落地 热词.txt');
  assert.ok(words.includes('留存率'), `示例里的词没读到：${words.slice(0, 5)}`);
  assert.strictEqual(fs.readFileSync(paths.hotwordsPath(), 'utf8'), fs.readFileSync(paths.sampleHotwordsPath(), 'utf8'));
});

test('空文件（或只有注释）回落内置兜底词', () => {
  useTempDataDir();
  writeHotwords('# 全是注释\n#\n');
  assert.deepStrictEqual(hotwords.load(), hotwords.DEFAULT_HOTWORDS.split(' '));
  writeHotwords('');
  assert.deepStrictEqual(hotwords.load(), hotwords.DEFAULT_HOTWORDS.split(' '));
});

test('兜底词里没有任何业务术语，只有通用词', () => {
  assert.strictEqual(hotwords.DEFAULT_HOTWORDS, '口径 复盘 迭代 灰度 埋点 取数 看板 幂等 并发');
});

test('save 整表覆盖写，且走 temp + rename 不留半截文件', () => {
  useTempDataDir();
  hotwords.save('幂等 并发\n');
  assert.deepStrictEqual(hotwords.load(), ['幂等', '并发']);
  // 自动热词是无人看着的时候整表重写用户手写的那份文件，裸 writeFileSync
  // 写一半进程死掉会留下截断内容，load() 读残文件还不报错
  assert.ok(!fs.existsSync(`${paths.hotwordsPath()}.tmp`), '临时文件要被 rename 掉，不许残留');
});

test('looksLikeContextEcho：热词表原样回显判 true', () => {
  const words = ['留存率', '转化率', '漏斗', '埋点', '灰度', '回滚', '并发', '熔断', '压测', '复盘', '口径', '看板', '幂等', '取数', '迭代'];
  assert.ok(words.join('').length >= 30, '前提：回显串要够长');
  assert.strictEqual(hotwords.looksLikeContextEcho(words.join(''), words), true);
});

test('looksLikeContextEcho：正常句子判 false', () => {
  const words = ['留存率', '转化率', '漏斗', '埋点'];
  const sentence = '我们昨天开会讨论了一下这个月的留存率怎么拆解到渠道上，先看漏斗的第二步。';
  assert.strictEqual(hotwords.looksLikeContextEcho(sentence, words), false);
});

test('looksLikeContextEcho：不足 30 字一律 false', () => {
  const words = ['口径', '复盘'];
  assert.strictEqual(hotwords.looksLikeContextEcho('口径复盘口径复盘', words), false);
  assert.strictEqual(hotwords.looksLikeContextEcho('', words), false);
});
