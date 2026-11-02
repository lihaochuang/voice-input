'use strict';
// 组链过滤 + 失败自动切换 + 冷却。本仓库最贵的逻辑：错判一次就按音频时长多付一次钱。
// 十条必有断言见 FEAT-002 的 acceptance_criteria，编号在各 test 名字里。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempDataDir, sine } = require('./_helpers');
const wavmod = require('../src/main/wav');
const slice = require('../src/main/slice');
const asr = require('../src/main/asr');

const DIR = useTempDataDir();
const OPUS = Buffer.from('fake-opus-bytes');

/** 可编排的假 provider。limits 不传就给一组「什么都吃得下」的宽松值。 */
function fake(id, { limits = {}, result = id.toUpperCase(), kind = null, configured = true } = {}) {
  const p = {
    id,
    name: id,
    limits: { maxSeconds: 170, maxBytes: 25 * 1024 * 1024, needsWav: false, inlineBase64: false, ...limits },
    calls: [],
    isConfigured: () => configured,
    async transcribe(args) {
      p.calls.push(args);
      if (kind) throw Object.assign(new Error(`${id} 挂了`), { kind });
      return typeof result === 'function' ? result(args) : result;
    },
  };
  return p;
}

const cfgFor = (providers, extra = {}) => ({ providers: providers.map((p) => ({ id: p.id, enabled: true })), ...extra });
const credsFor = (providers) => Object.fromEntries(providers.map((p) => [p.id, 'k-test']));

/** 短输入的标准调用：只有 opus 轨、5 秒。 */
function run(providers, over = {}) {
  return asr.transcribe({
    tracks: { opus: OPUS },
    durationSec: 5,
    mode: '短输入',
    hotwords: ['口径'],
    providers,
    cfg: cfgFor(providers, over.cfg),
    creds: credsFor(providers),
    ...over,
  });
}

test.beforeEach(() => asr.resetCooldowns());

test('① 第一个抛 http429 → 第二个被调用、switched=true、第一个进冷却', async () => {
  const a = fake('a', { kind: 'http429' });
  const b = fake('b', { result: '切过来了' });
  const out = await run([a, b]);
  assert.deepStrictEqual(out, { text: '切过来了', providerId: 'b', switched: true });
  assert.strictEqual(a.calls.length, 1);
  assert.strictEqual(b.calls.length, 1);
  assert.ok(asr.cooldownRemain('a') > 0, 'http429 属于后端侧故障，必须进冷却');
  assert.strictEqual(asr.cooldownRemain('b'), 0);
});

test('② 第一个返回空串 → 第二个调用次数为 0（空结果不是失败，切过去等于白付一次钱）', async () => {
  const a = fake('a', { result: '' });
  const b = fake('b');
  const out = await run([a, b]);
  assert.deepStrictEqual(out, { text: '', providerId: 'a', switched: false });
  assert.strictEqual(b.calls.length, 0);
  assert.strictEqual(asr.cooldownRemain('a'), 0, '空结果不进冷却');
});

test('③ 未配置的被跳过，且不计失败、不进冷却', async () => {
  const a = fake('a', { configured: false });
  const b = fake('b');
  const out = await run([a, b]);
  assert.strictEqual(out.providerId, 'b');
  assert.strictEqual(out.switched, false, '它根本没进链，不算「切换」');
  assert.strictEqual(a.calls.length, 0);
  assert.strictEqual(asr.cooldownRemain('a'), 0);
  const st = asr.statusOf('a', { cfg: cfgFor([a, b]), creds: credsFor([a, b]), providers: [a, b] });
  assert.strictEqual(st.state, 'unconfigured');
  assert.strictEqual(st.lastFailKind, null);
});

test('④ 冷却中的不进 chain，到期后重新进', async () => {
  const a = fake('a', { kind: 'http5xx' });
  const b = fake('b');
  await run([a, b], { cfg: { cooldownMs: 60 } });
  assert.strictEqual(a.calls.length, 1);

  // 冷却期内再来一次：a 不进链，b 直接接
  const mid = await run([a, b], { cfg: { cooldownMs: 60 } });
  assert.strictEqual(a.calls.length, 1, '冷却中不该再打它');
  assert.strictEqual(mid.switched, false);
  assert.strictEqual(asr.statusOf('a', { cfg: cfgFor([a, b]), creds: credsFor([a, b]), providers: [a, b] }).state, 'cooldown');

  await new Promise((r) => setTimeout(r, 80));
  await run([a, b], { cfg: { cooldownMs: 60 } });
  assert.strictEqual(a.calls.length, 2, '冷却到期必须重新进链');
});

