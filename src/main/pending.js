'use strict';
// 待处理队列、补转调度、tmp/ 清理规则表（design.md §13 / §13.1、不变量 2 / 18）。
//
// 这个模块存在的理由：现有版本曾在识别失败时删掉录音，用户说了 1 分 49 秒、
// 网络一抖全丢。所以**删除 待处理/ 音频的唯一条件是拿到非空文本或确认静音**，
// 并且这个判断只能在这一个模块里，不散落到各 catch。
//
// 两条执行约束：
// ① 删除收口在 cleanupTmp()，由 pipeline 的 finally 调。散开写的后果是表里
//    总有一两格没人管，而「没人管」在磁盘上看不出来，只会慢慢涨。
// ② **移入 待处理/ 先做、删除后做，顺序不能倒**（不变量 2 的下游保障）。
//    删除失败只记 warn 不抛——启动扫描会在下次把它收掉。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const paths = require('./paths');
const wav = require('./wav');
const archive = require('./archive');

const MOD = 'pending';

const FIRST_RETRY_MS = 3000; // 启动后 3 秒跑一次
const RETRY_INTERVAL_MS = 120000; // 之后每 120 秒一次，每次只补最老的一条
const ECHO_LIMIT = 2; // 回显连续命中几次才删
const MIN_DURATION_SEC = 0.3;
const MAX_RETRY_ATTEMPTS = 5; // 补转失败几次就标 stuck，不再自动重试
const RETRY_BACKOFF_MAX_MS = 3600000; // 退避上限 1 小时

// 崩溃恢复的 webm 连时长都没有（PCM 一块都没收到，谁也没算过）。按字节反推一个
// **保守偏大**的估值：录音端是 24kbps 上限（renderer/recorder.js），VBR 在静音段
// 远低于它，所以按一半（12kbps = 1500 字节/秒）折算。估偏大才会被组链的 maxSeconds
// 拦住；估偏小就是评审 M1 那个洞——20 分钟录音被当 170 秒发出去，按真实时长计费。
const WEBM_BYTES_PER_SEC = 1500;
const estimateWebmSeconds = (bytes) => Math.max(0, Math.round(bytes / WEBM_BYTES_PER_SEC));

/** 删一个文件，失败只记 warn（文件被占用/权限）。 */
function rmQuiet(p) {
  if (!p) return false;
  try {
    fs.rmSync(p, { force: true });
    return true;
  } catch (e) {
    logger.warn(MOD, `删除失败（下次启动扫描会收掉）：${p} ${e && e.message}`);
    return false;
  }
}

// 队列里的条目是 .wav 或 .webm（后者只在「PCM 一块都没收到」时出现，见 cleanupTmp ①）
const AUDIO_EXT_RE = /\.(wav|webm)$/i;

const sidecarOf = (audioPath) => audioPath.replace(AUDIO_EXT_RE, '.json');

function readSidecar(audioPath) {
  try {
    return JSON.parse(fs.readFileSync(sidecarOf(audioPath), 'utf8'));
  } catch {
    return null;
  }
}

function writeSidecar(audioPath, meta) {
  try {
    fs.writeFileSync(sidecarOf(audioPath), JSON.stringify(meta, null, 2), 'utf8');
  } catch (e) {
    logger.warn(MOD, `写 sidecar 失败：${e && e.message}`);
  }
}

/**
 * 把 tmp 的录音移入 待处理/<时间戳>-<4hex>.<ext> + 同名 .json。
 * 这一步在 ASR **之前**做（不变量 1：任何网络调用之前音频必须已在磁盘上，
 * 而且必须在那个识别失败也不会删的目录里）。
 *
 * meta.ext 默认 'wav'；传 'webm' 用于「PCM 轨一块都没收到、opus 是唯一录音」
 * 那条路（cleanupTmp ① 的兜底）。返回里 wavPath 只在 wav 条目上给值，
 * 别的地方一律用 path——否则会有人把 .webm 喂给 wav.readPcm。
 */
