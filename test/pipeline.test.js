'use strict';
// pipeline 是唯一调用顺序事实源，所以这里测的主要是**顺序**本身。
// 依赖全注入，一个 calls 数组记录调用序列。
const test = require('node:test');
const assert = require('node:assert');

const { useTempDataDir, sine, constant } = require('./_helpers');
const wav = require('../src/main/wav');
const pipeline = require('../src/main/pipeline');

useTempDataDir();

/** 造一套可观测的假依赖。 */
function mkDeps(over = {}) {
  const calls = [];
  const state = { pendingFiles: new Set(), sidecar: {} };
  const rec = (name, fn) => (...args) => { calls.push(name); return fn ? fn(...args) : undefined; };

  const deps = {
    calls,
    state,
    collect: rec('collect', async () => ({
      wavPath: '/tmp/rec-x.wav',
      webmPath: '/tmp/rec-x.webm',
      opus: Buffer.from('op'),
      pcm: sine(2),
      durationSec: 2,
      chunkCount: 8,
    })),
    levels: wav.levels,
    isSilent: wav.isSilent,
    stash: rec('stash', (sessionId, meta) => {
      const p = { id: 'p1', wavPath: '/待处理/p1.wav', jsonPath: '/待处理/p1.json', meta };
      state.pendingFiles.add(p.wavPath);
      return p;
    }),
    transcribe: rec('transcribe', async () => ({ text: '这是识别原文', providerId: 'dashscope', switched: false })),
    loadHotwords: () => ['客单价', '毛利率'],
    looksLikeContextEcho: rec('echo-check', () => false),
    appendHistory: rec('appendHistory', (row) => { state.historyRow = row; return '/历史/x.jsonl'; }),
    loadCorrections: () => ({ rules: [{ from: '识别原文', to: '纠错后' }], badLines: [] }),
    applyCorrections: rec('applyCorrections', (t, rules) => ({
      text: rules.reduce((s, r) => s.split(r.from).join(r.to), t),
      hits: [],
    })),
    polish: rec('polish', async (t) => ({ text: `${t}（清理过）`, changed: true, reason: '' })),
    polishKey: () => 'fake',
    deliver: rec('deliver', async (t) => { state.clipboard = t; return { clipboard: true, pasted: true }; }),
    archiveSave: rec('archiveSave', ({ text }) => { state.archived = text; return { mdPath: '/转录/x.md' }; }),
    stampOf: () => '2026-11-02_1530',
    transcriptDir: () => '/转录',
    cleanupTmp: rec('cleanupTmp', (sessionId, outcome, meta) => {
      state.outcome = outcome;
      state.cleanupMeta = meta;
      if (outcome === 'success' && meta.pending) state.pendingFiles.delete(meta.pending.wavPath);
      if (outcome === 'echo' && meta.pending) state.sidecar[meta.pending.wavPath] = { reason: 'echo' };
    }),
    log: { info() {}, warn() {}, error() {}, debug() {} },
  };
  return Object.assign(deps, over);
}

const run = (deps, o = {}) => pipeline.run({
  sessionId: 'x',
  mode: '短输入',
  cfg: { 口语清理: true, 记录历史: true },
  durationSec: 2,
  deps,
  ...o,
});

test('调用顺序：落盘 → ASR → 写历史 → 纠错 → 清理 → 剪贴板/粘贴 → 删暂存', async () => {
  const deps = mkDeps();
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'success');
  const order = deps.calls.filter((c) => c !== 'echo-check' && c !== 'collect');
  assert.deepStrictEqual(order, [
    'stash', 'transcribe', 'appendHistory', 'applyCorrections', 'polish', 'deliver', 'cleanupTmp',
  ]);
});

test('历史里存的是 ASR 原文（纠错、清理之前，不变量 4）', async () => {
  const deps = mkDeps();
  await run(deps);
  assert.strictEqual(deps.state.historyRow.text, '这是识别原文');
  assert.strictEqual(deps.state.clipboard, '这是纠错后（清理过）');
});