test('④b resetCooldowns 立刻放开（设置页与托盘两个入口都用它）', async () => {
  const a = fake('a', { kind: 'net' });
  const b = fake('b');
  await run([a, b]);
  assert.ok(asr.cooldownRemain('a') > 0);
  asr.resetCooldowns();
  assert.strictEqual(asr.cooldownRemain('a'), 0);
});

test('⑤ 短输入只试前 3 个（MAX_PROVIDERS.short，不是硬编码的 3）', async () => {
  const ps = ['a', 'b', 'c', 'd'].map((id) => fake(id, { kind: 'http5xx' }));
  await assert.rejects(
    () => run(ps),
    (e) => {
      assert.strictEqual(e.name, 'ErrAllProviders');
      assert.strictEqual(e.attempts.length, 3);
      return true;
    }
  );
  assert.strictEqual(ps[3].calls.length, 0, '第四个不该被打');
});

test('⑥ kind:local 跳过但不进冷却（配置错误修好要立刻可用）', async () => {
  const a = fake('a', { kind: 'local' });
  const b = fake('b');
  const out = await run([a, b]);
  assert.strictEqual(out.providerId, 'b');
  assert.strictEqual(out.switched, true);
  assert.strictEqual(asr.cooldownRemain('a'), 0);
  assert.strictEqual(asr.statusOf('a', { cfg: cfgFor([a, b]), creds: credsFor([a, b]), providers: [a, b] }).lastFailKind, 'local');
});

test('⑦ 全失败抛 ErrAllProviders 且携带每个 kind', async () => {
  const a = fake('a', { kind: 'timeout' });
  const b = fake('b', { kind: 'quota' });
  await assert.rejects(
    () => run([a, b]),
    (e) => {
      assert.strictEqual(e.name, 'ErrAllProviders');
      assert.strictEqual(e.reason, 'all-failed');
      assert.deepStrictEqual(e.kinds, ['timeout', 'quota']);
      assert.deepStrictEqual(
        e.attempts.map((x) => x.id),
        ['a', 'b']
      );
      return true;
    }
  );
});

test('⑧ needsWav=true 而本次只有 opus → 跳过且不计失败', async () => {
  const a = fake('a', { limits: { needsWav: true } });
  const b = fake('b');
  const out = await run([a, b]);
  assert.strictEqual(out.providerId, 'b');
  assert.strictEqual(out.switched, false);
  assert.strictEqual(a.calls.length, 0);
  assert.strictEqual(asr.cooldownRemain('a'), 0);
});

test('http4xx 不属于后端侧故障：直接抛出，不切换也不冷却', async () => {
  const a = fake('a', { kind: 'http4xx' });
  const b = fake('b');
  await assert.rejects(() => run([a, b]), (e) => e.kind === 'http4xx' && e.providerId === 'a');
  assert.strictEqual(b.calls.length, 0);
  assert.strictEqual(asr.cooldownRemain('a'), 0);
});

test('M3：maxBytes 真的参与过滤（不是摆设）', async () => {
  const small = fake('small', { limits: { maxBytes: 8 } }); // 比 opus 还小
  const ok = fake('ok');
  const out = await run([small, ok]);
  assert.strictEqual(out.providerId, 'ok');
  assert.strictEqual(small.calls.length, 0);
  assert.strictEqual(asr.cooldownRemain('small'), 0, '喂不进去不是坏了，不许进冷却');
});

test('chain 为空 → ErrAllProviders，文案与「全部失败」区分开', async () => {
  const a = fake('a', { limits: { maxSeconds: 3 } });
  await assert.rejects(
    () => asr.transcribe({ tracks: { opus: OPUS }, durationSec: 5, mode: '短输入', providers: [a], cfg: cfgFor([a]), creds: credsFor([a]) }),
    (e) => {
      assert.strictEqual(e.name, 'ErrAllProviders');
      assert.strictEqual(e.reason, 'no-capable-provider');
      assert.strictEqual(e.maxSeconds, 3);
      assert.match(e.message, /本次音频 5 秒，没有后端能处理（最长的上限是 3 秒）/);
      assert.deepStrictEqual(e.kinds, []);
      return true;
    }
  );
  assert.strictEqual(a.calls.length, 0);
});