function stash(sessionId, meta = {}) {
  const dir = paths.pendingDir();
  fs.mkdirSync(dir, { recursive: true });
  const ext = String(meta.ext || 'wav').toLowerCase();
  const src = path.join(paths.tmpDir(), `rec-${sessionId}.${ext}`);
  if (!fs.existsSync(src)) {
    logger.warn(MOD, `stash 跳过：${src} 不存在`);
    return null;
  }
  const id = `${archive.stampOf()}-${crypto.randomBytes(2).toString('hex')}`;
  const dest = path.join(dir, `${id}.${ext}`);
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    // 跨设备或占用时退化成复制 + 删
    try {
      fs.copyFileSync(src, dest);
      rmQuiet(src);
    } catch (e2) {
      logger.error(MOD, `移入 待处理/ 失败：${e2 && e2.message}（原错 ${e && e.message}）`);
      return null;
    }
  }
  // null 和 0 不是一回事：webm 条目那条路没有 PCM，电平和时长**从来没被量过**。
  // 以前一律落 0，下游分不出「量到 0」和「没量过」，于是拿占位值判「确认静音」
  // 把唯一副本删了（评审 H2），又拿 0 当「不知道时长」按 170 秒估值发出去（评审 M1）。
  const sidecar = {
    mode: meta.mode || '短输入',
    durationSec: Number.isFinite(meta.durationSec) ? meta.durationSec : null,
    peak: Number.isFinite(meta.peak) ? meta.peak : null,
    rms: Number.isFinite(meta.rms) ? meta.rms : null,
    createdAt: new Date().toISOString(),
  };
  if (ext !== 'wav') sidecar.ext = ext;
  if (meta.reason) sidecar.reason = meta.reason;
  if (meta.echoCount) sidecar.echoCount = meta.echoCount;
  writeSidecar(dest, sidecar);
  logger.info(MOD, `已移入 待处理/${path.basename(dest)}`);
  return { id, path: dest, ext, wavPath: ext === 'wav' ? dest : null, jsonPath: sidecarOf(dest), meta: sidecar };
}

/** 队列列表，最老在前（补转按这个顺序取）。 */
function list() {
  let names = [];
  try {
    names = fs.readdirSync(paths.pendingDir());
  } catch {
    return [];
  }
  return names
    .filter((n) => AUDIO_EXT_RE.test(n))
    .sort()
    .map((n) => {
      const p = path.join(paths.pendingDir(), n);
      const ext = path.extname(n).slice(1).toLowerCase();
      return {
        id: n.replace(AUDIO_EXT_RE, ''),
        path: p,
        ext,
        wavPath: ext === 'wav' ? p : null, // 只有 wav 条目能走 wav.readPcm
        jsonPath: sidecarOf(p),
        meta: readSidecar(p),
      };
    });
}

const count = () => list().length;

/** 删掉队列里的一条（音频 + sidecar）。只有拿到非空文本或确认静音才该调。 */
function clear(idOrPath) {
  let audioPath;
  if (AUDIO_EXT_RE.test(idOrPath)) {
    audioPath = idOrPath;
  } else {
    const base = path.join(paths.pendingDir(), idOrPath);
    audioPath = fs.existsSync(`${base}.wav`) ? `${base}.wav` : `${base}.webm`;
  }
  const a = rmQuiet(audioPath);
  rmQuiet(sidecarOf(audioPath));
  return a;
}

/**
 * 回显命中时的处置：echoCount += 1，到 2 才删（不变量 18 的唯一例外）。
 * 返回 {echoCount, deleted}。
 */
function bumpEcho(audioPath) {
  const meta = readSidecar(audioPath) || {};
  const next = (meta.echoCount || 0) + 1;
  if (next >= ECHO_LIMIT) {
    logger.info(MOD, `${path.basename(audioPath)} 连续 ${next} 次判回显，删除`);
    clear(audioPath);
    return { echoCount: next, deleted: true };
  }
  writeSidecar(audioPath, { ...meta, reason: 'echo', echoCount: next });
  return { echoCount: next, deleted: false };
}

