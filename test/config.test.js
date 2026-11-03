'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { useTempDataDir } = require('./_helpers');

const paths = require('../src/main/paths');
const config = require('../src/main/config');

const write = (obj) => {
  fs.mkdirSync(paths.dataDir(), { recursive: true });
  fs.writeFileSync(paths.configPath(), typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
};

test('默认值覆盖 §10.4 的全部字段', () => {
  useTempDataDir();
  const d = config.defaults();
  assert.deepStrictEqual(
    Object.keys(d).sort(),
    ['cooldownMs', 'polish', 'providers', 'watch', '已提示赞助', '口语清理', '历史保留天数', '开机自启', '记录历史', '热键', '热词自动提炼', '转录目录'].sort()
  );
  assert.strictEqual(d.历史保留天数, 90);
  assert.strictEqual(d.cooldownMs, 300000);
  assert.strictEqual(d.热键.模式, 'single');
  assert.strictEqual(d.polish.model, 'qwen-flash');
  assert.strictEqual(d.watch.intervalSec, 5);
  assert.strictEqual(d.providers.length, 5);
  // 自动提炼的阈值默认 5，比手动挖词的 MIN_COUNT=3 严：自动入表没有人工闸
  assert.deepStrictEqual(d.热词自动提炼, { 开启: true, 频率: 'weekly', 阈值: 5 });
});

test('热词自动提炼：频率是封闭枚举，阈值越界回退', () => {
  useTempDataDir();
  for (const f of ['weekly', 'monthly', 'off']) {
    assert.strictEqual(config.validate({ 热词自动提炼: { 频率: f } }).value.热词自动提炼.频率, f);
  }
  const bad = config.validate({ 热词自动提炼: { 频率: '每天', 阈值: 1, 开启: 'yes' } });
  assert.strictEqual(bad.value.热词自动提炼.频率, 'weekly');
  assert.strictEqual(bad.value.热词自动提炼.阈值, 5, '阈值下限 2，1 要回退');
  assert.strictEqual(bad.value.热词自动提炼.开启, true);
  assert.strictEqual(bad.warnings.length, 3);
  // 只写一个键，另两个取默认（按字段粒度合并）
  const one = config.validate({ 热词自动提炼: { 开启: false } }).value.热词自动提炼;
  assert.deepStrictEqual(one, { 开启: false, 频率: 'weekly', 阈值: 5 });
});

test('单字段非法只回退该字段，其他用户值保留', () => {
  useTempDataDir();
  const { value, warnings } = config.validate({ 历史保留天数: 99999, 记录历史: false, cooldownMs: 120000 });
  assert.strictEqual(value.历史保留天数, 90, '非法值应回退默认');
  assert.strictEqual(value.记录历史, false, '合法的用户值被连坐回退了');
  assert.strictEqual(value.cooldownMs, 120000);
  assert.ok(warnings.some((w) => w.includes('历史保留天数')));
  assert.strictEqual(warnings.length, 1, '只该为非法字段记一条 warn');
});

test('嵌套对象按字段粒度合并：只写了 热键.模式，另两个键取默认', () => {
  useTempDataDir();
  const { value } = config.validate({ 热键: { 模式: 'combo' } });
  assert.strictEqual(value.热键.模式, 'combo');
  assert.strictEqual(value.热键.短输入, 'Control+Shift+Space');
  assert.strictEqual(value.热键.长录音, 'Control+Shift+L');
});

test('热键.模式 未知值回退 single', () => {
  useTempDataDir();
  const { value, warnings } = config.validate({ 热键: { 模式: 'magic' } });
  assert.strictEqual(value.热键.模式, 'single');
  assert.ok(warnings.some((w) => w.includes('热键.模式')));
});

test('单键键位默认值 = keycodes.defaultsFor(当前平台)', () => {
  useTempDataDir();
  const keycodes = require('../src/main/keycodes');
  const d = keycodes.defaultsFor(process.platform);
  const def = config.defaults();
  assert.strictEqual(def.热键.单键短输入, d.short);
  assert.strictEqual(def.热键.单键长录音, d.long);
});

test('单键键位非法（非整数 / 负数 / 黑名单键）→ 回退默认并记 warn', () => {
  useTempDataDir();
  const def = config.defaults();
  for (const bad of ['3640', 3640.5, -1, 0, 99999999, 30 /* 字母 A，黑名单 */]) {
    const { value, warnings } = config.validate({ 热键: { 单键短输入: bad } });
    assert.strictEqual(value.热键.单键短输入, def.热键.单键短输入, `${bad} 没回退`);
    assert.ok(warnings.some((w) => w.includes('热键.单键短输入')), `${bad} 没记 warn`);
  }
});

test('两个单键键位相同 → 单键长录音 回退默认并记 warn（规则 b 的最后一道防线）', () => {
  useTempDataDir();
  const def = config.defaults();
  const { value, warnings } = config.validate({ 热键: { 单键短输入: 91, 单键长录音: 91 } });
  assert.strictEqual(value.热键.单键短输入, 91, '短输入是合法值，不该被连坐');
  assert.strictEqual(value.热键.单键长录音, def.热键.单键长录音);
  assert.ok(warnings.some((w) => w.includes('单键长录音')));
});

test('合法单键键位原样保留，且不影响 模式/短输入/长录音 三个老字段', () => {
  useTempDataDir();
  const { value, warnings } = config.validate({ 热键: { 单键短输入: 91, 单键长录音: 92 } });
  assert.strictEqual(value.热键.单键短输入, 91);
  assert.strictEqual(value.热键.单键长录音, 92);
  assert.strictEqual(value.热键.模式, 'single');
  assert.strictEqual(value.热键.短输入, 'Control+Shift+Space');
  assert.strictEqual(value.热键.长录音, 'Control+Shift+L');
  assert.deepStrictEqual(warnings, []);
});

test('providers 塞未知 id + 重复 id，结果仍是五个 id 的全排列', () => {
  useTempDataDir();
  const { value } = config.validate({
    providers: [
      { id: 'openai', enabled: false },
      { id: 'openai', enabled: true },
      { id: 'mystery', enabled: true },
      { id: 'dashscope' },
    ],
  });
  assert.deepStrictEqual(value.providers.map((p) => p.id), ['openai', 'dashscope', 'groq', 'custom', 'whispercpp']);
  assert.strictEqual(value.providers[0].enabled, false, '保留的应该是第一条，重复项丢弃');
});

test('providers 字段级校验：maxSeconds 越界回退、baseUrl 要 https 或本地回环', () => {
  useTempDataDir();
  const { value } = config.validate({
    providers: [
      { id: 'custom', baseUrl: 'http://evil.com', model: '坏模型名', maxSeconds: 99999 },
      { id: 'whispercpp', mode: 'server', serverUrl: 'http://127.0.0.1:8080/v1', maxSeconds: 3600 },
    ],
  });
  const custom = value.providers.find((p) => p.id === 'custom');
  assert.strictEqual(custom.baseUrl, '');
  assert.strictEqual(custom.model, '');
  assert.strictEqual(custom.maxSeconds, undefined, '越界的 maxSeconds 不该落进配置');
  const wc = value.providers.find((p) => p.id === 'whispercpp');
  assert.strictEqual(wc.serverUrl, 'http://127.0.0.1:8080/v1', '本地回环必须允许 http');
  assert.strictEqual(wc.maxSeconds, 3600);
});

test('polish.baseUrl 保存前归一化成不含 /v1 的 base', () => {
  useTempDataDir();
  const { value } = config.validate({ polish: { baseUrl: 'https://x.com/v1/chat/completions' } });
  assert.strictEqual(value.polish.baseUrl, 'https://x.com');
  assert.strictEqual(value.polish.model, 'qwen-flash');
});

test('坏 JSON → 改名 配置.json.bak 且返回默认值', () => {
  useTempDataDir();
  write('{这不是 JSON');
  const cfg = config.load();
  assert.strictEqual(cfg.历史保留天数, 90);
  assert.ok(fs.existsSync(paths.configBakPath()), '坏文件没改名成 配置.json.bak');
  assert.ok(!fs.existsSync(paths.configPath()));
});

test('配置是数组/字符串这类非对象 → 整体默认', () => {
  useTempDataDir();
  assert.strictEqual(config.validate([1, 2]).value.记录历史, true);
  assert.strictEqual(config.validate('x').value.cooldownMs, 300000);
});

test('load 读得回用户值；save 落盘后再 load 一致', () => {
  useTempDataDir();
  write({ 记录历史: false, 热键: { 短输入: 'Control+Alt+Z' } });
  const loaded = config.load();
  assert.strictEqual(loaded.记录历史, false);
  assert.strictEqual(loaded.热键.短输入, 'Control+Alt+Z');
  const saved = config.save({ 口语清理: true, 热键: { 模式: 'combo' } });
  assert.strictEqual(saved.口语清理, true);
  const again = config.load();
  assert.strictEqual(again.口语清理, true);
  assert.strictEqual(again.热键.模式, 'combo');
  assert.strictEqual(again.热键.短输入, 'Control+Alt+Z', 'save 的 patch 不该冲掉其他键');
});

test('配置里不许出现任何像 key 的字段', () => {
  useTempDataDir();
  const text = JSON.stringify(config.defaults());
  assert.ok(!/apiKey|api_key|secret|token|sk-/i.test(text));
});
