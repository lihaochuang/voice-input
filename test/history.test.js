'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempDataDir } = require('./_helpers');

const paths = require('../src/main/paths');
const history = require('../src/main/history');

const row = (over = {}) => ({ mode: '短输入', dur: 4.26, peak: 8123, rms: 1204, text: '先把口径对齐', provider: 'dashscope', ...over });

test('写入行的字段名与顺序与 asr_shim.py 逐字一致，t 是秒精度', () => {
  useTempDataDir();
  const file = history.append(row());
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.deepStrictEqual(Object.keys(parsed), ['t', 'mode', 'dur', 'peak', 'rms', 'text', 'provider']);
  assert.match(parsed.t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, '不许有毫秒和时区后缀');
  assert.strictEqual(parsed.dur, 4.3, 'dur 保留 1 位小数');
  assert.strictEqual(parsed.provider, 'dashscope');
  assert.strictEqual(path.basename(file), path.basename(paths.historyPath()), '必须写进当月文件');
});

test('dur 传 null / undefined 都写成 null（老数据有 null）', () => {
  useTempDataDir();
  history.append(row({ dur: null }));
  history.append(row({ dur: undefined }));
  const lines = fs.readFileSync(paths.historyPath(), 'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(lines[0].dur, null);
  assert.strictEqual(lines[1].dur, null);
});

test('没有 provider 时不写这个键（旧格式兼容）', () => {
  useTempDataDir();
  const file = history.append(row({ provider: undefined }));
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.ok(!('provider' in parsed));
});

test('listRecent：新的在前，中间插一行坏 JSON 后其他行仍读得出', () => {
  const dir = useTempDataDir();
  fs.mkdirSync(paths.historyDir(), { recursive: true });
  const file = paths.historyPath();
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ t: '2026-11-01T10:00:00', mode: '短输入', dur: 1.1, peak: 900, rms: 100, text: '第一条' }),
      '{这行是坏的',
      JSON.stringify({ t: '2026-11-01T10:01:00', mode: '长录音', dur: null, peak: 900, rms: 100, text: '第二条', provider: 'groq' }),
      '',
    ].join('\n'),
    'utf8'
  );
  const rows = history.listRecent(10);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].text, '第二条');
  assert.strictEqual(rows[0].provider, 'groq');
  assert.ok(dir);
});

test('listRecent：缺 provider 的旧行读出「未知」，dur:null 原样留着给渲染侧判', () => {
  useTempDataDir();
  fs.mkdirSync(paths.historyDir(), { recursive: true });
  fs.writeFileSync(
    paths.historyPath(),
    `${JSON.stringify({ t: '2026-11-01T10:00:00', mode: '短输入', dur: null, peak: 1, rms: 1, text: '旧行' })}\n`,
    'utf8'
  );
  const [r] = history.listRecent(1);
  assert.strictEqual(r.provider, '未知');
  assert.strictEqual(r.dur, null);
  assert.doesNotThrow(() => (r.dur === null ? '—' : r.dur.toFixed(1)));
});

test('listRecent：n 限制生效，跨月也能凑够', () => {
  useTempDataDir();
  fs.mkdirSync(paths.historyDir(), { recursive: true });
  const mk = (ym, n) =>
    fs.writeFileSync(
      path.join(paths.historyDir(), `${ym}.jsonl`),
      Array.from({ length: n }, (_, i) => JSON.stringify({ t: `${ym}-01T10:00:0${i}`, mode: '短输入', dur: 1, peak: 1, rms: 1, text: `${ym}#${i}` })).join('\n') + '\n',
      'utf8'
    );
  mk('2026-09', 2);
  mk('2026-10', 2);
  const rows = history.listRecent(3);
  assert.strictEqual(rows.length, 3);
  assert.ok(rows[0].text.startsWith('2026-10'), '最新月份要排在前面');
  assert.strictEqual(rows.at(-1).text.startsWith('2026-09'), true);
});

test('allTexts：只取 text 非空的行，旧的在前', () => {
  useTempDataDir();
  fs.mkdirSync(paths.historyDir(), { recursive: true });
  fs.writeFileSync(
    paths.historyPath(),
    [
      JSON.stringify({ t: '2026-11-01T10:00:00', mode: '短输入', dur: 1, peak: 1, rms: 1, text: '甲' }),
      JSON.stringify({ t: '2026-11-01T10:00:01', mode: '短输入', dur: 1, peak: 1, rms: 1, text: '' }),
      JSON.stringify({ t: '2026-11-01T10:00:02', mode: '短输入', dur: 1, peak: 1, rms: 1, text: '乙' }),
    ].join('\n') + '\n',
    'utf8'
  );
  assert.deepStrictEqual(history.allTexts(), ['甲', '乙']);
});

test('prune：只删过期月份，当月永不删；≤0 视为不清理', () => {
  useTempDataDir();
  fs.mkdirSync(paths.historyDir(), { recursive: true });
  const now = new Date();
  const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const old = new Date(now.getFullYear() - 1, now.getMonth(), 1);
  for (const name of [`${ym(now)}.jsonl`, `${ym(old)}.jsonl`, '不是历史.txt']) {
    fs.writeFileSync(path.join(paths.historyDir(), name), '{}\n', 'utf8');
  }
  assert.deepStrictEqual(history.prune(0), []);
  assert.deepStrictEqual(history.prune(-1), []);
  const removed = history.prune(90);
  assert.deepStrictEqual(removed, [`${ym(old)}.jsonl`]);
  assert.ok(fs.existsSync(path.join(paths.historyDir(), `${ym(now)}.jsonl`)), '当月文件被删了');
  assert.ok(fs.existsSync(path.join(paths.historyDir(), '不是历史.txt')), '不该碰非历史文件');
});