// ──────────────── stuck 标记（治「一条堵死整个队列」） ────────────────

/**
 * 把一条标成「补转调度要跳过」。只用于确定性永久失败（当前只有
 * no-capable-provider：时长超过所有后端上限且这条切不开）。
 * durationSec / maxSeconds 一并记下，设置页要用它们说人话。
 */
function markStuck(audioPath, kind, { durationSec = null, maxSeconds = null } = {}) {
  const meta = readSidecar(audioPath) || {};
  const next = { ...meta, stuck: kind };
  if (Number.isFinite(durationSec)) next.stuckDurationSec = durationSec;
  if (Number.isFinite(maxSeconds)) next.stuckMaxSeconds = maxSeconds;
  writeSidecar(audioPath, next);
  return next;
}

/**
 * 清掉所有 stuck 标记与失败计数，让它们下一轮重新试一次。
 * 必须挂在「用户动过后端能力」的入口上（加 Key / 换后端 / 改 maxSeconds /
 * 重置后端状态），否则换了后端也还是不转，变成新投诉。
 * attempts / nextRetryAt 一起清：只清 stuck 的话，条目会在退避表上再趴一小时（评审 M1）。
 */
function clearStuck() {
  let cleared = 0;
  for (const it of list()) {
    const m = it.meta;
    if (!m || !(m.stuck || m.attempts || m.nextRetryAt)) continue;
    const { stuck, stuckDurationSec, stuckMaxSeconds, attempts, nextRetryAt, ...rest } = m;
    writeSidecar(it.path, rest);
    cleared += 1;
  }
  if (cleared) logger.info(MOD, `清掉 ${cleared} 条 stuck 标记与失败计数，下一轮重试`);
  return { cleared };
}

/**
 * stuck 条目快照（设置页状态条用：要显示路径、时长、上限）。
 * items 可传已经取好的 list()——pushState 一次状态切换本来要把整个队列的 sidecar
 * 解析两遍（count() 一遍、这里一遍），而它正好在延迟最敏感的那几个时刻调（评审 N1）。
 */
const stuckList = (items) =>
  (items || list())
    .filter((it) => it.meta && it.meta.stuck)
    .map((it) => ({
      id: it.id,
      path: it.path,
      stuck: it.meta.stuck,
      durationSec: Number.isFinite(it.meta.stuckDurationSec) ? it.meta.stuckDurationSec : (it.meta.durationSec || null),
      maxSeconds: Number.isFinite(it.meta.stuckMaxSeconds) ? it.meta.stuckMaxSeconds : null,
    }));

// ──────────────── §13.1 的八行清理表（删除唯一收口） ────────────────

/** 八种结局。'crash-*' 两种由启动扫描用，其余由 pipeline 的 finally 用。 */
const OUTCOMES = [
  'too-short', // < 0.3 秒丢弃
  'silent', // 静音拦截命中（peak < 500）
  'success', // 拿到非空文本
  'failed', // 识别失败（含全链失败）
  'echo', // 热词回显命中
  'empty', // 非静音但结果为空
  'crash-zero-header', // 崩溃残留 · wav 头长度为 0
  'crash-residue', // 崩溃残留 · 头正常但 < 0.3s 或 peak < 500
];

/** 头里 data 块的长度字段是不是 0（= 录音中崩溃，还没 patchHeader）。 */
function headerLengthZero(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 40);
    return b.readUInt32LE(0) === 0;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* 已关 */ }
    }
  }
}

/**
 * tmp/ 清理的唯一收口。由 pipeline 的 finally 调一次，不散落到各 catch。
 *
 * meta.pending 是 pipeline 之前 stash() 的返回值（有就不再重复移）。
 * 返回 {outcome, pending, deleted:[]}。
 */
