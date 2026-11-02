'use strict';
// ASR 注册表：组链过滤 → 串行尝试 → 失败自动切换 → 冷却。本期最高风险的逻辑都在这里。
//
// 三条最容易写错、且错了会直接按音频时长重复计费的规则（评审 H1 / M3 + §6.5）：
//   ① 组链过滤比的是**单个请求的音频时长** segDur，不是整段时长。整段时长去过滤的话，
//      400 秒长录音会把 dashscope(180)/groq/openai/custom(170) 全滤光，
//      只配百炼的用户长录音 100% 报 ErrAllProviders。
//   ② maxBytes 必须真的参与过滤（不是摆设），而切片的段长也要带字节折算
//      （slice.segmentSecondsFor 里的 bytesToSeconds）。
//   ③ **空识别结果不算失败、绝不切后端**。那是静音拦截之后仍然没听出内容的正常结果，
//      切过去只是让第二个后端对同一段音频再按时长收一次费。
//
// 另外两条取舍（§6.5「明确不做」）：不并发打多个后端取最快（并发=每次付几倍的钱）；
// 不把一个后端的 key 发给另一个后端（只把 creds[p.id] 传给 p）。

const logger = require('../logger');
const slice = require('../slice');
const wav = require('../wav');
const { LIMITS, MAX_PROVIDERS, COOLDOWN_MS_DEFAULT, SWITCH_KINDS, MIME_WAV, MIME_WEBM, fail } = require('./types');
const dashscope = require('./dashscope');
const openaiCompat = require('./openai-compat');
const whispercpp = require('./whispercpp');

/** 默认顺序 = 配置里 providers[] 的默认顺序（百炼 → Groq → OpenAI → 自定义 → 本地）。 */
const REGISTRY = [
  dashscope,
  openaiCompat.createProvider('groq'),
  openaiCompat.createProvider('openai'),
  openaiCompat.createProvider('custom'),
  whispercpp,
];

class ErrAllProviders extends Error {
  constructor(message, { attempts = [], reason = 'all-failed', durationSec = null, maxSeconds = null, cooldownRemainMs = null } = {}) {
    super(message);
    this.name = 'ErrAllProviders';
    this.attempts = attempts; // [{id, kind, message}]
    this.kinds = attempts.map((a) => a.kind);
    // 'all-failed'（都试过都失败）| 'all-cooldown'（都在冷却，会自己好）
    // | 'no-provider-configured'（一个都没配好，要用户动手）| 'no-capable-provider'（真的没谁吃得下，永久）
    // 这四个码的「会不会自己好」不一样，pending 的 stuck 机制据此决定要不要永久跳过（评审 H1）。
    this.reason = reason;
    this.durationSec = durationSec;
    this.maxSeconds = maxSeconds;
    this.cooldownRemainMs = cooldownRemainMs;
  }
}

// 冷却是 in-memory 的，故意不持久化：重启应用等于给所有后端一次新机会，
// 这比把 5 分钟状态写盘更符合直觉。
const cooldowns = new Map(); // id → {until, kind}
const lastFail = new Map(); // id → kind（给设置页「上次失败原因」用，冷却到期也保留）

function resetCooldowns(id) {
  if (id) {
    cooldowns.delete(id);
    lastFail.delete(id);
  } else {
    cooldowns.clear();
    lastFail.clear();
  }
}

function cooldownRemain(id, now = Date.now()) {
  const c = cooldowns.get(id);
  if (!c) return 0;
  if (c.until <= now) {
    cooldowns.delete(id);
    return 0;
  }
  return c.until - now;
}

const cooldownMsOf = (cfg = {}) => (Number.isFinite(cfg.cooldownMs) && cfg.cooldownMs > 0 ? cfg.cooldownMs : COOLDOWN_MS_DEFAULT);

/** 该 provider 在 配置.json providers[] 里的那一项。没出现过就按默认启用。 */
function entryOf(cfg = {}, id) {
  const list = Array.isArray(cfg.providers) ? cfg.providers : [];
  return list.find((e) => e && e.id === id) || { id, enabled: true };
}

/**
 * 生效的 limits。用户在设置里填的 maxSeconds 只能更严，不能放宽
 * （config.defaults() 故意不写这个键：缺键 = 用后端自己的 limits，见 FEAT-001 findings 1）。
 */