test('H1：冷却造成的空链 → reason=all-cooldown，不是「没有后端能处理」', async () => {
  // 最常见的那种故障（网断 / VPN 掉 / 睡眠唤醒）：所有后端 net 失败进 5 分钟冷却，
  // 紧接着的补转轮会得到一条空链。这条空链**会自己好**，和「时长超过所有后端上限」
  // 不是一回事——合成一个码的后果是 pending 把它标 stuck，而冷却到期是惰性判断、
  // 没有回调，于是网好了整个补转队列再也不会自己动（评审 H1）。
  const a = fake('a', { kind: 'net' });
  const b = fake('b', { kind: 'net' });
  await assert.rejects(() => run([a, b]), (e) => e.reason === 'all-failed');
  assert.ok(asr.cooldownRemain('a') > 0 && asr.cooldownRemain('b') > 0);

  await assert.rejects(
    () => run([a, b]),
    (e) => {
      assert.strictEqual(e.reason, 'all-cooldown', '冷却不是永久失败');
      assert.ok(e.cooldownRemainMs > 0, '要把还剩多久带给用户');
      assert.doesNotMatch(e.message, /没有后端能处理/, '一段 5 秒的录音不该被告知「上限 180 秒」');
      return true;
    }
  );
  assert.strictEqual(a.calls.length, 1, '冷却中不许再打它');
  assert.strictEqual(b.calls.length, 1);
});

test('H1：一个后端都没配 → reason=no-provider-configured（填个 Key 就会自动重试）', async () => {
  const a = fake('a', { configured: false });
  const b = fake('b', { configured: false });
  await assert.rejects(
    () => run([a, b]),
    (e) => {
      assert.strictEqual(e.reason, 'no-provider-configured');
      assert.strictEqual(e.maxSeconds, null);
      return true;
    }
  );
});

test('H1：冷却与能力不足同时在 → 按冷却算（那几个回来还有希望，不许当永久）', async () => {
  const cold = fake('cold', { kind: 'net' });
  const tooSmall = fake('tooSmall', { limits: { maxSeconds: 3 } });
  await assert.rejects(() => run([cold, tooSmall]), (e) => e.reason === 'all-failed');
  await assert.rejects(() => run([cold, tooSmall]), (e) => e.reason === 'all-cooldown');
});

test('H1：buildChain 按成因分桶（空链有六种成因，只有后三种是永久的）', () => {
  const disabled = fake('disabled');
  const unconf = fake('unconf', { configured: false });
  const tooLong = fake('tooLong', { limits: { maxSeconds: 3 } });
  const tooBig = fake('tooBig', { limits: { maxBytes: 8 } });
  const needsWav = fake('needsWav', { limits: { needsWav: true } });
  const all = [disabled, unconf, tooLong, tooBig, needsWav];
  const cfg = { providers: all.map((p) => ({ id: p.id, enabled: p.id !== 'disabled' })) };
  const { chain, skips } = asr.buildChain({ providers: all, cfg, creds: credsFor(all), tracks: { opus: OPUS }, durationSec: 5, mode: '短输入' });
  assert.strictEqual(chain.length, 0);
  assert.deepStrictEqual(skips, { disabled: 1, unconfigured: 1, cooldown: 0, needsWav: 1, tooLong: 1, tooBig: 1 });
});

test('禁用的后端等价于不存在；statusOf 把它和「未配置」区分开', async () => {
  const a = fake('a');
  const b = fake('b');
  const cfg = { providers: [{ id: 'a', enabled: false }, { id: 'b', enabled: true }] };
  const out = await asr.transcribe({ tracks: { opus: OPUS }, durationSec: 5, mode: '短输入', providers: [a, b], cfg, creds: credsFor([a, b]) });
  assert.strictEqual(out.providerId, 'b');
  assert.strictEqual(a.calls.length, 0);
  assert.strictEqual(asr.statusOf('a', { cfg, creds: credsFor([a, b]), providers: [a, b] }).state, 'disabled');
  assert.strictEqual(asr.statusOf('b', { cfg, creds: credsFor([a, b]), providers: [a, b] }).state, 'ok');
});

test('只把 creds[p.id] 传给 p（不把一个后端的 key 发给另一个）', async () => {
  const a = fake('a', { kind: 'net' });
  const b = fake('b');
  await asr.transcribe({
    tracks: { opus: OPUS },
    durationSec: 5,
    mode: '短输入',
    providers: [a, b],
    cfg: cfgFor([a, b]),
    creds: { a: 'key-of-a', b: 'key-of-b' },
  });
  assert.strictEqual(a.calls[0].creds, 'key-of-a');
  assert.strictEqual(b.calls[0].creds, 'key-of-b');
});

// ── 长录音（切片 + 组链过滤的交界，H1 / M3 的回归） ───────────────────────────
let longWavPath = null;
/** 400 秒 16k/16bit 单声道 WAV，落盘一次给下面几条复用。 */
function longWav() {
  if (longWavPath) return longWavPath;
  longWavPath = path.join(DIR, 'long.wav');
  fs.writeFileSync(longWavPath, wavmod.encode(sine(400, { amp: 6000 })));
  return longWavPath;
}

