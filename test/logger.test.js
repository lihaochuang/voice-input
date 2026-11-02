'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempDataDir } = require('./_helpers');

const logger = require('../src/main/logger');

test('行格式是 <ISO8601>  <level>  <module>  <message>', () => {
  useTempDataDir();
  const line = logger.info('asr', '开始转写');
  assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z {2}INFO {2}asr {2}开始转写\n$/);
});

test('出口脱敏：sk- 密钥落盘后看不到原串', () => {
  useTempDataDir();
  const key = 'sk-FAKEfake0123456789'; // 纯编造的假串；真实 key 不许进测试 fixture
  logger.error('asr', `请求失败 Authorization: Bearer ${key}`);
  const text = fs.readFileSync(logger.logFile(), 'utf8');
  assert.ok(!text.includes(key), '日志里还留着原始密钥');
  assert.ok(text.includes('sk-***'));
});

test('脱敏对多个密钥、对 redact() 直接调用都生效', () => {
  assert.strictEqual(logger.redact('a sk-abcdefgh b sk-12345678_x c'), 'a sk-*** b sk-*** c');
  assert.strictEqual(logger.redact('sk-short'), 'sk-short'); // 不足 8 位的不是密钥
});

test('识别文本只记前 60 字', () => {
  const long = '字'.repeat(200);
  const p = logger.preview(long);
  assert.strictEqual(p.length, 61); // 60 字 + 省略号
  assert.ok(p.endsWith('…'));
  assert.strictEqual(logger.preview('短句'), '短句');
});

test('换行被压成一行，一条日志不会被拆成两行', () => {
  useTempDataDir();
  const line = logger.warn('paste', '第一行\n第二行');
  assert.strictEqual(line.match(/\n/g).length, 1);
});

test('超过 2MB 轮转成 app.1.log，只留两个文件', () => {
  const dir = useTempDataDir();
  fs.mkdirSync(path.dirname(logger.logFile()), { recursive: true });
  fs.writeFileSync(logger.logFile(), 'x'.repeat(logger.MAX_BYTES + 1));
  logger.info('test', '触发轮转');
  const names = fs.readdirSync(path.join(dir, '日志')).sort();
  assert.deepStrictEqual(names, ['app.1.log', 'app.log']);
  assert.ok(fs.statSync(logger.logFile()).size < 1024, '新 app.log 应该只有刚写的一行');
});