function limitsOf(p, entry) {
  const base = p.limits || LIMITS[p.id] || { maxSeconds: Infinity, maxBytes: Infinity, needsWav: false };
  const user = entry && Number.isInteger(entry.maxSeconds) && entry.maxSeconds > 0 ? entry.maxSeconds : null;
  return user ? { ...base, maxSeconds: Math.min(base.maxSeconds ?? Infinity, user) } : base;
}

function safeConfigured(p, entry, cred) {
  try {
    return p.isConfigured(entry, cred) === true;
  } catch {
    return false; // isConfigured 抛异常一律当「没配好」，不让它把整条链带崩
  }
}

/** 按用户优先级排序：配置里出现过的照配置顺序，没出现的排在后面。 */
function ordered(providers, cfg) {
  const pool = new Map(providers.map((p) => [p.id, p]));
  const out = [];
  for (const e of Array.isArray(cfg.providers) ? cfg.providers : []) {
    const p = e && pool.get(e.id);
    if (!p) continue;
    pool.delete(e.id);
    out.push({ p, entry: e, limits: limitsOf(p, e) });
  }
  for (const p of pool.values()) {
    const entry = { id: p.id, enabled: true };
    out.push({ p, entry, limits: limitsOf(p, entry) });
  }
  return out;
}

/** 发出去的形态下这段音频占多少字节：base64 内联按 ceil(n/3)*4，multipart 按裸字节。 */
const wireBytes = (bytes, limits) => (limits.inlineBase64 ? Math.ceil(bytes / 3) * 4 : bytes);

/** 先丢空段再用单个空格 join（照抄 asr_shim.py:475；不丢空段会出现连续空格或首尾空格）。 */
const joinSegments = (parts) =>
  parts
    .map((s) => String(s ?? '').trim())
    .filter((s) => s)
    .join(' ');

/** MAX_PARALLEL 个 worker 共用一个索引游标，结果按原始下标回填保证顺序（不引 p-limit）。 */
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** 本次请求走 WAV 轨还是 opus 轨：只要能吃 opus 且不用切段就用 opus（体积小），否则走 WAV。 */
const useWavTrack = (limits, { opus, splittable }) => Boolean(limits.needsWav || splittable || !opus);

/**
 * 组链。顺序定死（§6.5 的伪代码按 H1 / M3 / N6 改写后的版本）：
 *   用户优先级排序 → enabled=false → isConfigured()=false → 冷却中
 *   → needsWav=true 而本次没有 WAV 轨 → maxSeconds < segDur（H1）
 *   → maxBytes < 本次请求形态下的字节数（M3） → 截取前 MAX_PROVIDERS[mode] 个（N6）
 * 被滤掉一律记 info、**不计失败、不进冷却**。
 */
function buildChain({ providers = REGISTRY, cfg = {}, creds = {}, tracks = {}, durationSec, mode = '短输入', now = Date.now() }) {
  const opus = tracks.opus || null;
  const wavPath = tracks.wavPath || null;
  const secs = Number.isFinite(durationSec) ? durationSec : null;
  // H1 的那个式子。注意「长录音但时长没过 SPLIT_SECONDS」也按短输入算（它不会被切段）。
  const isShort = mode === '短输入' || !(secs > slice.SPLIT_SECONDS);
  const segDur = isShort ? secs ?? slice.SPLIT_SECONDS : slice.SEGMENT_SECONDS;
  const splittable = Boolean(wavPath) && !isShort;

  const bytesFor = ({ p, limits }) => {
    if (!useWavTrack(limits, { opus, splittable })) return wireBytes(opus.length, limits);
    // 会被切段的场合，段长本身已按该后端的 maxBytes 折算过（slice.segmentSecondsFor），
    // 所以这里取 min(segDur, 字节折算秒数) 来估，别拿整段时长把后端误滤掉。
    const sec = splittable ? Math.min(segDur, slice.bytesToSeconds({ id: p.id, limits })) : segDur;
    return wireBytes(wav.HEADER_BYTES + Math.ceil(sec * slice.BYTES_PER_SECOND), limits);
  };

  const chain = [];
  const considered = ordered(providers, cfg);
  let maxSecondsSeen = -Infinity;
  // 按因分桶：空链有六种成因，「会不会自己好」三种答案（冷却会、禁用/未配置要用户动手、
  // 后三种永久）。合成一个错误码的后果见评审 H1：一次网络抖动把整个补转队列钉死。
  const skips = { disabled: 0, unconfigured: 0, cooldown: 0, needsWav: 0, tooLong: 0, tooBig: 0 };
  let cooldownRemainMs = 0; // 最长的那一个，文案要用它说「还剩 N 秒」
  for (const c of considered) {
    const { p, entry, limits } = c;
    const skip = (why) => logger.info('asr', `provider=${p.id} 跳过：${why}`);
    if (entry.enabled === false) {
      skips.disabled += 1;
      skip('已禁用');
      continue;
    }
    if (!safeConfigured(p, entry, creds[p.id])) {
      skips.unconfigured += 1;
      skip('未配置');
      continue;
    }
    if (Number.isFinite(limits.maxSeconds)) maxSecondsSeen = Math.max(maxSecondsSeen, limits.maxSeconds);
    const remain = cooldownRemain(p.id, now);
    if (remain > 0) {
      skips.cooldown += 1;
      cooldownRemainMs = Math.max(cooldownRemainMs, remain);
      skip(`冷却中，还剩 ${Math.ceil(remain / 1000)} 秒`);
      continue;
    }
    if (limits.needsWav && !wavPath) {
      skips.needsWav += 1;
      skip('只能吃 WAV，本次只有 opus 轨');
      continue;
    }
    if (Number.isFinite(limits.maxSeconds) && limits.maxSeconds < segDur) {
      skips.tooLong += 1;
      skip(`时长上限 ${limits.maxSeconds} 秒 < 本次单请求 ${Math.round(segDur)} 秒`);
      continue;
    }
    const bytes = bytesFor(c);
    if (Number.isFinite(limits.maxBytes) && bytes > limits.maxBytes) {
      skips.tooBig += 1;
      skip(`体积上限 ${limits.maxBytes} 字节 < 本次单请求约 ${bytes} 字节`);
      continue;
    }
    chain.push(c);
  }
  return { chain, considered, segDur, isShort, splittable, maxSecondsSeen, skips, cooldownRemainMs };
}

