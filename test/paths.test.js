'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempDataDir } = require('./_helpers');

const paths = require('../src/main/paths');

test('VI_DATA_DIR 一设，所有路径都落在它底下', () => {
  const dir = useTempDataDir();
  assert.strictEqual(paths.dataDir(), dir);
  const all = [
    paths.configPath(),
    paths.configBakPath(),
    paths.credsDir(),
    paths.credPath('dashscope'),
    paths.polishKeyPath(),
    paths.hotwordsPath(),
    paths.correctionsPath(),
    paths.pendingHotwordsPath(),
    paths.historyDir(),
    paths.historyPath(new Date(2026, 10, 2)),
    paths.pendingDir(),
    paths.tmpDir(),
    paths.logDir(),
    paths.sentinelPath(),
    paths.importDonePath(),
  ];
  for (const p of all) assert.ok(p.startsWith(dir), `${p} 不在 ${dir} 底下`);
});

test('历史文件按月分，名字是 YYYY-MM.jsonl', () => {
  useTempDataDir();
  assert.strictEqual(path.basename(paths.historyPath(new Date(2026, 0, 31))), '2026-01.jsonl');
  assert.strictEqual(path.basename(paths.historyPath(new Date(2026, 10, 2))), '2026-11.jsonl');
});

test('credPath 一个后端一个文件', () => {
  useTempDataDir();
  assert.strictEqual(path.basename(paths.credPath('groq')), 'groq.enc');
  assert.notStrictEqual(paths.credPath('groq'), paths.credPath('openai'));
});

test('ensureDirs 建齐目录且幂等', () => {
  const dir = useTempDataDir();
  paths.ensureDirs();
  paths.ensureDirs();
  for (const p of [paths.credsDir(), paths.historyDir(), paths.pendingDir(), paths.tmpDir(), paths.logDir()]) {
    assert.ok(fs.statSync(p).isDirectory(), `${p} 没建出来`);
  }
  assert.ok(fs.statSync(dir).isDirectory());
});

test('示例文件在仓库根，能读到', () => {
  assert.ok(fs.existsSync(paths.sampleHotwordsPath()));
  assert.ok(fs.existsSync(paths.sampleCorrectionsPath()));
});

test('默认转录目录不在 userData 里（它是用户要用的文档）', () => {
  const dir = useTempDataDir();
  const t = paths.defaultTranscriptDir();
  assert.ok(t.endsWith('语音输入转录'));
  assert.ok(!t.startsWith(path.join(dir, '配置')));
});
