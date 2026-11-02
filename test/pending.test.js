'use strict';
// 待处理队列 + §13.1 的八行清理表。
//
// 这个模块的存在理由是「现有版本曾在识别失败时删掉录音」，所以这里的断言
// 大半是在证明**该留的留住了**，而不是证明删得干净。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { useTempDataDir, sine, constant } = require('./_helpers');
const paths = require('../src/main/paths');
const wav = require('../src/main/wav');
const pending = require('../src/main/pending');

/** 新建隔离的数据目录，并造一个会话的两个 tmp 文件。 */
function fresh() {
  useTempDataDir();
  paths.ensureDirs();
  return paths.dataDir();
}

/** 造 tmp/rec-<id>.wav（头已 patch）+ tmp/rec-<id>.webm。 */
function makeSession(id, pcm, { patch = true, webm = true } = {}) {
  const w = path.join(paths.tmpDir(), `rec-${id}.wav`);
  wav.writeHeader(w);
  wav.appendPcm(w, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  if (patch) wav.patchHeader(w);
  const b = path.join(paths.tmpDir(), `rec-${id}.webm`);
  if (webm) fs.writeFileSync(b, Buffer.from('fake-webm'));
  return { wavPath: w, webmPath: b };
}

const lsTmp = () => fs.readdirSync(paths.tmpDir());
const lsPending = () => fs.readdirSync(paths.pendingDir()).sort();

test('stash：移入 待处理/ 并写 sidecar', () => {
  fresh();
  makeSession('a', sine(1));
  const r = pending.stash('a', { mode: '短输入', durationSec: 1, peak: 8000, rms: 5000 });
  assert.ok(r && fs.existsSync(r.wavPath));
  assert.ok(fs.existsSync(r.jsonPath));
  const meta = JSON.parse(fs.readFileSync(r.jsonPath, 'utf8'));
  assert.strictEqual(meta.mode, '短输入');
  assert.strictEqual(meta.peak, 8000);
  assert.ok(meta.createdAt);
  assert.ok(!fs.existsSync(path.join(paths.tmpDir(), 'rec-a.wav')), 'tmp 里那份要被移走');
});

test('stash：tmp 里没有 wav 时返回 null，不造空文件', () => {
  fresh();
  assert.strictEqual(pending.stash('nope', {}), null);
  assert.deepStrictEqual(lsPending(), []);
});

test('outcome=failed：wav 留在 待处理/，webm 已删', () => {
  fresh();
  makeSession('a', sine(2));
  const p = pending.stash('a', { mode: '短输入', durationSec: 2, peak: 8000 });
  pending.cleanupTmp('a', 'failed', { pending: p });
  assert.strictEqual(pending.count(), 1, '识别失败绝不许删音频');
  assert.ok(fs.existsSync(p.wavPath));
  assert.ok(!fs.existsSync(path.join(paths.tmpDir(), 'rec-a.webm')), 'webm 没有消费者，要删');
  assert.deepStrictEqual(lsTmp(), []);
});

test('outcome=failed：只有 webm（PCM 零块）时 webm 被移入 待处理/，绝不删掉', () => {
  fresh();
  // 没有 wav：worklet 挂了 / sink 漏接时 WAV 根本没被创建过，opus 是唯一副本
  const b = path.join(paths.tmpDir(), 'rec-a.webm');
  fs.writeFileSync(b, Buffer.from('fake-webm'));
  const r = pending.cleanupTmp('a', 'failed', { mode: '短输入', durationSec: 12, peak: 0 });
  assert.ok(r.pending, '必须补做移入，不能无条件删 webm');
  assert.strictEqual(r.pending.ext, 'webm');
  assert.strictEqual(r.pending.wavPath, null, 'webm 条目不许冒充 wav');
  assert.strictEqual(pending.count(), 1);
  assert.ok(!fs.existsSync(b), 'tmp 里那份要被移走');
  assert.deepStrictEqual(lsTmp(), []);
  const item = pending.list()[0];
  assert.strictEqual(item.ext, 'webm');
  assert.strictEqual(item.meta.durationSec, 12, '时长要留给补转组链用');
});

test('只有 webm 时 success / silent 仍然删得干净', () => {
  for (const outcome of ['success', 'silent']) {
    fresh();
    fs.writeFileSync(path.join(paths.tmpDir(), 'rec-a.webm'), Buffer.from('fake-webm'));
    pending.cleanupTmp('a', outcome, { durationSec: 1, peak: 0 });
    assert.deepStrictEqual(lsTmp(), [], `outcome=${outcome} 之后 tmp/ 还有残留`);
    assert.strictEqual(pending.count(), 0, `outcome=${outcome} 不该留队列`);
  }
});

test('webm 条目：clear 与 bumpEcho 都认得（不然删不掉、也计不了数）', () => {
  fresh();
  fs.writeFileSync(path.join(paths.tmpDir(), 'rec-a.webm'), Buffer.from('fake-webm'));
  const p = pending.cleanupTmp('a', 'echo', { durationSec: 3, peak: 0 }).pending;
  assert.strictEqual(pending.readSidecar(p.path).reason, 'echo');
  assert.deepStrictEqual(
    [pending.bumpEcho(p.path).deleted, pending.bumpEcho(p.path).deleted],
    [false, true],
  );
  assert.strictEqual(pending.count(), 0);
  assert.deepStrictEqual(lsPending(), [], 'sidecar 也要跟着删');
});

test('retryOldest：能吃下 webm 条目（补转按 item.path 走，不碰 wav.readPcm）', async () => {
  fresh();
  fs.writeFileSync(path.join(paths.tmpDir(), 'rec-a.webm'), Buffer.from('fake-webm'));
  pending.cleanupTmp('a', 'failed', { durationSec: 9, peak: 0 });
  const seen = [];
  const r = await pending.retryOldest({
    isRecording: () => false,
    transcribeOne: (item) => { seen.push([item.ext, item.path.endsWith('.webm')]); return { text: '补出来了' }; },
  });
  assert.deepStrictEqual(seen, [['webm', true]]);
  assert.strictEqual(r.deleted, true);
  assert.strictEqual(pending.count(), 0);
});

test('outcome=failed：没 stash 过时 cleanupTmp 自己补做移入（移入先、删除后）', () => {
  fresh();
  makeSession('b', sine(2));
  const r = pending.cleanupTmp('b', 'failed', { mode: '短输入', durationSec: 2, peak: 9000 });
  assert.ok(r.pending, '必须补做移入，不能直接删掉');
  assert.strictEqual(pending.count(), 1);
  assert.deepStrictEqual(lsTmp(), []);
});

test('outcome=success：待处理 的两个文件与 tmp 全删', () => {
  fresh();
  makeSession('a', sine(2));
  const p = pending.stash('a', { durationSec: 2, peak: 8000 });
  pending.cleanupTmp('a', 'success', { pending: p });
  assert.strictEqual(pending.count(), 0);
  assert.deepStrictEqual(lsPending(), []);
  assert.deepStrictEqual(lsTmp(), []);
});

test('outcome=silent：确认静音才允许删（不变量 2 的例外）', () => {
  fresh();
  makeSession('a', constant(1, 0));
  pending.cleanupTmp('a', 'silent', { durationSec: 1, peak: 0 });
  assert.deepStrictEqual(lsTmp(), []);
  assert.deepStrictEqual(lsPending(), []);
});

test('outcome=too-short：落盘后立即删两个文件（不是「不落盘」）', () => {
  fresh();
  makeSession('a', sine(0.2));
  assert.strictEqual(lsTmp().length, 2);
  pending.cleanupTmp('a', 'too-short', { durationSec: 0.2 });
  assert.deepStrictEqual(lsTmp(), []);
});

test('outcome=echo：wav 仍在 待处理/，sidecar 有 reason:echo', () => {
  fresh();
  makeSession('a', sine(2));
  const p = pending.stash('a', { durationSec: 2, peak: 8000 });
  pending.cleanupTmp('a', 'echo', { pending: p });
  assert.strictEqual(pending.count(), 1, '回显是本地判废，不代表数据无价值');
  const meta = pending.readSidecar(p.wavPath);
  assert.strictEqual(meta.reason, 'echo');
  assert.strictEqual(meta.echoCount, 0, '第一次只打标，还没计数');
  assert.deepStrictEqual(lsTmp(), []);
});

test('outcome=empty：非静音但结果为空 → 保留', () => {
  fresh();
  makeSession('a', sine(2));
  const p = pending.stash('a', { durationSec: 2, peak: 8000 });
  pending.cleanupTmp('a', 'empty', { pending: p });
  assert.strictEqual(pending.count(), 1);
  assert.deepStrictEqual(lsTmp(), []);
});

test('bumpEcho：第 2 次才删（ECHO_LIMIT=2）', () => {
  fresh();
  makeSession('a', sine(2));
  const p = pending.stash('a', { durationSec: 2, peak: 8000, reason: 'echo' });
  const first = pending.bumpEcho(p.wavPath);
  assert.deepStrictEqual([first.echoCount, first.deleted], [1, false]);
  assert.strictEqual(pending.count(), 1, '第一次不许删');
  const second = pending.bumpEcho(p.wavPath);
  assert.deepStrictEqual([second.echoCount, second.deleted], [2, true]);
  assert.strictEqual(pending.count(), 0);
  assert.strictEqual(pending.ECHO_LIMIT, 2);
});

test('八种 outcome 各跑一遍，tmp/ 必须为空', () => {
  for (const outcome of pending.OUTCOMES) {
    fresh();
    makeSession('x', sine(1), { patch: outcome !== 'crash-zero-header' });
    pending.cleanupTmp('x', outcome, { mode: '短输入', durationSec: 1, peak: 8000 });
    assert.deepStrictEqual(lsTmp(), [], `outcome=${outcome} 之后 tmp/ 还有残留`);
  }
});

test('删除失败不影响移入结果：待处理 先落定', () => {
  fresh();
  makeSession('a', sine(2), { webm: false }); // webm 不存在，删它会「失败」
  const r = pending.cleanupTmp('a', 'failed', { durationSec: 2, peak: 8000 });
  assert.ok(r.pending);
  assert.strictEqual(pending.count(), 1);
});

test('启动扫描：头长度为 0 的 wav 被修补并移入 待处理/', () => {
  fresh();
  const w = path.join(paths.tmpDir(), 'rec-crash.wav');
  wav.writeHeader(w); // 长度字段是 0
  const pcm = sine(2);
  wav.appendPcm(w, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  assert.strictEqual(pending.headerLengthZero(w), true);

  const r = pending.scanTmp();
  assert.strictEqual(r.moved, 1);
  assert.strictEqual(pending.count(), 1);
  assert.deepStrictEqual(lsTmp(), []);
  // 修补过的文件能正常解析出 2 秒
  const item = pending.list()[0];
  assert.strictEqual(wav.parse(item.wavPath).frames, 32000);
});

test('启动扫描：头正常但 <0.3 秒的残留直接删（原稿会永久堆积的那一类）', () => {
  fresh();
  makeSession('short', sine(0.2), { webm: false });
  const r = pending.scanTmp();
  assert.strictEqual(r.dropped, 1);
  assert.strictEqual(pending.count(), 0);
  assert.deepStrictEqual(lsTmp(), []);
});

test('启动扫描：头正常但静音的残留也删', () => {
  fresh();
  makeSession('quiet', constant(2, 0), { webm: false });
  assert.strictEqual(pending.scanTmp().dropped, 1);
  assert.deepStrictEqual(lsTmp(), []);
  assert.strictEqual(pending.count(), 0);
});

test('启动扫描：头正常、有内容的残留移入 待处理/ 等补转', () => {
  fresh();
  makeSession('good', sine(3), { webm: false });
  assert.strictEqual(pending.scanTmp().moved, 1);
  assert.strictEqual(pending.count(), 1);
});

test('启动扫描：有 wav 兄弟的 .webm 才算孤儿，直接删', () => {
  fresh();
  // wav 是完整副本，补转只用它，webm 留着没有任何消费者
  makeSession('pair', sine(3), { webm: true });
  const r = pending.scanTmp();
  assert.strictEqual(r.orphans, 1);
  assert.strictEqual(r.moved, 1, 'wav 那半该移入 待处理/');
  assert.deepStrictEqual(lsTmp(), []);
  assert.deepStrictEqual(lsPending().filter((n) => n.endsWith('.webm')), []);
});

test('启动扫描：没有 wav 兄弟的 .webm 是唯一副本，移入 待处理/ 不许删', () => {
  fresh();
  // PCM 一块都没收到那条路（ASR 期间崩溃/强退，或 stash 失败后故意留在 tmp/）
  fs.writeFileSync(path.join(paths.tmpDir(), 'rec-orphan.webm'), 'x');
  const r = pending.scanTmp();
  assert.strictEqual(r.moved, 1);
  assert.strictEqual(r.orphans, 0);
  assert.strictEqual(lsPending().filter((n) => n.endsWith('.webm')).length, 1);
  assert.deepStrictEqual(lsTmp(), []);
});

test('启动扫描：不可解析的残留直接删，不抛', () => {
  fresh();
  fs.writeFileSync(path.join(paths.tmpDir(), 'rec-bad.wav'), Buffer.alloc(80, 7));
  assert.doesNotThrow(() => pending.scanTmp());
  assert.deepStrictEqual(lsTmp(), []);
});

test('list 最老在前（补转按这个顺序取）', () => {
  fresh();
  makeSession('a', sine(1));
  const p1 = pending.stash('a', { durationSec: 1, peak: 8000 });
  makeSession('b', sine(1));
  const p2 = pending.stash('b', { durationSec: 1, peak: 8000 });
  const ids = pending.list().map((x) => x.id);
  assert.strictEqual(ids.length, 2);
  assert.deepStrictEqual(ids, [p1.id, p2.id].sort());
});

test('retryOldest：正在录音时跳过', async () => {
  fresh();
  makeSession('a', sine(1));
  pending.stash('a', { durationSec: 1, peak: 8000 });
  const r = await pending.retryOldest({ isRecording: () => true, transcribeOne: () => { throw new Error('不该被调'); } });
  assert.strictEqual(r.skipped, 'recording');
});

test('retryOldest：队列空时跳过', async () => {
  fresh();
  const r = await pending.retryOldest({ isRecording: () => false, transcribeOne: () => ({ text: 'x' }) });
  assert.strictEqual(r.skipped, 'empty');
});

test('retryOldest：成功 → 删；每次只补最老的一条', async () => {
  fresh();
  makeSession('a', sine(1));
  pending.stash('a', { durationSec: 1, peak: 8000 });
  makeSession('b', sine(1));
  pending.stash('b', { durationSec: 1, peak: 8000 });
  let calls = 0;
  const r = await pending.retryOldest({
    isRecording: () => false,
    transcribeOne: () => { calls += 1; return { text: '补转出来的文字' }; },
  });
  assert.strictEqual(calls, 1, '一轮只补一条，天然限流');
  assert.strictEqual(r.deleted, true);
  assert.strictEqual(pending.count(), 1);
});

test('retryOldest：失败留在队列（音频一个字节都不许删），并计一次失败', async () => {
  fresh();
  makeSession('a', sine(1));
  pending.stash('a', { durationSec: 1, peak: 8000 });
  const r = await pending.retryOldest({
    isRecording: () => false,
    transcribeOne: () => { const e = new Error('网络炸了'); e.kind = 'net'; throw e; },
  });
  assert.strictEqual(r.failed, true);
  assert.strictEqual(r.attempts, 1, '失败要计次数，否则永久失败的条目每 120 秒重新付费上传一次');
  assert.strictEqual(pending.count(), 1);
});

test('retryOldest：peak<500 的空结果删、peak≥500 的空结果保留', async () => {
  fresh();
  makeSession('a', constant(1, 0));
  pending.stash('a', { durationSec: 1, peak: 0 });
  let r = await pending.retryOldest({ isRecording: () => false, transcribeOne: () => ({ text: '' }) });
  assert.strictEqual(r.silent, true);
  assert.strictEqual(pending.count(), 0, '确认静音才删');

  fresh();
  makeSession('b', sine(1));
  pending.stash('b', { durationSec: 1, peak: 8000 });
  r = await pending.retryOldest({ isRecording: () => false, transcribeOne: () => ({ text: '' }) });
  assert.strictEqual(r.empty, true);
  assert.strictEqual(pending.count(), 1, '非静音但结果为空 → 保留，留给用户手动重试');
});

test('retryOldest：回显命中 → 保留并计数', async () => {
  fresh();
  makeSession('a', sine(1));
  pending.stash('a', { durationSec: 1, peak: 8000 });
  const r = await pending.retryOldest({ isRecording: () => false, transcribeOne: () => ({ text: '', echo: true }) });
  assert.strictEqual(r.echo, true);
  assert.strictEqual(r.echoCount, 1);
  assert.strictEqual(pending.count(), 1);
});

test('retryOldest：没有后端能处理的那条不许堵住队列，后面的 wav 照常补转', async () => {
  fresh();
  const dir = paths.pendingDir();
  // 队首：400 秒的 webm。webm 切不开（splittable 要 wavPath），按不可切的短输入组链，
  // 400 秒超过所有后端的 maxSeconds → buildChain 空链 → 确定性永久失败。
  const stuckPath = path.join(dir, '2026-01-01_0900-aaaa.webm');
  fs.writeFileSync(stuckPath, 'fake-webm');
  pending.writeSidecar(stuckPath, { mode: '短输入', durationSec: 400, peak: 8000, ext: 'webm' });
  // 队尾：一条本来能转的 wav
  const okPath = path.join(dir, '2026-01-01_0901-bbbb.wav');
  const pcm = sine(1);
  wav.writeHeader(okPath);
  wav.appendPcm(okPath, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  wav.patchHeader(okPath);
  pending.writeSidecar(okPath, { mode: '短输入', durationSec: 1, peak: 8000 });

  const deps = {
    isRecording: () => false,
    transcribeOne: (item) => {
      if (item.ext === 'webm') {
        const e = new Error('没有后端能处理');
        e.reason = 'no-capable-provider';
        e.durationSec = 400;
        e.maxSeconds = 180;
        throw e;
      }
      return { text: '补转出来的文字' };
    },
  };

  const r1 = await pending.retryOldest(deps);
  assert.strictEqual(r1.stuck, 'no-capable-provider');
  assert.ok(fs.existsSync(stuckPath), '转不出来也绝不许删音频');

  const r2 = await pending.retryOldest(deps);
  assert.strictEqual(r2.deleted, true, '第二轮必须跳过队首去转那条 wav');
  assert.ok(!fs.existsSync(okPath));
  assert.deepStrictEqual(lsPending().filter((n) => n.endsWith('.wav')), []);

  // 全是 stuck 时明确跳过，而不是反复撞同一面墙
  const r3 = await pending.retryOldest(deps);
  assert.strictEqual(r3.skipped, 'all-stuck');

  // 用户改了后端能力 → 标记清掉，下一轮重新试一次
  const s = pending.stuckList();
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].durationSec, 400);
  assert.strictEqual(s[0].maxSeconds, 180);
  assert.strictEqual(pending.clearStuck().cleared, 1);
  const r4 = await pending.retryOldest(deps);
  assert.strictEqual(r4.stuck, 'no-capable-provider', '清掉标记后会再试一次');
  // N1：stuckList 可以吃一份已经取好的 list()，省掉 pushState 的第二遍 sidecar 解析
  assert.deepStrictEqual(pending.stuckList(pending.list()), pending.stuckList());
});

// ── H1 的负向断言：冷却（和「还没配后端」）都会自己好，不许当永久失败 ──────────

test('retryOldest：冷却 / 没配后端造成的失败不许标 stuck、不许计次数（一次网络抖动不能永久冻结队列）', async () => {
  // 修前这两个码和「真的没有后端能吃下这个时长」共用 no-capable-provider，
  // 于是网断 5 分钟就把队列里的条目逐条钉死，而冷却到期没有任何回调能解开。
  for (const reason of ['all-cooldown', 'no-provider-configured']) {
    fresh();
    makeSession('a', sine(1));
    const p = pending.stash('a', { durationSec: 1, peak: 8000 });
    const r = await pending.retryOldest({
      isRecording: () => false,
      transcribeOne: () => { const e = new Error('暂时没有可用后端'); e.reason = reason; throw e; },
    });
    assert.strictEqual(r.failed, true);
    assert.strictEqual(r.reason, reason);
    assert.ok(!r.stuck, `${reason} 不许标 stuck`);
    const meta = pending.readSidecar(p.path);
    assert.ok(!meta.stuck, `${reason} 的 sidecar 不许有 stuck`);
    assert.ok(!meta.attempts, `${reason} 不许计次数（它会自己好，退避只是白等）`);
    assert.ok(!meta.nextRetryAt, `${reason} 不许写退避时间`);
    assert.strictEqual(pending.count(), 1);
    assert.deepStrictEqual(pending.stuckList(), []);
  }
});

test('retryOldest：全 stuck 且没有后端在冷却 → 自愈清一次 stuck 再跑（唯一不用用户动手的出口）', async () => {
  fresh();
  makeSession('a', sine(1));
  const p = pending.stash('a', { durationSec: 1, peak: 8000 });
  pending.markStuck(p.path, 'no-capable-provider', { durationSec: 1, maxSeconds: 180 });

  // 有后端在冷却 → 等冷却结束，不清（清了只是让它在冷却期里再撞一次墙、白烧钱）
  let calls = 0;
  const hit = { isRecording: () => false, transcribeOne: () => { calls += 1; return { text: '转出来了' }; } };
  const cooling = await pending.retryOldest({ ...hit, anyCooling: () => true });
  assert.strictEqual(cooling.skipped, 'all-stuck');
  assert.strictEqual(calls, 0);
  assert.strictEqual(pending.stuckList().length, 1);

  // 没有后端在冷却 → 当初那次空链不是冷却造成的，清一次重新试
  const healed = await pending.retryOldest({ ...hit, anyCooling: () => false });
  assert.strictEqual(calls, 1, '自愈之后必须真的重试，而不是只把标记擦掉');
  assert.strictEqual(healed.deleted, true);
  assert.strictEqual(pending.count(), 0);
});

// ── H2 的负向断言：没量过 peak 就不许走「确认静音」的删除分支 ─────────────────

test('retryOldest：没量过音量的 webm 条目拿到空结果不许删（那是唯一副本）', async () => {
  fresh();
  // 走的就是崩溃恢复那条路：没有 wav 兄弟的 webm → scanTmp 救进 待处理/。
  // 它的 peak 从来没被量过（没有 PCM 就算不出电平），sidecar 里是 null 不是 0。
  fs.writeFileSync(path.join(paths.tmpDir(), 'rec-crash.webm'), Buffer.alloc(60000, 7));
  assert.strictEqual(pending.scanTmp().moved, 1);
  const item = pending.list()[0];
  assert.strictEqual(item.meta.peak, null, '「没量过」和「量到 0」必须在 sidecar 里分开');

  const r = await pending.retryOldest({ isRecording: () => false, transcribeOne: () => ({ text: '' }) });
  assert.strictEqual(r.deleted, false, '拿占位值判「确认静音」就会删掉用户刚说完的那段话');
  assert.strictEqual(r.empty, true);
  assert.ok(fs.existsSync(item.path));
  assert.strictEqual(pending.count(), 1);
});

// ── M1 的负向断言：时长估值要偏大、补转要有退避与次数上限 ───────────────────

test('启动扫描：崩溃 webm 的时长按字节保守估大，不留 0 给组链当「不知道」', async () => {
  fresh();
  // 400 秒真实录音 ≈ 24kbps × 400 秒 = 120 万字节。估值必须 >180，
  // 否则组链按 SPLIT_SECONDS=170 估，一段 20 分钟的录音会被真发出去、按真实时长计费。
  fs.writeFileSync(path.join(paths.tmpDir(), 'rec-crash.webm'), Buffer.alloc(400 * 3000, 9));
  assert.strictEqual(pending.scanTmp().moved, 1);
  const meta = pending.list()[0].meta;
  assert.ok(meta.durationSec > 180, `估值要偏大才拦得住，实际 ${meta.durationSec}`);
  assert.ok(meta.durationSec >= 400, '偏小就等于没拦');
});

test('retryOldest：退避没到点不调 transcribeOne；连续失败到上限标 stuck 不再重试', async () => {
  fresh();
  makeSession('a', sine(1));
  const p = pending.stash('a', { durationSec: 1, peak: 8000 });
  let calls = 0;
  const T0 = 1800000000000;
  const deps = (now) => ({
    isRecording: () => false,
    now,
    transcribeOne: () => { calls += 1; const e = new Error('后端按真实时长拒了'); e.kind = 'http4xx'; throw e; },
  });

  const r1 = await pending.retryOldest(deps(T0));
  assert.strictEqual(r1.attempts, 1);
  const m1 = pending.readSidecar(p.path);
  assert.ok(m1.nextRetryAt > T0, '失败要写退避时间');

  const r2 = await pending.retryOldest(deps(T0 + 1000));
  assert.strictEqual(r2.skipped, 'backoff');
  assert.strictEqual(calls, 1, '退避没到点就不许再付费上传一次');

  // 每轮把时钟推过 nextRetryAt，一直跑到次数上限
  let now = T0;
  for (let i = 0; i < 10; i += 1) {
    const m = pending.readSidecar(p.path) || {};
    if (m.stuck) break;
    now = Math.max(now, (m.nextRetryAt || now) + 1);
    await pending.retryOldest(deps(now));
  }
  const end = pending.readSidecar(p.path);
  assert.strictEqual(end.stuck, 'too-many-failures');
  assert.strictEqual(end.attempts, pending.MAX_RETRY_ATTEMPTS);
  assert.strictEqual(calls, pending.MAX_RETRY_ATTEMPTS, '一共只上传 5 次，不是一天 720 次');
  assert.strictEqual(pending.count(), 1, '转不出来也绝不删音频');

  // 标 stuck 之后时钟再往前走也不许调
  await pending.retryOldest(deps(now + 86400000));
  assert.strictEqual(calls, pending.MAX_RETRY_ATTEMPTS);
  assert.strictEqual(pending.stuckList()[0].stuck, 'too-many-failures');

  // 用户动手之后 attempts 要归零，否则清了标记还要在退避表上趴一小时
  assert.strictEqual(pending.clearStuck().cleared, 1);
  const cleared = pending.readSidecar(p.path);
  assert.ok(!cleared.stuck && !cleared.attempts && !cleared.nextRetryAt, JSON.stringify(cleared));
  await pending.retryOldest(deps(now + 1));
  assert.strictEqual(calls, pending.MAX_RETRY_ATTEMPTS + 1, '清零之后会重新试一次');
});

test('退避是 2^attempts × 120 秒，上限 1 小时', () => {
  assert.strictEqual(pending.MAX_RETRY_ATTEMPTS, 5);
  assert.strictEqual(pending.RETRY_BACKOFF_MAX_MS, 3600000);
  assert.strictEqual(Math.min(2 ** 5 * pending.RETRY_INTERVAL_MS, pending.RETRY_BACKOFF_MAX_MS), 3600000);
});

test('补转调度：启动后 3 秒、之后每 120 秒', () => {
  assert.strictEqual(pending.FIRST_RETRY_MS, 3000);
  assert.strictEqual(pending.RETRY_INTERVAL_MS, 120000);
});

test('未知 outcome 按 failed 处理（保守：保住音频）', () => {
  fresh();
  makeSession('a', sine(2));
  pending.cleanupTmp('a', '乱写的', { durationSec: 2, peak: 8000 });
  assert.strictEqual(pending.count(), 1);
});