/**
 * 对外唯一入口。签名定死（评审 M2）：选轨规则写在这一层，provider 侧永远是单 buffer + mime。
 * @returns {Promise<{text:string, providerId:string, switched:boolean}>}
 */
async function transcribe({
  tracks = {},
  durationSec,
  mode = '短输入',
  segments,
  hotwords = [],
  cfg = {},
  creds = {},
  providers = REGISTRY,
  sampleRate = 16000,
  now = Date.now(),
  // 非 WAV 轨的 MIME。录音路径永远是 webm/opus 所以不用给；
  // §24 的「未解码、原样上传」路径必须给（mp3 / amr / flac…），
  // 否则会把一个 mp3 标成 audio/webm 发出去。
  mime,
} = {}) {
  const opus = tracks.opus || null;
  const wavPath = tracks.wavPath || null;
  const preSplit = Array.isArray(segments) && segments.length > 0;
  if (!opus && !wavPath && !preSplit) throw fail('local', '没有可用的音频轨');

  const { chain, segDur, isShort, splittable, maxSecondsSeen, skips, cooldownRemainMs } = buildChain({ providers, cfg, creds, tracks, durationSec, mode, now });
  const secs = Number.isFinite(durationSec) ? durationSec : null;
  if (chain.length === 0) {
    // 空链按成因分三个码（评审 H1）。只有「永久」那一类才允许下游永久跳过这条音频：
    //   冷却中   → 会自己好，等到期就行。冷却到期是 cooldownRemain 里的惰性判断，
    //              没有回调，所以这里必须把它和永久失败分开，否则 pending 会把它标 stuck，
    //              而四个 clearStuck 入口全是用户动作 → 网好了队列也再不会自己动。
    //   未配置   → 要用户动手，但 setKey 成功那条入口会 clearStuck，不该当永久。
    //   能力不足 → needsWav / maxSeconds / maxBytes，重试一万次也是同一个结果。
    // 冷却优先：哪怕同时有后端能力不足，等冷却那几个回来仍有可能转出来。
    const permanent = skips.needsWav + skips.tooLong + skips.tooBig;
    if (skips.cooldown > 0) {
      throw new ErrAllProviders(`后端都在冷却，还剩 ${Math.ceil(cooldownRemainMs / 1000)} 秒，会自动重试`, {
        reason: 'all-cooldown',
        durationSec: secs,
        cooldownRemainMs,
      });
    }
    if (skips.unconfigured > 0 && permanent === 0) {
      throw new ErrAllProviders('还没配好任何后端（去设置页填一个 Key 就会自动重试）', {
        reason: 'no-provider-configured',
        durationSec: secs,
      });
    }
    // 这句文案必须和「所有后端都失败」区分开：原因、给用户的动作都不一样
    const cap = Number.isFinite(maxSecondsSeen) ? `${maxSecondsSeen}` : '—';
    throw new ErrAllProviders(`本次音频 ${secs === null ? '?' : Math.round(secs)} 秒，没有后端能处理（最长的上限是 ${cap} 秒）`, {
      reason: 'no-capable-provider',
      durationSec: secs,
      maxSeconds: Number.isFinite(maxSecondsSeen) ? maxSecondsSeen : null,
    });
  }
  // 单次最多试几个：一次失败不该把所有后端的额度都打一遍（quota 往往是账号级的）
  const tried = chain.slice(0, MAX_PROVIDERS[isShort ? 'short' : 'long']);

  let pcmSegs = null;
  const segmentPcm = () => {
    if (pcmSegs) return pcmSegs;
    if (preSplit) {
      pcmSegs = segments.map((s) => (s && s.pcm ? s.pcm : s));
      return pcmSegs;
    }
    const forSlice = tried.map((c) => ({ id: c.p.id, limits: c.limits }));
    pcmSegs = slice
      .split(wav.readPcm(wavPath), {
        sampleRate,
        thresholdSec: slice.sliceThresholdSec(forSlice),
        segmentSec: slice.segmentSecondsFor(forSlice),
      })
      .map((s) => s.pcm);
    return pcmSegs;
  };

  const requestsFor = (c) => {
    if (!useWavTrack(c.limits, { opus, splittable: splittable || preSplit })) {
      return [{ buffer: opus, mime: mime || MIME_WEBM, wavPath: null, segIndex: 0 }];
    }
    const segs = segmentPcm();
    return segs.map((pcm, i) => ({
      buffer: wav.encode(pcm, { sampleRate }),
      mime: MIME_WAV,
      // 只有「本次请求就是整份文件」时才把路径传下去（whispercpp exec 靠它免一次落盘）
      wavPath: segs.length === 1 && !preSplit ? wavPath : null,
      segIndex: i,
    }));
  };

  const attempts = [];
  for (let i = 0; i < tried.length; i += 1) {
    const c = tried[i];
    const reqs = requestsFor(c);
    // 一段失败就 abort 其余在飞的段：切换粒度是整次请求，继续转下去只是白烧钱
    const ctrl = new AbortController();
    try {
      const parts = await mapLimited(reqs, slice.MAX_PARALLEL, (r) =>
        c.p.transcribe({
          buffer: r.buffer,
          mime: r.mime,
          wavPath: r.wavPath,
          hotwords,
          signal: ctrl.signal,
          creds: creds[c.p.id], // 只给它自己的凭据，绝不把一个后端的 key 发给另一个
          cfg: c.entry,
          segIndex: r.segIndex,
        })
      );
      const text = joinSegments(parts);
      logger.info('asr', `provider=${c.p.id} ok segs=${reqs.length} chars=${text.length} switched=${i > 0}`);
      // 空串在这里原样返回并标 success —— 它不是失败，绝不切下一个后端（§6.5）
      return { text, providerId: c.p.id, switched: i > 0 };
    } catch (e) {
      ctrl.abort();
      const kind = e && e.kind ? e.kind : 'net';
      attempts.push({ id: c.p.id, kind, message: String((e && e.message) || '') });
      lastFail.set(c.p.id, kind);
      if (kind === 'local') {
        // 配置错误：跳过但不进冷却 —— 冷却对配置错误没有意义，修好应当立刻可用
        logger.warn('asr', `provider=${c.p.id} kind=local 跳过（不进冷却）：${e && e.message}`);
        continue;
      }
      if (!SWITCH_KINDS.has(kind)) {
        // 不属于「后端侧故障」（目前只有 http4xx）：直接抛，不切换也不冷却
        e.providerId = c.p.id;
        throw e;
      }
      cooldowns.set(c.p.id, { until: Date.now() + cooldownMsOf(cfg), kind });
      const next = tried[i + 1];
      logger.warn('asr', `provider=${c.p.id} failed kind=${kind} → fallback=${next ? next.p.id : '(没有下一个了)'}`);
    }
  }
  throw new ErrAllProviders(`所有后端都失败了：${attempts.map((a) => `${a.id}(${a.kind})`).join('、')}`, {
    attempts,
    reason: 'all-failed',
    durationSec: secs,
  });
}