test('ASR 抛错时暂存文件未被删', async () => {
  const deps = mkDeps({
    transcribe: async () => { const e = new Error('全链失败'); e.kind = 'net'; throw e; },
  });
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'failed');
  assert.strictEqual(deps.state.pendingFiles.size, 1, '识别失败绝不许删音频');
  assert.strictEqual(deps.state.outcome, 'failed');
  assert.ok(deps.calls.includes('cleanupTmp'), 'finally 必须被执行');
});

test('清理被弃用时写进剪贴板的是原文（polish 内部保证返回原文）', async () => {
  const deps = mkDeps({
    polish: async (t) => ({ text: t, changed: false, reason: '非子序列，已弃用' }),
  });
  await run(deps);
  assert.strictEqual(deps.state.clipboard, '这是纠错后');
});

test('静音时 ASR mock 调用次数为 0（不发请求、不写历史）', async () => {
  let asrCalls = 0;
  let historyCalls = 0;
  const deps = mkDeps({
    collect: async () => ({ wavPath: '/tmp/a.wav', opus: null, pcm: constant(2, 0), durationSec: 2, chunkCount: 8 }),
    transcribe: async () => { asrCalls += 1; return { text: 'x' }; },
    appendHistory: () => { historyCalls += 1; },
  });
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'silent');
  assert.strictEqual(asrCalls, 0);
  assert.strictEqual(historyCalls, 0);
  assert.ok(!deps.calls.includes('stash'), '静音连落盘都不做，直接走 cleanupTmp 删掉');
  assert.strictEqual(deps.state.outcome, 'silent');
});

test('静音判据用 wav.isSilent，直流偏置也要判成静音', async () => {
  const deps = mkDeps({
    collect: async () => ({ pcm: constant(2, 3000), durationSec: 2, chunkCount: 8, opus: null }),
  });
  assert.strictEqual((await run(deps)).outcome, 'silent');
});

test("mode='长录音' 且 口语清理=true 时 polish 调用次数为 0（不变量 17）", async () => {
  let polishCalls = 0;
  const deps = mkDeps({ polish: async (t) => { polishCalls += 1; return { text: t }; } });
  const r = await run(deps, { mode: '长录音' });
  assert.strictEqual(r.outcome, 'success');
  assert.strictEqual(polishCalls, 0, '长录音一律跳过清理，不看配置');
  assert.strictEqual(deps.state.archived, '这是纠错后');
});

test('补转路径 polish 调用次数同为 0', async () => {
  let polishCalls = 0;
  const deps = mkDeps({ polish: async (t) => { polishCalls += 1; return { text: t }; } });
  await run(deps, { isRetry: true });
  assert.strictEqual(polishCalls, 0);
});

test('shouldPolish：三条件同时成立才做', () => {
  const t = (mode, 口语清理, isRetry) => pipeline.shouldPolish({ mode, cfg: { 口语清理 }, isRetry });
  assert.strictEqual(t('短输入', true, false), true);
  assert.strictEqual(t('短输入', false, false), false);
  assert.strictEqual(t('短输入', true, true), false);
  assert.strictEqual(t('长录音', true, false), false);
  assert.strictEqual(pipeline.shouldPolish({ mode: '短输入', cfg: undefined, isRetry: false }), false);
});

test('回显命中时暂存文件仍在，且 sidecar 有 reason:echo', async () => {
  const deps = mkDeps({ looksLikeContextEcho: () => true });
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'echo');
  assert.strictEqual(r.text, '', '命中整条丢弃');
  assert.strictEqual(deps.state.pendingFiles.size, 1);
  assert.deepStrictEqual(deps.state.sidecar['/待处理/p1.wav'], { reason: 'echo' });
  assert.ok(!deps.calls.includes('appendHistory'), '丢弃的内容不进历史');
});