function cleanupTmp(sessionId, outcome, meta = {}) {
  if (!OUTCOMES.includes(outcome)) {
    logger.warn(MOD, `cleanupTmp 收到未知 outcome：${outcome}，按 failed 处理`);
    outcome = 'failed';
  }
  const tmp = paths.tmpDir();
  const wavPath = path.join(tmp, `rec-${sessionId}.wav`);
  const webmPath = path.join(tmp, `rec-${sessionId}.webm`);
  const deleted = [];
  let pending = meta.pending || null;
  let webmKeep = false; // 只在「webm 是唯一录音、又没能移进 待处理/」时为真

  // ① 移入 待处理/ 先做（顺序不能倒）
  const needKeep = outcome === 'failed' || outcome === 'echo' || outcome === 'empty' || outcome === 'crash-zero-header';
  if (needKeep) {
    if (outcome === 'crash-zero-header' && fs.existsSync(wavPath)) {
      try {
        wav.repair(wavPath);
      } catch (e) {
        logger.warn(MOD, `修补崩溃残留失败：${e && e.message}`);
      }
    }
    const reason = outcome === 'echo' ? 'echo' : meta.reason;
    if (!pending && fs.existsSync(wavPath)) {
      pending = stash(sessionId, { ...meta, reason });
    }
    if (!pending && !fs.existsSync(wavPath) && fs.existsSync(webmPath)) {
      // PCM 轨一块都没收到（worklet 挂了 / sink 漏接）时 WAV 根本没被创建过，
      // opus 轨就是这段话的唯一副本。再按「webm 没有消费者」删掉它，
      // 等于识别一失败就把用户刚说完的话彻底删掉——正是不变量 2 要堵的洞。
      pending = stash(sessionId, { ...meta, reason, ext: 'webm' });
      if (pending) logger.warn(MOD, `会话 ${sessionId} 没有 WAV 轨，已把 webm 移入 待处理/`);
      else logger.error(MOD, `会话 ${sessionId} 没有 WAV 轨且 webm 移入失败，tmp 里那份不删`);
      webmKeep = !pending;
    }
    if (pending && outcome === 'echo') {
      const cur = readSidecar(pending.path) || {};
      writeSidecar(pending.path, { ...cur, reason: 'echo', echoCount: cur.echoCount || 0 });
    }
  }

  // ② 删除后做。失败只记 warn，不抛、不影响上面的移入结果。
  if (outcome === 'success' || outcome === 'silent' || outcome === 'too-short') {
    // 删音频的唯一两种条件：拿到非空文本、确认静音（too-short 根本没发请求）
    if (pending) {
      clear(pending.path);
      deleted.push(pending.path);
      pending = null;
    }
  }
  if (outcome === 'crash-residue' || !needKeep) {
    if (rmQuiet(wavPath)) deleted.push(wavPath);
  } else if (fs.existsSync(wavPath)) {
    // 移入失败才会留在这儿，下次启动 scanTmp() 会再试一次移入
    logger.warn(MOD, `tmp wav 仍在（移入失败）：${wavPath}`);
  }
  // webm 默认删：WAV 轨在时补转只用 WAV，留着它没有任何消费者。
  // 长录音的归档优先用 webm，但归档发生在 pipeline 的输出步，早于本函数。
  // 唯一不删的场合是上面那条：它是唯一副本、而且没能移进 待处理/。
  if (webmKeep) {
    // 下次启动 scanTmp() 认「没有 wav 兄弟的 webm」，会再试一次移入，不会删它
    logger.warn(MOD, `tmp webm 仍在（唯一副本，移入失败），下次启动再试移入：${webmPath}`);
  } else if (rmQuiet(webmPath)) {
    deleted.push(webmPath);
  }

  logger.debug(MOD, `cleanupTmp ${sessionId} outcome=${outcome} 删了 ${deleted.length} 个文件`);
  return { outcome, pending, deleted };
}