// ───────────────── Key 归属自动探测（追加需求二·二） ─────────────────
//
// 为什么不靠前缀猜：**百炼和 OpenAI 的 Key 都是 sk- 开头**，前缀区分不开。
// 所以只能拿 Key 去打各家的「列模型」这类轻量端点，哪家回 200 就是哪家。
//
// 顺序即推荐顺序（百炼在前）：同一个 Key 理论上不可能在两家都 200，
// 但真撞上了就按推荐顺序取第一个。
const PROBE_TARGETS = [
  { id: 'dashscope', name: '阿里云百炼', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models' },
  { id: 'groq', name: 'Groq', url: 'https://api.groq.com/openai/v1/models' },
  { id: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1/models' },
];

const PROBE_TIMEOUT_MS = 8000;

/** Key 的形状筛查。只拦明显不是 Key 的东西，**不据此判断是哪一家**。 */
function keyShape(key) {
  const k = String(key ?? '').trim();
  if (k === '') return { ok: false, reason: 'empty' };
  if (/\s/.test(k)) return { ok: false, reason: 'whitespace' };
  // 非 ASCII 必须在这里拦住，否则它会被塞进 Authorization 头，
  // 而非 ASCII 头值会让 fetch **抛 TypeError**——那会被归成「连不上，像网络问题」，
  // 把「你粘错东西了」说成「检查一下代理」。实测踩过。
  if (/[^\x20-\x7e]/.test(k)) return { ok: false, reason: 'non-ascii' };
  if (k.length < 16) return { ok: false, reason: 'too-short' };
  if (k.length > 200) return { ok: false, reason: 'too-long' };
  return { ok: true };
}

/**
 * 探测一个 Key 属于哪家。
 * @returns {Promise<{ok:boolean, id?:string, name?:string, attempts:{id,status|error}[], reason?:string}>}
 *   ok=false 时 reason ∈ shape-* | all-rejected | all-unreachable，
 *   界面据此给**可操作**的提示（是否复制完整 / 是否要先在控制台开通模型），
 *   不是笼统一句「无效」。
 */
async function detectKey({ key, fetchImpl, timeoutMs = PROBE_TIMEOUT_MS, targets = PROBE_TARGETS } = {}) {
  const shape = keyShape(key);
  if (!shape.ok) return { ok: false, reason: `shape-${shape.reason}`, attempts: [] };
  const doFetch = fetchImpl || globalThis.fetch;
  const k = String(key).trim();
  const attempts = [];
  let sawReject = false;
  for (const t of targets) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(t.url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${k}` },
        signal: ctrl.signal,
      });
      attempts.push({ id: t.id, status: res.status });
      if (res.ok) {
        logger.info('asr', `Key 探测命中 ${t.id}（HTTP ${res.status}）`);
        return { ok: true, id: t.id, name: t.name, attempts };
      }
      // 401/403 = 这家明确不认它；其余状态说明不了归属
      if (res.status === 401 || res.status === 403) sawReject = true;
    } catch (e) {
      attempts.push({ id: t.id, error: (e && e.name) || 'error' });
    } finally {
      clearTimeout(timer);
    }
  }
  const reachable = attempts.some((a) => typeof a.status === 'number');
  logger.warn('asr', `Key 探测全部未命中：${attempts.map((a) => `${a.id}=${a.status || a.error}`).join(' ')}`);
  return { ok: false, reason: reachable ? (sawReject ? 'all-rejected' : 'all-inconclusive') : 'all-unreachable', attempts };
}

/** 给设置页与托盘用的状态。 */
function statusOf(id, { cfg = {}, creds = {}, providers = REGISTRY, now = Date.now() } = {}) {
  const p = providers.find((x) => x.id === id);
  const entry = entryOf(cfg, id);
  const c = cooldowns.get(id);
  const remain = c ? Math.max(0, c.until - now) : 0;
  let state = 'ok';
  if (entry.enabled === false) state = 'disabled';
  else if (!p || !safeConfigured(p, entry, creds[id])) state = 'unconfigured';
  else if (remain > 0) state = 'cooldown';
  return { state, cooldownRemainMs: remain, lastFailKind: lastFail.get(id) || null };
}

module.exports = {
  REGISTRY,
  ErrAllProviders,
  PROBE_TARGETS,
  PROBE_TIMEOUT_MS,
  keyShape,
  detectKey,
  transcribe,
  buildChain,
  statusOf,
  resetCooldowns,
  cooldownRemain,
  joinSegments,
  mapLimited,
  entryOf,
  limitsOf,
  wireBytes,
  useWavTrack,
  ordered,
};