test('空识别结果是正常分支：不切后端、音频保留', async () => {
  const deps = mkDeps({ transcribe: async () => ({ text: '   ', providerId: 'groq' }) });
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'empty');
  assert.strictEqual(deps.state.pendingFiles.size, 1);
  assert.ok(!deps.calls.includes('deliver'));
});

test('记录历史=false 时不写历史，但照常出字', async () => {
  const deps = mkDeps();
  await pipeline.run({ sessionId: 'x', mode: '短输入', cfg: { 记录历史: false }, deps });
  assert.ok(!deps.calls.includes('appendHistory'));
  assert.strictEqual(deps.state.clipboard, '这是纠错后');
});

test('写历史失败被吞掉，后续流程照跑', async () => {
  const deps = mkDeps({ appendHistory: () => { throw new Error('磁盘满'); } });
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'success');
  assert.strictEqual(deps.state.clipboard, '这是纠错后（清理过）');
});

test('只有 opus 没有 PCM：跳过静音拦截直接上传，录音 >1 秒时报 error', async () => {
  const warned = [];
  const deps = mkDeps({
    collect: async () => ({ wavPath: null, opus: Buffer.from('op'), pcm: null, durationSec: 3, chunkCount: 0 }),
    tray: { busy() {}, ok() {}, copied() {}, silent() {}, warn: (m) => warned.push(m) },
  });
  const r = await run(deps);
  assert.strictEqual(r.outcome, 'success', '宁可多花一次钱，不能把用户说的话丢掉');
  assert.ok(deps.calls.includes('transcribe'));
  assert.deepStrictEqual(warned, ['录音采集异常，请查看日志'], '§15-42：零块不许只记 warn');
});

test('PCM 零块但录音 <1 秒：只 warn，不报采集异常', async () => {
  const warned = [];
  const deps = mkDeps({
    collect: async () => ({ wavPath: null, opus: Buffer.from('op'), pcm: null, durationSec: 0.5, chunkCount: 0 }),
    tray: { busy() {}, ok() {}, copied() {}, silent() {}, warn: (m) => warned.push(m) },
  });
  await run(deps);
  assert.deepStrictEqual(warned, []);
});

test('短输入走 deliver，长录音走 archive，互不串台', async () => {
  const a = mkDeps();
  await run(a);
  assert.ok(a.calls.includes('deliver') && !a.calls.includes('archiveSave'));
  const b = mkDeps();
  await run(b, { mode: '长录音' });
  assert.ok(b.calls.includes('archiveSave') && !b.calls.includes('deliver'));
});

test('pasted:false 时结果里带得出来（托盘据此走 📋）', async () => {
  const deps = mkDeps({ deliver: async () => ({ clipboard: true, pasted: false, reason: 'no-ack' }) });
  const r = await run(deps);
  assert.strictEqual(r.pasted, false);
  assert.strictEqual(r.clipboard, true);
});

test('cleanupTmp 在 finally 里，哪条分支都会被调一次', async () => {
  for (const over of [
    {},
    { transcribe: async () => { throw new Error('x'); } },
    { looksLikeContextEcho: () => true },
    { collect: async () => ({ pcm: constant(1, 0), durationSec: 1, chunkCount: 4, opus: null }) },
    { collect: async () => { throw new Error('汇合炸了'); } },
  ]) {
    const deps = mkDeps(over);
    await run(deps);
    assert.strictEqual(deps.calls.filter((c) => c === 'cleanupTmp').length, 1);
  }
});

test('汇合超时常量是 3 秒，零块判 error 的阈值是 1 秒', () => {
  assert.strictEqual(pipeline.JOIN_TIMEOUT_MS, 3000);
  assert.strictEqual(pipeline.PCM_ZERO_ERROR_SEC, 1);
});

test('后端切换信息透出到返回值（不变量 14）', async () => {
  const deps = mkDeps({
    transcribe: async () => ({ text: '切过后端的结果', providerId: 'groq', switched: true }),
  });
  const r = await run(deps);
  assert.strictEqual(r.providerId, 'groq');
  assert.strictEqual(r.switched, true);
});