/**
 * 启动扫描 tmp/ 的崩溃残留（§4.4）。
 *   头长度为 0            → wav.repair() 后移入 待处理/
 *   头正常但 <0.3s/静音   → 删（原稿漏掉、会永久堆积的那一类）
 *   头正常且有内容        → 移入 待处理/ 等补转
 *   .webm                 → **有同会话的 .wav 兄弟才删**（wav 是完整副本，webm 没有消费者）；
 *                           没有兄弟就说明 PCM 轨一块都没收到，它是唯一副本 → 移入 待处理/
 */
function scanTmp() {
  const tmp = paths.tmpDir();
  let names = [];
  try {
    names = fs.readdirSync(tmp);
  } catch {
    return { moved: 0, dropped: 0, orphans: 0 };
  }
  let moved = 0;
  let dropped = 0;
  let orphans = 0;

  // webm 先处理：wav 那条路的 cleanupTmp 会顺手删掉同会话的 webm，
  // 轮到 webm 时它的兄弟已经被移走，兄弟判定就会得出相反的结论。
  // readdirSync 的顺序不保证，所以这个先后必须自己定，不能靠它。
  for (const n of names.filter((x) => x.toLowerCase().endsWith('.webm'))) {
    const p = path.join(tmp, n);
    const sid = (/^rec-(.+)\.webm$/i.exec(n) || [])[1] || null;
    // 显式判兄弟：有 wav 就说明 wav 是完整副本，webm 没有消费者，删它是对的
    if (!sid || fs.existsSync(path.join(tmp, `rec-${sid}.wav`))) {
      if (rmQuiet(p)) orphans += 1;
      continue;
    }
    // 没有 wav 兄弟 = 录音时 PCM 轨一块都没收到（worklet 挂了 / sink 漏接），
    // 这个 webm 是那段话的唯一副本。再按「webm 没有消费者」删掉它，就是
    // 第 1 轮那条 HIGH 换了条路径复现：用户说完一段话，磁盘上一个字节不剩。
    // cleanupTmp 的 webm 兜底分支会把它移进 待处理/（sidecar 记 ext:'webm'）。
    // 时长按字节反推（保守偏大）：不给时长的话 sidecar 里是 null，组链会按
    // SPLIT_SECONDS=170 估，一段真实 20 分钟的录音就绕过 maxSeconds 过滤被发出去，
    // 后端按真实时长拒 + 按真实时长计费，每 120 秒重来一次（评审 M1）。
    let bytes = 0;
    try { bytes = fs.statSync(p).size; } catch { /* 读不到就不给估值，让它走 null */ }
    const durationSec = bytes > 0 ? estimateWebmSeconds(bytes) : undefined;
    const r = cleanupTmp(sid, 'failed', { reason: 'crash', durationSec });
    if (r.pending) moved += 1;
    else logger.error(MOD, `tmp webm 没有 wav 兄弟且移入失败，保留：${p}`);
  }

  for (const n of names) {
    const p = path.join(tmp, n);
    if (!n.toLowerCase().endsWith('.wav')) continue;
    const sessionId = /^rec-(.+)\.wav$/i.exec(n) ? /^rec-(.+)\.wav$/i.exec(n)[1] : null;
    if (!sessionId) continue;

    if (headerLengthZero(p)) {
      cleanupTmp(sessionId, 'crash-zero-header', { reason: 'crash' });
      moved += 1;
      continue;
    }
    let info = null;
    let lv = { peak: 0, rms: 0 };
    try {
      info = wav.parse(p);
      lv = wav.levels(wav.readPcm(p));
    } catch (e) {
      logger.warn(MOD, `tmp 残留不可解析，直接删：${n} ${e && e.message}`);
      cleanupTmp(sessionId, 'crash-residue');
      dropped += 1;
      continue;
    }
    const durationSec = info.frames / (info.sampleRate || 16000);
    if (durationSec < MIN_DURATION_SEC || lv.peak < wav.SILENCE_PEAK) {
      cleanupTmp(sessionId, 'crash-residue', { durationSec, ...lv });
      dropped += 1;
      continue;
    }
    cleanupTmp(sessionId, 'failed', { durationSec, ...lv, reason: 'crash' });
    moved += 1;
  }
  if (moved || dropped || orphans) {
    logger.info(MOD, `启动扫描 tmp/：移入 ${moved}、删除 ${dropped}、webm 孤儿 ${orphans}`);
  }
  return { moved, dropped, orphans };
}

