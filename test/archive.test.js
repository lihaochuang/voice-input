'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempDataDir } = require('./_helpers');

const archive = require('../src/main/archive');

const setup = () => {
  const root = useTempDataDir();
  const dir = path.join(root, '转录');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  return { dir, tmp };
};
const mkAudio = (tmp, name) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, 'fake-audio');
  return p;
};

test('stampOf 是 yyyy-MM-dd_HHmm', () => {
  assert.strictEqual(archive.stampOf(new Date(2026, 10, 2, 13, 7, 45)), '2026-11-02_1307');
});

test('Markdown 结构：标题 + 3 行固定 + 原始音频 + --- + 全文原样', () => {
  const { dir, tmp } = setup();
  const audio = mkAudio(tmp, 'rec-1.webm');
  const text = '第一段。\n\n第二段，带  多个空格。';
  const { mdPath } = archive.save({ text, durationSec: 192, audioPath: audio, dir, stamp: '2026-11-02_1307' });
  assert.strictEqual(
    fs.readFileSync(mdPath, 'utf8'),
    ['# 录音转录 2026-11-02_1307', '', '- 时间：2026-11-02 13:07', '- 时长：3 分 12 秒', `- 字数：${[...text].length}`, '- 原始音频：2026-11-02_1307.webm', '', '---', '', text, ''].join('\n')
  );
});

test('md 里「原始音频」行的文件名与实际落盘音频名逐字相等（评审 N2）', () => {
  const { dir, tmp } = setup();
  const { mdPath, audioPath } = archive.save({
    text: '一段很长的会议记录',
    durationSec: 61,
    audioPath: mkAudio(tmp, 'rec-abc.webm'),
    dir,
    stamp: '2026-11-02_1307',
  });
  const line = fs.readFileSync(mdPath, 'utf8').split('\n').find((l) => l.startsWith('- 原始音频：'));
  const named = line.replace('- 原始音频：', '');
  assert.strictEqual(named, path.basename(audioPath));
  assert.ok(fs.existsSync(path.join(path.dirname(mdPath), named)), 'md 指向的音频文件不存在');
});

test('无音频时「原始音频」行不出现', () => {
  const { dir } = setup();
  const { mdPath, audioPath } = archive.save({ text: '没留音频', durationSec: 30, dir, stamp: '2026-11-02_1307' });
  assert.strictEqual(audioPath, null);
  assert.ok(!fs.readFileSync(mdPath, 'utf8').includes('原始音频'));
});

test('候选音频优先 webm，webm 缺失退回 WAV', () => {
  const { dir, tmp } = setup();
  const webm = path.join(tmp, 'rec-1.webm'); // 不创建，模拟 opus 缺失
  const wavPath = mkAudio(tmp, 'rec-1.wav');
  const r = archive.save({ text: '退回 WAV', durationSec: 10, audioPath: [webm, wavPath], dir, stamp: '2026-11-02_1307' });
  assert.strictEqual(path.extname(r.audioPath), '.wav');
});

test('同分钟二次归档产生 -2 而不是覆盖', () => {
  const { dir, tmp } = setup();
  const a = archive.save({ text: '第一次', durationSec: 10, audioPath: mkAudio(tmp, 'a.webm'), dir, stamp: '2026-11-02_1307' });
  const b = archive.save({ text: '第二次', durationSec: 10, audioPath: mkAudio(tmp, 'b.webm'), dir, stamp: '2026-11-02_1307' });
  assert.strictEqual(path.basename(a.mdPath), '2026-11-02_1307.md');
  assert.strictEqual(path.basename(b.mdPath), '2026-11-02_1307-2.md');
  assert.strictEqual(path.basename(b.audioPath), '2026-11-02_1307-2.webm');
  assert.strictEqual(fs.readFileSync(a.mdPath, 'utf8').includes('第一次'), true, '第一份被覆盖了');
  assert.ok(fs.readFileSync(b.mdPath, 'utf8').startsWith('# 录音转录 2026-11-02_1307-2'), '标题要跟文件名一致');
});

test('归档后 tmp 的两份都被删（复制语义，目标文件留着）', () => {
  const { dir, tmp } = setup();
  const webm = mkAudio(tmp, 'rec-1.webm');
  const wavPath = mkAudio(tmp, 'rec-1.wav');
  const r = archive.save({ text: '清理 tmp', durationSec: 10, audioPath: [webm, wavPath], dir, stamp: '2026-11-02_1307' });
  assert.strictEqual(fs.existsSync(webm), false);
  assert.strictEqual(fs.existsSync(wavPath), false);
  assert.strictEqual(fs.existsSync(r.audioPath), true);
  assert.strictEqual(fs.readdirSync(tmp).length, 0);
});

test('deleteTmp:false 时保留 tmp（补转场景要留着重试）', () => {
  const { dir, tmp } = setup();
  const webm = mkAudio(tmp, 'rec-1.webm');
  archive.save({ text: '保留 tmp', durationSec: 10, audioPath: webm, dir, stamp: '2026-11-02_1307', deleteTmp: false });
  assert.ok(fs.existsSync(webm));
});

test('缺 stamp / 缺 dir 直接抛错（stamp 必须由调用方算一次）', () => {
  const { dir } = setup();
  assert.throws(() => archive.save({ text: 'x', durationSec: 1, dir }), /stamp/);
  assert.throws(() => archive.save({ text: 'x', durationSec: 1, stamp: '2026-11-02_1307' }), /dir/);
});

test('时长不足 1 分钟与字数统计（按字符数，不是字节）', () => {
  const { dir } = setup();
  const { mdPath } = archive.save({ text: 'abc中文', durationSec: 7.4, dir, stamp: '2026-11-02_1307' });
  const md = fs.readFileSync(mdPath, 'utf8');
  assert.ok(md.includes('- 时长：0 分 7 秒'));
  assert.ok(md.includes('- 字数：5'));
});