const runLong = (providers, over = {}) =>
  asr.transcribe({
    tracks: { wavPath: longWav() },
    durationSec: 400,
    mode: '长录音',
    hotwords: ['口径'],
    providers,
    cfg: cfgFor(providers, over.cfg),
    creds: credsFor(providers),
    ...over,
  });

const DASHSCOPE_LIKE = { maxSeconds: 180, maxBytes: 8 * 1024 * 1024, needsWav: false, inlineBase64: true };

test('⑨ H1 回归：400 秒长录音 + 链里只有 dashscope(180) → 切 3 段并成功，不是 ErrAllProviders', async () => {
  // 过滤按「单个请求的时长」(SEGMENT_SECONDS=150) 比，不是按 400 秒整段比。
  // 按整段比的话 180 < 400 会把唯一的后端滤光，只配百炼的用户长录音 100% 不可用。
  const d = fake('dashscope', { limits: DASHSCOPE_LIKE, result: ({ segIndex }) => `段${segIndex}` });
  const out = await runLong([d]);
  assert.strictEqual(out.providerId, 'dashscope');
  assert.strictEqual(out.switched, false);
  assert.strictEqual(out.text, '段0 段1 段2');
  assert.strictEqual(d.calls.length, 3, '400 秒应切成 3 段');
  for (const c of d.calls) {
    assert.strictEqual(c.mime, 'audio/wav', '切段只能走 WAV 轨');
    assert.ok(Math.ceil(c.buffer.length / 3) * 4 <= DASHSCOPE_LIKE.maxBytes, '每段 base64 内联后都要在体积上限内');
  }
});

test('⑩ M3 回归：maxBytes 压到 4MB → 分段秒数随之变小，而不是每段都超限', async () => {
  const maxBytes = 4 * 1024 * 1024;
  const tight = { ...DASHSCOPE_LIKE, maxBytes };
  // 纯逻辑先钉住：字节折算出来的秒数必须压过 SEGMENT_SECONDS
  const segSec = slice.segmentSecondsFor([{ id: 'dashscope', limits: tight }]);
  assert.ok(segSec < slice.SEGMENT_SECONDS, `字节约束要真的收紧段长，实际 ${segSec}`);

  const d = fake('dashscope', { limits: tight, result: ({ segIndex }) => `段${segIndex}` });
  const out = await runLong([d]);
  assert.strictEqual(out.providerId, 'dashscope');
  assert.ok(d.calls.length > 3, `段数要随上限变多，实际 ${d.calls.length} 段`);
  for (const c of d.calls) {
    assert.ok(Math.ceil(c.buffer.length / 3) * 4 <= maxBytes, `段 ${c.segIndex} 的请求体超了 maxBytes`);
  }
  // 顺序由原始下标回填保证，不受并发池影响
  assert.strictEqual(out.text, d.calls.map((c) => c.segIndex).sort((x, y) => x - y).map((i) => `段${i}`).join(' '));
});

test('⑤ 长录音只试前 2 个（一段失败要整次重转，所以比短输入收紧）', async () => {
  const ps = ['a', 'b', 'c', 'd'].map((id) => fake(id, { kind: 'http5xx' }));
  await assert.rejects(
    () => runLong(ps),
    (e) => {
      assert.strictEqual(e.name, 'ErrAllProviders');
      assert.strictEqual(e.attempts.length, 2);
      return true;
    }
  );
  assert.strictEqual(ps[2].calls.length, 0);
});

test('长录音任一段失败 = 整次失败，切下一个后端时从第一段重转全部', async () => {
  const a = fake('a', {
    result: ({ segIndex }) => {
      if (segIndex === 1) throw Object.assign(new Error('第二段挂了'), { kind: 'http5xx' });
      return `a${segIndex}`;
    },
  });
  const b = fake('b', { result: ({ segIndex }) => `b${segIndex}` });
  const out = await runLong([a, b]);
  assert.strictEqual(out.providerId, 'b');
  assert.strictEqual(out.switched, true);
  assert.strictEqual(out.text, 'b0 b1 b2', '不许拼半截：失败的那次结果一个字都不能进最终文本');
  assert.strictEqual(b.calls.length, 3, '切过来要从第一段重转全部');
});

test('用户优先级顺序以 cfg.providers 的顺序为准，不是注册表顺序', async () => {
  const a = fake('a');
  const b = fake('b');
  const cfg = { providers: [{ id: 'b', enabled: true }, { id: 'a', enabled: true }] };
  const out = await asr.transcribe({ tracks: { opus: OPUS }, durationSec: 5, mode: '短输入', providers: [a, b], cfg, creds: credsFor([a, b]) });
  assert.strictEqual(out.providerId, 'b');
  assert.strictEqual(a.calls.length, 0);
});