// ──────────────── 补转调度 ────────────────

/** 失败计次 + 退避：attempts += 1、nextRetryAt = now + min(2^attempts × 120 秒, 1 小时)。 */
function bumpFailure(audioPath, now = Date.now()) {
  const meta = readSidecar(audioPath) || {};
  const attempts = (meta.attempts || 0) + 1;
  const delayMs = Math.min(2 ** attempts * RETRY_INTERVAL_MS, RETRY_BACKOFF_MAX_MS);
  writeSidecar(audioPath, { ...meta, attempts, nextRetryAt: now + delayMs });
  return { attempts, delayMs };
}

/**
 * 补一条。只补**最老的一条**（定时器反复跑就能清完，天然限流）。
 * 结果一律存成文件、不粘贴——光标早就不在原来的位置了。
 *
 * 失败的条目计次 + 退避（评审 M1）：不退避的话一条永久失败的录音每 120 秒重新
 * 上传一次，一天 720 次、每次都按音频时长计费——design.md 开头列的最高风险之一。
 * anyCooling 由 main 注入（asr.statusOf 的 'cooldown' 快照），只给下面那个自愈出口用。
 */
async function retryOldest({ isRecording, transcribeOne, anyCooling, now = Date.now(), logger: log = logger } = {}) {
  if (isRecording && isRecording()) return { skipped: 'recording' };
  let items = list();
  if (items.length === 0) return { skipped: 'empty' };
  const allStuck = (xs) => xs.every((i) => i.meta && i.meta.stuck);
  // 跳过 stuck 条目与退避没到点的条目。不跳 stuck 的话一条确定性永久失败的录音
  // 会卡在队首，把它后面所有本来能转的条目一起堵死，而且不吭声。
  const pickable = (i) => {
    const m = i.meta || {};
    if (m.stuck) return false;
    return !(Number.isFinite(m.nextRetryAt) && m.nextRetryAt > now);
  };
  let item = items.find(pickable);
  // 兜底自愈（评审 H1）：没有任何后端在冷却，说明当初那次空链不是冷却造成的，
  // 清一次 stuck 重新试。这让 stuck 从「永久」降级成「最多卡一轮」，
  // 是整套机制里唯一不需要用户动手的出口——四个 clearStuck 入口全是用户动作。
  if (!item && allStuck(items) && anyCooling && !anyCooling()) {
    if (clearStuck().cleared) {
      items = list();
      item = items.find(pickable);
    }
  }
  if (!item) {
    if (allStuck(items)) return { skipped: 'all-stuck', stuck: items.length };
    return { skipped: 'backoff', waiting: items.length };
  }
  try {
    const r = await transcribeOne(item); // {text, echo}
    const meta = readSidecar(item.path) || {};
    if (r && r.echo) return { item, ...bumpEcho(item.path), echo: true };
    if (!r || !r.text) {
      // 「确认静音」只能拿**真量过**的电平判。webm 条目那条路之所以存在就是因为
      // PCM 一块都没收到，没有 PCM 就算不出电平，sidecar 里的 0/null 是占位值。
      // 拿占位值判静音就会删掉那段话的唯一副本（评审 H2）；pipeline.js 对同一件事
      // 是防住了的（`meta.peak < 1 && !pcm`），这里照它补上。
      // ext !== 'wav' 一律视为没量过，兼容已经落盘的老 sidecar（那些里面是 peak:0）。
      const measured = (item.ext || 'wav') === 'wav' && Number.isFinite(meta.peak);
      if (measured && meta.peak < wav.SILENCE_PEAK) {
        clear(item.path);
        log.info(MOD, `补转 ${item.id} 确认静音，删除`);
        return { item, deleted: true, silent: true };
      }
      log.warn(MOD, measured
        ? `补转 ${item.id} 结果为空但非静音，保留`
        : `补转 ${item.id} 结果为空，但音量从来没量过，不敢判静音，保留`);
      return { item, deleted: false, empty: true };
    }
    clear(item.path);
    log.info(MOD, `补转 ${item.id} 成功，已存文件`);
    return { item, deleted: true, text: r.text, mdPath: r.mdPath };
  } catch (e) {
    const reason = (e && e.reason) || null;
    if (reason === 'no-capable-provider') {
      // 这个失败是确定性且永久的（时长超过所有后端的上限，而 webm 条目切不开），
      // 每 120 秒重试只会在同一个地方失败。标 stuck 让调度跳过它，
      // 并把时长与上限记进 sidecar——设置页要用这两个数说人话。
      markStuck(item.path, 'no-capable-provider', { durationSec: e.durationSec, maxSeconds: e.maxSeconds });
      log.warn(MOD, `补转 ${item.id} 没有后端能处理，标 stuck 并跳过（后续条目继续补转）`);
      return { item, failed: true, stuck: 'no-capable-provider', reason: 'no-capable-provider' };
    }
    if (reason === 'all-cooldown' || reason === 'no-provider-configured') {
      // 这两个都会自己好（冷却到期 / 用户填了 Key），既不标 stuck 也不计次数。
      // 当成永久失败的后果就是评审 H1：一次网络抖动永久冻结整个补转队列。
      log.warn(MOD, `补转 ${item.id} 暂时没有可用后端（${reason}），留在队列、不计次数：${e && e.message}`);
      return { item, failed: true, reason };
    }
    const { attempts, delayMs } = bumpFailure(item.path, now);
    if (attempts >= MAX_RETRY_ATTEMPTS) {
      markStuck(item.path, 'too-many-failures', { durationSec: item.meta && item.meta.durationSec });
      log.warn(MOD, `补转 ${item.id} 连续失败 ${attempts} 次，标 stuck 不再自动重试（音频还在）`);
      return { item, failed: true, attempts, stuck: 'too-many-failures', reason: (e && e.kind) || (e && e.message) };
    }
    log.warn(MOD, `补转 ${item.id} 第 ${attempts} 次失败，${Math.round(delayMs / 1000)} 秒后再试：${e && e.message}`);
    return { item, failed: true, attempts, reason: (e && e.kind) || (e && e.message) };
  }
}

/** 启动后 3 秒一次、之后每 120 秒一次。返回 stop()。 */
function startRetryLoop(deps) {
  let timer = null;
  let interval = null;
  const tick = () => { retryOldest(deps).catch((e) => logger.warn(MOD, `补转轮抛错：${e && e.message}`)); };
  timer = setTimeout(() => {
    tick();
    interval = setInterval(tick, RETRY_INTERVAL_MS);
  }, FIRST_RETRY_MS);
  return () => {
    if (timer) clearTimeout(timer);
    if (interval) clearInterval(interval);
  };
}

module.exports = {
  FIRST_RETRY_MS,
  RETRY_INTERVAL_MS,
  ECHO_LIMIT,
  MIN_DURATION_SEC,
  MAX_RETRY_ATTEMPTS,
  RETRY_BACKOFF_MAX_MS,
  OUTCOMES,
  estimateWebmSeconds,
  headerLengthZero,
  cleanupTmp,
  scanTmp,
  retryOldest,
  startRetryLoop,
  sidecarOf,
  readSidecar,
  writeSidecar,
  rmQuiet,
  stash,
  list,
  count,
  clear,
  bumpEcho,
  markStuck,
  clearStuck,
  stuckList,
};
