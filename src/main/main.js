'use strict';
// app 生命周期、窗口、托盘装配、IPC 注册（design.md §3.1 / §15 / plan 条目 15）。
//
// 启动顺序是硬约束：
//   app.whenReady()
//     → safeStorage.isEncryptionAvailable()（ready 之前调不可靠；false 则禁用
//       一切 ASR 功能并在设置页写明，**不退化成明文存储**）
//     → 建隐藏 recorder 窗 → 装托盘 → 注册 IPC → 启动热键
//     → **异步预热粘贴宿主**（H2 ③，不等第一次粘贴才拉起）
//     → 启动补转定时器
//
// 隐藏 recorder 窗的三个必须项，漏了会静默坏掉：
// ① backgroundThrottling:false —— 隐藏窗的定时器与音频回调会被 Chromium 降频，录音丢块。
// ② contextIsolation:true + nodeIntegration:false + sandbox:true。
// ③ **两个权限 handler 都要设**。只设 request handler 不够：同步权限检查走
//    setPermissionCheckHandler，enumerateDevices / 设备标签 / 部分 getUserMedia
//    路径会先过它，症状是「首次能录、重启后拿不到设备」。
//
// macOS 专属 API 一律包在 process.platform === 'darwin' 分支里（评审 N1：
// getMediaAccessStatus / askForMediaAccess 在 Windows 上不存在，调用即 TypeError，
// 而它正落在主路径上）。
const fs = require('fs');
const path = require('path');
const {
  app, BrowserWindow, MessageChannelMain, Notification, clipboard, dialog, shell,
  systemPreferences, powerMonitor,
} = require('electron');

const logger = require('./logger');
const paths = require('./paths');
const config = require('./config');
const wav = require('./wav');
const hotwordsMod = require('./hotwords');
const correctionsMod = require('./corrections');
const polishMod = require('./polish');
const history = require('./history');
const archive = require('./archive');
const mine = require('./mine');
const autoHotwordsMod = require('./autohotwords');
const secret = require('./secret');
const asr = require('./asr');
const openaiCompat = require('./asr/openai-compat'); // isUrlAllowed：清理端点的 N5 校验
const hotkeysMod = require('./hotkeys');
const pasteMod = require('./paste');
const sessionMod = require('./session');
const pending = require('./pending');
const pipeline = require('./pipeline');
const trayMod = require('./tray');
const ipc = require('./ipc');
const importerMod = require('./importer');
const watcherMod = require('./watcher');
const sponsor = require('./sponsor');
const { CHANNELS } = require('./ipc-channels');

const MOD = 'main';
const MAX_PCM_BYTES = 7200 * 32000; // 2 小时上限，超出强制停录（§16）
const DECODE_SEND_BYTES = 4 * 1024 * 1024; // 送给 recorder 的分块大小
const DECODE_TIMEOUT_MS = 10 * 60 * 1000; // 1 小时录音解码实测数十秒；10 分钟是防悬住
const SPONSOR_DELAY_MS = 5000; // 首次成功后延迟 5 秒再提，别和「📋 已复制」抢注意

let recorderWin = null;
let settingsWin = null;
let tray = null;
let hotkeys = null;
let session = null;
let stopRetryLoop = null;
let importQueue = null;
let watcher = null;
let decoder = null;
let cfg = config.defaults();
let encryptionOk = false;
let micReady = null; // null = 还没预检
const tracks = new Map(); // sessionId → 双轨状态

const notify = (body, title = '语音输入') => {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch (e) {
    logger.warn(MOD, `通知失败：${e && e.message}`);
  }
};

// ─────────────── 导入解码的传输（§24.2，评审 H3 的硬判据） ───────────────
//
// 两条都不许违反：
// ① **整个文件的 buffer 绝不当 IPC 载荷**。decode:request 只带 {jobId, size}，
//    字节走 MessageChannelMain 的端口分块送（4MB/块）。
// ② PCM 分块回传（decode:chunk，≤64KB/块），main 边收边 appendPcm 落盘，
//    renderer 侧不留整份 PCM。
// 原设计是「整文件过 IPC + renderer 整段 decode + 2GB 上限」，在头号场景
// （1 小时面试录音）上会 OOM 成**静默失败**——任务从列表上消失，日志里什么都没有。
//
// 一次只跑一个解码任务（导入队列本来就是串行的），所以状态就一个 job 变量。
function createDecoder() {
  let job = null;

  function settle(ok, reason, dataBytes) {
    if (!job) return;
    const j = job;
    job = null;
    if (j.timer) clearTimeout(j.timer);
    try {
      j.port.close();
    } catch {
      /* 已关 */
    }
    j.resolve(ok ? { ok: true, dataBytes } : { ok: false, reason: reason || '解码失败' });
  }

  /** 收齐之后补 WAV 头，拿到真实 dataBytes。 */
  function finishOk() {
    if (!job) return;
    if (!job.headerWritten) {
      settle(false, '解码没产出任何 PCM');
      return;
    }
    let dataBytes = 0;
    try {
      dataBytes = wav.patchHeader(job.wavPath);
    } catch (e) {
      settle(false, `补 WAV 头失败：${e && e.message}`);
      return;
    }
    if (dataBytes <= 0) settle(false, '解码没产出任何 PCM');
    else settle(true, null, dataBytes);
  }

  return {
    isActive: (jobId) => Boolean(job) && job.jobId === jobId,
    onChunk(jobId, buf) {
      if (!job || job.jobId !== jobId) return;
      try {
        if (!job.headerWritten) {
          fs.mkdirSync(path.dirname(job.wavPath), { recursive: true });
          wav.writeHeader(job.wavPath);
          job.headerWritten = true;
        }
        wav.appendPcm(job.wavPath, buf);
      } catch (e) {
        settle(false, `PCM 落盘失败：${e && e.message}`);
      }
    },
    onDone(jobId, ok, reason) {
      if (!job || job.jobId !== jobId) return;
      if (ok) finishOk();
      else settle(false, reason || 'decodeAudioData 失败');
    },
    /**
     * 解码期间 recorder 渲染进程退出 → 视为**该 job 解码失败**，走原样上传降级。
     * 不静默丢任务：丢了用户只会看到队列卡在「解码中」，而这恰恰是超大文件最
     * 可能的结局（AudioBuffer 撑爆 renderer）。
     */
    crashed() {
      if (job) logger.error(MOD, `解码任务 ${job.jobId} 因 recorder 退出而失败，走原样上传`);
      settle(false, 'recorder 渲染进程在解码期间退出');
    },
    /** @returns {Promise<{ok:boolean, dataBytes?:number, reason?:string}>} 约定不抛 */
    start({ jobId, filePath, size, wavPath }) {
      return new Promise((resolve) => {
        if (job) {
          resolve({ ok: false, reason: '已有解码任务在跑' });
          return;
        }
        if (!recorderWin || recorderWin.isDestroyed()) {
          resolve({ ok: false, reason: '录音窗不可用' });
          return;
        }
        let fd;
        try {
          fd = fs.openSync(filePath, 'r');
        } catch (e) {
          resolve({ ok: false, reason: `打不开文件：${(e && e.code) || e}` });
          return;
        }
        const { port1, port2 } = new MessageChannelMain();
        job = { jobId, wavPath, resolve, port: port1, headerWritten: false };
        job.timer = setTimeout(() => settle(false, '解码超时'), DECODE_TIMEOUT_MS);
        recorderWin.webContents.postMessage(CHANNELS.DECODE_REQUEST, { jobId, size }, [port2]);
        port1.start();
        try {
          const buf = Buffer.allocUnsafe(Math.min(DECODE_SEND_BYTES, size));
          let sent = 0;
          while (sent < size && job) {
            const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - sent), sent);
            if (n <= 0) break;
            // slice 出这一块的独立副本：buf 会被下一轮复用
            port1.postMessage({ chunk: buf.buffer.slice(buf.byteOffset, buf.byteOffset + n) });
            sent += n;
          }
          if (job) port1.postMessage({ done: true });
        } catch (e) {
          settle(false, `读文件失败：${e && e.message}`);
        } finally {
          try {
            fs.closeSync(fd);
          } catch {
            /* 已关 */
          }
        }
      });
    },
  };
}

// ───────────────────────── 窗口 ─────────────────────────

const RENDERER = path.join(__dirname, '..', 'renderer');
const isOwnUrl = (url) => ipc.isOwnUrl(url);

function wirePermissions(ses) {
  // 两个 handler 都设，且都只放行自己的 file:// 源
  ses.setPermissionRequestHandler((wc, perm, cb) => {
    const ok = perm === 'media' && !!wc && isOwnUrl(wc.getURL());
    if (!ok) logger.warn(MOD, `拒绝权限请求 ${perm}`);
    cb(ok);
  });
  ses.setPermissionCheckHandler((wc, perm) => perm === 'media' && !!wc && isOwnUrl(wc.getURL()));
}

function createRecorderWindow() {
  recorderWin = new BrowserWindow({
    show: false,
    width: 320,
    height: 200,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'recorder-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // ← 隐藏窗被降频会丢块
    },
  });
  wirePermissions(recorderWin.webContents.session);
  // 隐藏窗没有可看的 devtools，preload/建图阶段的异常只会沉在它自己的 console 里。
  // 转进 app.log，否则「按了热键什么都没发生」在日志上完全无痕。
  recorderWin.webContents.on('console-message', (e) => {
    const lvl = e && e.level;
    const line = `recorder console: ${(e && e.message) || ''}`;
    if (lvl === 'error') logger.error(MOD, line);
    else logger.debug(MOD, line);
  });
  recorderWin.loadFile(path.join(RENDERER, 'recorder.html'));
  recorderWin.webContents.on('render-process-gone', (_e, details) => {
    logger.error(MOD, `recorder 渲染进程退出：${details && details.reason}，重建`);
    if (tray) tray.warn('录音组件重启了一次');
    // 解码期间崩了要先把那个 job 判失败（H3），否则队列永远卡在「解码中」
    if (decoder) decoder.crashed();
    recorderWin = null;
    setTimeout(createRecorderWindow, 300);
  });
  return recorderWin;
}

/**
 * 打开设置窗。tab ∈ backends / hotwords / hotkeys / behavior / import / sponsor
 * （名字必须和 settings.html 里的 data-tab 对上）。
 * 不常驻、关闭即销毁；已开着就只切标签页并拉到前台。
 */
function openSettings(tab, extra = {}) {
  const file = path.join(RENDERER, 'settings.html');
  if (!fs.existsSync(file)) {
    logger.error(MOD, '设置界面文件缺失（settings.html）');
    notify('设置界面文件缺失，请重新安装');
    return null;
  }
  const hash = tab ? `${tab}${extra.guide ? '&guide=1' : ''}` : '';
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (hash) settingsWin.webContents.executeJavaScript(`location.hash = ${JSON.stringify(`#${hash}`)}`).catch(() => {});
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }
  settingsWin = new BrowserWindow({
    width: 900,
    height: 640,
    title: '语音输入 · 设置',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  wirePermissions(settingsWin.webContents.session);
  // 外链交给系统浏览器，**绝不在这个窗口里导航**（它有 preload，导航到外站
  // 等于把 window.vi 暴露给外站）。只放行 https 与 macOS 的设置面板 scheme。
  settingsWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https:|x-apple\.systempreferences:)/.test(url)) shell.openExternal(url);
    else logger.warn(MOD, `拒绝打开外链：${url}`);
    return { action: 'deny' };
  });
  settingsWin.webContents.on('will-navigate', (e, url) => {
    if (!ipc.isOwnUrl(url)) {
      e.preventDefault();
      logger.warn(MOD, `拒绝导航：${url}`);
    }
  });
  // 设置窗的 console 也转进 app.log。界面里一个未捕获异常就是整页空白，
  // 而无人值守时没人会去开 devtools（recorder 窗那边吃过同一个教训）。
  settingsWin.webContents.on('console-message', (e) => {
    const line = `settings console: ${(e && e.message) || ''}`;
    if (e && e.level === 'error') logger.error(MOD, line);
    else logger.debug(MOD, line);
  });
  settingsWin.loadFile(file, hash ? { hash } : undefined);
  settingsWin.webContents.on('did-finish-load', pushState); // 开窗就有状态条，不等下一次事件
  settingsWin.on('closed', () => { settingsWin = null; }); // 不常驻，关闭即销毁
  return settingsWin;
}

/**
 * 状态条载荷。§16 的通道表写的是 {state, mode, provider, pending}，这里多带几项：
 * reason（热键模式的降级原因，热键页顶部要显示）、imports（导入队列快照）、
 * stuck（补转队列里被跳过的条目——音频保住了但用户得知道它在哪，不然等于还是丢了）。
 * 都是新增键，旧字段一个没动。
 */
const pushState = () => {
  if (settingsWin && !settingsWin.isDestroyed()) {
    // 队列只取一遍：count() 与 stuckList() 各自 list() 的话，整个队列的 sidecar
    // 要同步解析两遍，而这里正好在状态切换（开始录音 / 转写中 / 结束）时调（评审 N1）。
    const items = pending.list();
    settingsWin.webContents.send(CHANNELS.STATE_CHANGED, {
      state: tray ? tray.state : 'idle',
      mode: hotkeys ? hotkeys.mode : 'combo',
      provider: currentProviderLabel(),
      pending: items.length,
      stuck: pending.stuckList(items),
      reason: hotkeys ? hotkeys.reason : '',
      imports: importQueue ? importQueue.list() : [],
      watching: watcher ? watcher.running : false,
    });
  }
};

// ───────────────────────── 麦克风 TCC 预检 ─────────────────────────

/**
 * 放**首次录音之前**，不是失败之后——隐藏窗里被 TCC 拒绝只表现为一个 promise
 * reject，用户第一次按热键就是「什么都没发生」。
 * 整段只在 darwin 执行；非 darwin 视为已授权。
 */
async function ensureMicAccess() {
  if (process.platform !== 'darwin') return true;
  if (micReady === true) return true;
  let status = 'granted';
  try {
    status = systemPreferences.getMediaAccessStatus('microphone');
  } catch (e) {
    logger.warn(MOD, `getMediaAccessStatus 抛错，按已授权继续：${e && e.message}`);
    micReady = true;
    return true;
  }
  if (status === 'not-determined') {
    try {
      status = (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
    } catch (e) {
      logger.error(MOD, `askForMediaAccess 抛错：${e && e.message}`);
      status = 'denied';
    }
  }
  if (status !== 'granted') {
    logger.error(MOD, `麦克风权限状态 ${status}`);
    if (tray) tray.noMic('麦克风权限被拒，点此前往授权');
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    micReady = false;
    return false;
  }
  micReady = true;
  if (tray) tray.micOk();
  return true;
}

// ───────────────────────── 双轨收集 ─────────────────────────

function trackOf(sessionId) {
  if (!tracks.has(sessionId)) {
    tracks.set(sessionId, {
      wavPath: path.join(paths.tmpDir(), `rec-${sessionId}.wav`),
      webmPath: path.join(paths.tmpDir(), `rec-${sessionId}.webm`),
      chunkCount: 0,
      bytes: 0,
      headerWritten: false,
      opus: null,
      opusWaiters: [],
    });
  }
  return tracks.get(sessionId);
}

/** 收到第一个 PCM 块就写长度字段为 0 的头，之后每块 append（§4.4）。 */
function onPcm(sessionId, buf) {
  const t = trackOf(sessionId);
  try {
    if (!t.headerWritten) {
      fs.mkdirSync(paths.tmpDir(), { recursive: true });
      wav.writeHeader(t.wavPath);
      t.headerWritten = true;
    }
    wav.appendPcm(t.wavPath, buf);
  } catch (e) {
    logger.error(MOD, `PCM 落盘失败：${e && e.message}`);
    if (tray) tray.warn('写入失败，磁盘可能已满');
    stopRecording('disk-error');
    return;
  }
  t.chunkCount += 1;
  t.bytes += buf.length;
  if (t.bytes > MAX_PCM_BYTES) {
    logger.warn(MOD, `累计 PCM ${t.bytes} 字节超上限，强制停录`);
    notify('录音已达 2 小时上限，已自动结束');
    stopRecording('max-bytes');
  }
}

function onOpus(sessionId, buf) {
  const t = trackOf(sessionId);
  t.opus = buf;
  const waiters = t.opusWaiters.splice(0);
  for (const w of waiters) w(buf);
}

/** 等 opus 已到且 PCM 流已结束，**超时 3 秒以已有数据继续**（§4.5）。 */
function collect({ sessionId, timeoutMs }) {
  const t = trackOf(sessionId);
  const waitOpus = t.opus
    ? Promise.resolve(t.opus)
    : new Promise((resolve) => {
      const timer = setTimeout(() => {
        logger.warn(MOD, `会话 ${sessionId} 等 opus 超时 ${timeoutMs}ms，以已有数据继续`);
        resolve(null);
      }, timeoutMs);
      t.opusWaiters.push((b) => { clearTimeout(timer); resolve(b); });
    });

  return waitOpus.then((opus) => {
    let pcm = null;
    let durationSec = 0;
    if (t.headerWritten) {
      try {
        wav.patchHeader(t.wavPath);
        pcm = wav.readPcm(t.wavPath);
        durationSec = pcm.length / 16000;
      } catch (e) {
        logger.error(MOD, `读回 tmp WAV 失败：${e && e.message}`);
        pcm = null;
      }
    }
    if (opus) {
      try {
        fs.writeFileSync(t.webmPath, opus);
      } catch (e) {
        logger.warn(MOD, `写 webm 失败：${e && e.message}`);
      }
    }
    tracks.delete(sessionId);
    // 可观测判据（§4.3 / §21.2）：录 3 秒该会话的 PCM 块计数应 ≈ 3000ms/256ms ≈ 11±1。
    // 为 0 就是 worklet 没被拉起（sink 漏接或 context 不是 running），走 §15-42。
    logger.info(MOD, `会话 ${sessionId} 汇合：PCM 块 ${t.chunkCount} 个、${durationSec.toFixed(2)}s、opus ${opus ? opus.length : 0} 字节`);
    return {
      wavPath: t.headerWritten ? t.wavPath : null,
      webmPath: opus ? t.webmPath : null,
      opus: opus || null,
      pcm,
      durationSec,
      chunkCount: t.chunkCount,
    };
  });
}

// ───────────────────────── ASR 适配（给托盘用） ─────────────────────────

/**
 * 「哪些后端配了 key」的**不解密**版本，只看密文文件在不在。
 * 托盘菜单每次重建、每次推状态都要问一遍后端状态；走 credsSnapshot() 会
 * 每次解密五份 key（明文多存在一次就多一次风险），并且在没配 key 的机器上
 * 刷一屏 warn。statusOf 只需要 cred 为真值，所以给个占位符就够。
 */
function credsPresence() {
  const out = {};
  for (const p of cfg.providers || []) if (secret.has(p.id)) out[p.id] = '*';
  return out;
}

function currentProviderLabel() {
  const present = credsPresence();
  for (const p of cfg.providers || []) {
    const st = asr.statusOf(p.id, { cfg, creds: present, now: Date.now() });
    if (st.state === 'ok') return p.id;
  }
  return '（未配置）';
}

/**
 * 解密失败的统一上报口（§9、验证清单第 21 项）。
 *
 * 为什么必须共用：`secret.get()` 解密失败会**删掉坏密文文件**，所以「谁先碰到
 * 这份坏 key」就决定了用户能不能看到原因。asrStatusList() 为了显示掩码会先
 * 解密一遍（设置页状态点每秒刷一次，开着设置页时它一定跑在请求之前），
 * 它要是把异常吞掉，等到 credsSnapshot() 真要用 key 时文件已经没了，
 * secret.get() 只会报 ENOENT → 用户看到的是「没填过 key」，坏 key 这件事
 * 被彻底抹掉。这正是第 21 项点名禁止的「静默变成没填过」。
 *
 * dedup 的理由：状态点轮询是 1Hz，不去重会每秒弹一次托盘气泡 + 抢焦点。
 * 用户重填该后端的 key 时（setKey）清掉记忆，于是「重填之后又坏了」还会再报。
 */
const decryptReported = new Set();
function reportDecryptFailure(id) {
  if (decryptReported.has(id)) return;
  decryptReported.add(id);
  logger.error(MOD, `${id} 密钥无法解密`);
  if (tray) tray.warn('密钥无法解密（可能因应用更新或系统变更），请重新填写');
  openSettings('backends');
}

/** 只在发起请求的那一刻取 key，不缓存明文（不变量 7）。 */
function credsSnapshot() {
  const out = {};
  for (const p of cfg.providers || []) {
    try {
      const k = secret.get(p.id);
      if (k) out[p.id] = k;
    } catch (e) {
      if (e && e.kind === 'decrypt') reportDecryptFailure(p.id);
    }
  }
  return out;
}

const coolingProviders = () => {
  const present = credsPresence();
  return (cfg.providers || [])
    .map((p) => ({ id: p.id, st: asr.statusOf(p.id, { cfg, creds: present, now: Date.now() }) }))
    .filter((x) => x.st.state === 'cooldown')
    .map((x) => x.id);
};

// ───────────────────────── 录音与链路 ─────────────────────────

function startRecording(sessionId, mode) {
  if (recorderWin && !recorderWin.isDestroyed()) {
    recorderWin.webContents.send(CHANNELS.CAPTURE_START, { sessionId, mode });
  }
  if (tray) tray.startRecording(() => session.elapsedSec());
  pushState();
}

function stopRecording(reason) {
  const r = session.forceStop(reason);
  if (r) handleSessionAction(r);
}

function tellRecorderStop(sessionId) {
  if (recorderWin && !recorderWin.isDestroyed()) {
    recorderWin.webContents.send(CHANNELS.CAPTURE_STOP, { sessionId });
  }
  if (tray) tray.stopRecording();
}

async function runPipeline({ sessionId, mode, durationSec, isRetry = false }) {
  const result = await pipeline.run({
    sessionId,
    mode,
    isRetry,
    cfg,
    durationSec,
    deps: {
      collect,
      levels: wav.levels,
      isSilent: wav.isSilent,
      stash: pending.stash,
      transcribe: (args) => asr.transcribe({ ...args, creds: credsSnapshot() }),
      loadHotwords: hotwordsMod.load,
      looksLikeContextEcho: hotwordsMod.looksLikeContextEcho,
      appendHistory: history.append,
      loadCorrections: correctionsMod.load,
      applyCorrections: correctionsMod.apply,
      polish: polishMod.polish,
      polishKey: () => {
        try {
          return secret.get('polish') || secret.get('dashscope');
        } catch {
          return null;
        }
      },
      deliver: (text) => pasteMod.deliver(text, {
        controller: hotkeys,
        onPermission: (kind, panel) => {
          notify(kind === 'permission-automation'
            ? '模拟粘贴需要「自动化」权限，已为你打开设置'
            : '模拟粘贴需要「辅助功能」权限，已为你打开设置');
          shell.openExternal(panel);
        },
      }),
      archiveSave: archive.save,
      stampOf: archive.stampOf,
      transcriptDir: () => cfg.转录目录 || paths.defaultTranscriptDir(),
      cleanupTmp: pending.cleanupTmp,
      tray,
    },
  });
  if (result.text && tray) tray.setLast(result.text);
  if (result.outcome === 'success' && result.text) maybePromptSponsor();
  // 录音期间队列是暂停的，这会儿接着跑（§24.3）
  if (importQueue) importQueue.kick();
  pushState();
  return result;
}

/**
 * 首次成功识别后的一次性赞助提示（§25.1）。
 * 延迟 5 秒是为了不和「📋 已复制」的托盘状态抢注意；发出的同时就把标志写盘，
 * **永不再提**。不做反复弹窗、不做角标、不做启动页。
 */
function maybePromptSponsor() {
  if (cfg.已提示赞助) return;
  // 先写盘再等 5 秒：这中间要是退出了，宁可少提一次，也不要下次启动又提
  config.save({ 已提示赞助: true });
  cfg = config.load();
  setTimeout(() => {
    try {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: '语音输入', body: '这个工具是免费的。如果它帮到你，点一下看看赞助页 ❤' });
      n.on('click', () => openSettings('sponsor'));
      n.show();
    } catch (e) {
      logger.warn(MOD, `赞助提示失败：${e && e.message}`);
    }
  }, SPONSOR_DELAY_MS);
}

function handleSessionAction(r) {
  if (r.action === 'ignored') return;
  if (r.action === 'start') {
    ensureMicAccess().then((ok) => {
      if (!ok) {
        stopRecording('no-mic');
        return;
      }
      startRecording(r.sessionId, r.mode);
    });
    return;
  }
  tellRecorderStop(r.sessionId);
  if (r.action === 'discard') {
    // < 0.3 秒：落盘后立即删除两个文件，不发请求
    tracks.delete(r.sessionId);
    pending.cleanupTmp(r.sessionId, 'too-short', { mode: r.mode, durationSec: r.durationSec });
    if (tray) tray.idle();
    pushState();
    return;
  }
  runPipeline({ sessionId: r.sessionId, mode: r.mode, durationSec: r.durationSec })
    .catch((e) => logger.error(MOD, `pipeline 未捕获：${e && e.message}`));
}

// ───────────────────────── 启动 ─────────────────────────

/** 「原样上传」这条路上当前可用后端能吃下的最大裸字节（importer 的闸门用）。 */
function rawUploadCapacity() {
  const { chain } = asr.buildChain({
    cfg,
    creds: credsPresence(),
    tracks: { opus: Buffer.alloc(1) }, // 只为让 buildChain 按「有 opus、不可切」组链
    durationSec: null,
    mode: '短输入',
  });
  return importerMod.rawCapacity(chain);
}

/** 设置页的 provider 列表数据源（状态点 + 掩码 + 生效上限）。 */
function asrStatusList() {
  const present = credsPresence();
  const now = Date.now();
  return (cfg.providers || []).map((entry) => {
    const p = asr.REGISTRY.find((x) => x.id === entry.id);
    const st = asr.statusOf(entry.id, { cfg, creds: present, now });
    const limits = (p && p.limits) || {};
    let mask = null;
    try {
      mask = secret.has(entry.id) ? secret.mask(entry.id) : null;
    } catch (e) {
      mask = null;
      // 不能只吞掉：mask() 失败时坏文件已经被删，credsSnapshot() 那条路再也
      // 碰不到 kind:'decrypt'，用户就只会看到「没填过」（验证清单第 21 项）。
      if (e && e.kind === 'decrypt') reportDecryptFailure(entry.id);
    }
    // 用户填的 maxSeconds 只能更严（取 min），不能放宽后端硬限
    const effective = Number.isFinite(entry.maxSeconds)
      ? Math.min(entry.maxSeconds, limits.maxSeconds || Infinity)
      : limits.maxSeconds;
    return {
      id: entry.id,
      name: (p && p.name) || entry.id,
      state: st.state,
      cooldownRemainMs: st.cooldownRemainMs,
      lastFailKind: st.lastFailKind,
      hasKey: secret.has(entry.id),
      mask,
      maxSecondsEffective: Number.isFinite(effective) ? effective : null,
      inlineBase64: !!limits.inlineBase64,
    };
  });
}

function buildIpcDeps() {
  return {
    activeSessionId: () => session.activeSessionId,
    isPendingOpus: (sid) => tracks.has(sid),
    isActiveDecodeJob: (jobId) => Boolean(decoder) && decoder.isActive(jobId),
    onPcm,
    onOpus,
    onRecorderError: (kind, msg) => {
      logger.error(MOD, `recorder 报错 ${kind}：${msg}`);
      if (kind === 'mic') {
        if (tray) tray.noMic('麦克风不可用');
        if (process.platform === 'darwin') {
          shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
        }
      } else if (tray) {
        tray.warn(kind === 'audio-context' ? '音频上下文未启动，请查看日志' : '录音采集异常，请查看日志');
      }
    },
    onDecodeChunk: (jobId, buf) => decoder.onChunk(jobId, buf),
    onDecodeDone: (jobId, ok, reason) => decoder.onDone(jobId, ok, reason),
    getConfig: () => ({
      ...cfg,
      _encryptionOk: encryptionOk,
      _platform: process.platform,
      _hotkeys: hotkeys ? { mode: hotkeys.mode, reason: hotkeys.reason, describe: hotkeys.describe() } : null,
      _defaultTranscriptDir: paths.defaultTranscriptDir(),
    }),
    setConfig: (patch) => {
      // 监听目录的两条硬校验在保存时就做：等运行时才发现等于让用户的归档音频
      // 被当成新输入无限循环一遍（§16 / §24.3）
      if (patch.watch && typeof patch.watch.dir === 'string' && patch.watch.dir !== '') {
        const v = watcherMod.validate({
          dir: patch.watch.dir,
          transcriptDir: patch.转录目录 || cfg.转录目录 || paths.defaultTranscriptDir(),
        });
        if (!v.ok) return { ok: false, reason: v.reason };
      }
      if (typeof patch.转录目录 === 'string' && patch.转录目录 !== '') {
        const v = checkWritableDir(patch.转录目录);
        if (!v.ok) return { ok: false, reason: v.reason };
      }
      // 清理端点必须 https，**本地回环 127.0.0.1 / localhost 例外**（评审 N5）。
      // config.validate 对非法值是「warn + 回退默认」，那在界面上表现为输入框
      // 自己弹回去，用户看不出是被拒了——所以这里显式拒绝并给原因。
      if (patch.polish && typeof patch.polish.baseUrl === 'string' && patch.polish.baseUrl !== '') {
        if (!openaiCompat.isUrlAllowed(patch.polish.baseUrl)) {
          return { ok: false, reason: '清理端点必须是 https://（只有本机回环 127.0.0.1 / localhost 允许 http://）' };
        }
      }
      const before = cfg;
      config.save(patch);
      cfg = config.load();
      // 热键只在模式/键位真的变了才重启：每次存设置都 unregister+register
      // 等于把「已被占用」的风险摊到每一次保存上
      if (hotkeys && patch.热键) hotkeys.start(cfg);
      if (patch.开机自启 !== undefined) {
        try {
          app.setLoginItemSettings({ openAtLogin: !!cfg.开机自启 });
        } catch (e) {
          logger.warn(MOD, `设置开机自启失败：${e && e.message}`);
        }
      }
      if (patch.watch || patch.转录目录 !== undefined) restartWatcher();
      // 动过 providers（启用项、顺序、maxSeconds）就把 stuck 标记清掉重试一次
      if (patch.providers) pending.clearStuck();
      if (before.历史保留天数 !== cfg.历史保留天数 && cfg.历史保留天数 > 0) history.prune(cfg.历史保留天数);
      if (tray) tray.refreshMenu();
      pushState();
      return { ok: true, config: cfg };
    },
    // 原文，不是解析后的词数组：设置页编辑的就是 热词.txt 本身（# 注释要留着）
    getHotwords: () => hotwordsMod.loadRaw(),
    setHotwords: (text) => { hotwordsMod.save(text); return { ok: true }; },
    mineHotwords: () => {
      const rows = history.allTexts();
      const candidates = mine.mine(rows, hotwordsMod.load());
      const chars = rows.reduce((s, t) => s + String(t).length, 0);
      // 候选同时写进 待确认热词.txt，保留命令行/文本编辑那条路（§12）
      const p = mine.writePending(candidates, { rows: rows.length, chars });
      return { ok: true, candidates, path: p };
    },
    mergeHotwords: (words) => ({ ok: true, ...mine.merge(words) }),
    autoHotwords: (action, word) => {
      switch (action) {
        case 'list': return { ok: true, ...autoHotwordsMod.list() };
        case 'remove': return { ...autoHotwordsMod.remove(word), ...autoHotwordsMod.list() };
        case 'clear': return { ...autoHotwordsMod.clear(), ...autoHotwordsMod.list() };
        case 'blacklist': return { ...autoHotwordsMod.blacklistAdd(word), ...autoHotwordsMod.list() };
        case 'unblacklist': return { ...autoHotwordsMod.blacklistRemove(word), ...autoHotwordsMod.list() };
        case 'run': return { ok: true, ...runAutoHotwords(true), ...autoHotwordsMod.list() };
        default: return { ok: false, reason: 'shape' };
      }
    },
    // 只回「是哪家」，Key 明文不入日志、不回传（§9）
    detectKey: (key) => asr.detectKey({ key }),
    setKey: (id, key) => {
      try {
        secret.set(id, key);
        decryptReported.delete(id); // 重填过了，下次再坏要重新报
        pending.clearStuck(); // 多了个可用后端，之前判「没有后端能处理」的条目要重新试
        return { ok: true, mask: secret.maskOf(key) };
      } catch (e) {
        return { ok: false, reason: e.kind || 'error' };
      }
    },
    hasKey: (id) => {
      try {
        const m = secret.mask(id);
        return { has: m !== null, mask: m };
      } catch (e) {
        return { has: false, mask: null, reason: e.kind || 'error' };
      }
    },
    /**
     * 「测试连接」：**只走这一个 provider，绕过切换链也绕过冷却**。
     * 测 A 却成功在 B 上毫无诊断价值；而用户显式点「测试」的意图优先于冷却，
     * 所以先清掉该后端的冷却再测（成功就顺便相当于清了，失败会自然重新进冷却）。
     * 保留用户填的 baseUrl / model / 路径，只把 providers 收成这一项。
     */
    testKey: async (id) => {
      asr.resetCooldowns(id);
      const entry = { ...asr.entryOf(cfg, id), enabled: true };
      // 没配好就别发请求：组链会把它滤掉，然后抛「没有后端能处理」——那句话
      // 对「我刚点了测试连接」的用户毫无意义，真正的原因是 Key / 路径还空着
      const prov = asr.REGISTRY.find((x) => x.id === id);
      try {
        if (prov && !prov.isConfigured(entry, credsSnapshot()[id])) {
          return { ok: false, kind: 'local', message: '还没配好：Key / Base URL / 可执行文件路径有缺' };
        }
      } catch (e) {
        return { ok: false, kind: 'local', message: logger.redact(String((e && e.message) || e)) };
      }
      // 落一份真 WAV：whispercpp 的 needsWav 过滤要看 wavPath，不然测它必然
      // 报「没有后端能处理」，而那跟 key 对不对毫无关系
      const tonePath = path.join(paths.tmpDir(), `test-tone-${Date.now()}.wav`);
      try {
        fs.mkdirSync(paths.tmpDir(), { recursive: true });
        fs.writeFileSync(tonePath, wav.encode(testTone()));
        const r = await asr.transcribe({
          tracks: { opus: null, wavPath: tonePath },
          durationSec: 0.5,
          mode: '短输入',
          cfg: { ...cfg, providers: [entry] },
          creds: credsSnapshot(),
        });
        return { ok: true, providerId: r.providerId, chars: (r.text || '').length };
      } catch (e) {
        return {
          ok: false,
          kind: (e && e.kind) || (e && e.reason) || 'error',
          message: logger.redact(String((e && e.message) || e)),
        };
      } finally {
        try {
          fs.rmSync(tonePath, { force: true });
        } catch {
          /* 残留扫描会收拾 */
        }
      }
    },
    asrStatus: () => ({ ok: true, providers: asrStatusList(), encryptionOk }),
    asrReset: (providerId) => {
      asr.resetCooldowns(providerId);
      // 后端能力可能变了，队列里标成 stuck 的条目该重新试一次（不然「换了后端也还是不转」）
      pending.clearStuck();
      logger.info(MOD, `重置后端状态：${providerId || '全部'}`);
      if (tray) tray.refreshMenu();
      pushState();
      return { ok: true, providers: asrStatusList() };
    },
    listHistory: (n) => history.listRecent(n),
    copyText: (text) => { clipboard.writeText(text); return { ok: true }; },
    registerHotkey: (which, accel) => hotkeys.tryRegister(which, accel),
    // 空数组 = 设置页的「选择音频文件…」按钮，让 main 弹多选对话框。
    // 文件对话框与 fs 都归 main，renderer 只经手路径（§3.2 / §24.2）。
    importFiles: (list) => (list.length === 0 ? pickAndImport() : importQueue.add(list)),
    getSponsor: () => sponsor.get(),
    pickDir: async (kind) => {
      const r = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: kind === 'watch' ? '选择要监听的文件夹' : '选择转录文件的存放目录',
      });
      const picked = (r.filePaths && r.filePaths[0]) || null;
      if (r.canceled || !picked) return { canceled: true };
      // 校验在 main（§16）。界面只负责显示 reason，不自己判。
      const v = kind === 'watch'
        ? watcherMod.validate({ dir: picked, transcriptDir: cfg.转录目录 || paths.defaultTranscriptDir() })
        : checkWritableDir(picked);
      return { canceled: false, path: picked, ok: v.ok, reason: v.reason };
    },
    openDataDir: () => { shell.openPath(paths.dataDir()); return { ok: true }; },
    openPath: (p) => { shell.openPath(p); return { ok: true }; },
    transcriptDir: () => cfg.转录目录 || paths.defaultTranscriptDir(),
  };
}

/**
 * 跑一次热词自动提炼（追加需求二·四）。
 * @param {boolean} force 用户在界面上手点「立刻提炼一次」时为 true，跳过频率判断
 */
function runAutoHotwords(force = false) {
  const conf = cfg.热词自动提炼 || {};
  if (!force) {
    if (conf.开启 === false || conf.频率 === 'off') return { added: [] };
    const { lastRunAt } = autoHotwordsMod.loadLedger();
    if (!autoHotwordsMod.dueNow({ freq: conf.频率, lastRunAt })) return { added: [] };
  }
  let r;
  try {
    r = autoHotwordsMod.runOnce({ rows: history.allTexts(), minCount: conf.阈值 });
  } catch (e) {
    logger.error(MOD, `自动提炼热词失败：${e && e.message}`);
    return { added: [] };
  }
  // 加了词必须说一声。静默的自动化是这功能最危险的形态：错词进了表，
  // 用户只会觉得「识别最近变差了」，根本想不到是自己的热词表在推着它错。
  if (r.added.length > 0) {
    const n = new Notification({
      title: '语音输入',
      body: `自动添加了 ${r.added.length} 个热词：${r.added.slice(0, 5).map((w) => w.word).join(' ')}${r.added.length > 5 ? ' …' : ''}（点击查看）`,
    });
    n.on('click', () => openSettings('hotwords'));
    try {
      if (Notification.isSupported()) n.show();
    } catch (e) {
      logger.warn(MOD, `自动热词通知失败：${e && e.message}`);
    }
  }
  return r;
}

/** 转录目录「存在且可写」：写一个探针文件再删（§16）。 */
function checkWritableDir(dir) {
  if (!path.isAbsolute(dir)) return { ok: false, reason: '必须是绝对路径' };
  try {
    fs.mkdirSync(dir, { recursive: true }); // 默认目录是首次归档才建的，这里顺手建上
    const probe = path.join(dir, `.vi-probe-${Date.now()}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `目录不可写：${(e && e.code) || e}` };
  }
}

/** 按当前配置重启文件夹监听。配置关着或校验不过就只停不启。 */
function restartWatcher() {
  if (!watcher) return;
  const r = watcher.start(cfg);
  if (!r.ok && r.reason && r.reason !== 'disabled') notify(`文件夹监听没启动：${r.reason}`);
  pushState();
}

/**
 * 弹多选文件对话框并入队。托盘「导入音频文件…」与设置页的选择按钮共用它。
 * @returns {Promise<{ok:boolean, added?:number, canceled?:boolean}>}
 */
async function pickAndImport() {
  const r = await dialog.showOpenDialog({
    title: '选择要转写的音频文件',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '音频', extensions: importerMod.EXTS }, { name: '全部文件', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths || r.filePaths.length === 0) return { ok: false, canceled: true };
  const added = importQueue.add(r.filePaths);
  openSettings('import'); // 已经开着就只切标签页
  return added;
}

/** 「测试连接」用的 0.5 秒 440Hz 正弦，peak 显著高于 500 不会被静音拦截。 */
function testTone() {
  const n = 8000;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16000));
  return out;
}

/**
 * 启动时记一行权限现状，排障从日志就能看出是哪块权限缺。
 * 只读查询，不弹任何系统提示（真正的申请在 ensureMicAccess，首次录音之前）。
 * 两个 API 都是 macOS 专属，整段门控在 darwin 分支里（评审 N1）。
 */
function logPermissionStatus() {
  if (process.platform !== 'darwin') {
    logger.info(MOD, `权限：平台 ${process.platform}，麦克风与辅助功能无需预检`);
    return;
  }
  let mic = 'unknown';
  try {
    mic = systemPreferences.getMediaAccessStatus('microphone');
  } catch (e) {
    logger.warn(MOD, `查询麦克风权限失败：${e && e.message}`);
  }
  logger.info(MOD, `权限：麦克风=${mic} 辅助功能=${hotkeysMod.accessibilityTrusted()} 安全存储=${encryptionOk}`);
}

function bootstrap() {
  paths.ensureDirs();
  logger.info(MOD, `启动 ${app.getName()} v${app.getVersion()} on ${process.platform}`);

  // ① safeStorage 必须在 whenReady 之后问，ready 之前不可靠
  encryptionOk = secret.available();
  if (!encryptionOk) {
    logger.error(MOD, 'safeStorage 不可用：禁用一切 ASR 功能，不退化成明文存储');
    notify('当前系统无法安全存储密钥，语音识别功能已禁用');
  }

  cfg = config.load();
  logPermissionStatus();
  if (process.platform === 'darwin') app.dock.hide();

  // ② 隐藏 recorder 窗
  createRecorderWindow();

  // ③ 会话状态机
  session = sessionMod.create({});

  // ④ 热键（四层降级都在 hotkeys 里）
  hotkeys = hotkeysMod.createController({
    saveMode: (m) => { config.save({ 热键: { 模式: m } }); cfg = config.load(); },
    notify,
  });

  // ④.5 解码传输 + 导入队列 + 文件夹监听（§24）
  decoder = createDecoder();
  importQueue = importerMod.create({
    decodeFile: (a) => decoder.start(a),
    transcribe: (args) => asr.transcribe({ ...args, creds: credsSnapshot() }),
    hotwords: hotwordsMod.load, // 每次重读，禁止缓存（不变量 6）
    cfg: () => cfg,
    transcriptDir: () => cfg.转录目录 || paths.defaultTranscriptDir(),
    chainCapacity: rawUploadCapacity,
    corrections: correctionsMod.load,
    applyCorrections: correctionsMod.apply,
    isRecording: () => session.state === 'recording',
    onChange: () => { pushState(); if (tray) tray.refreshMenu(); },
    notify,
  });
  watcher = watcherMod.create({
    enqueue: (list, opts) => importQueue.add(list, opts),
    transcriptDir: () => cfg.转录目录 || paths.defaultTranscriptDir(),
    notify,
    onStopped: () => {
      // 目录消失就把开关也关掉，不静默空转（§15-40）
      config.save({ watch: { enabled: false } });
      cfg = config.load();
      pushState();
    },
  });

  // ⑤ 托盘
  tray = trayMod.create({
    hotkeys,
    pending,
    history,
    asr: { currentLabel: currentProviderLabel, cooling: coolingProviders },
    copyText: (t) => clipboard.writeText(t),
    notify,
    onImport: () => pickAndImport().catch((e) => logger.error(MOD, `导入选择失败：${e && e.message}`)),
    onSettings: () => openSettings(),
    onOpenTranscriptDir: () => shell.openPath(cfg.转录目录 || paths.defaultTranscriptDir()),
    onOpenDataDir: () => shell.openPath(paths.dataDir()),
    onSponsor: () => openSettings('sponsor'),
    onResetProviders: () => { asr.resetCooldowns(); pending.clearStuck(); tray.refreshMenu(); },
    onRetryPending: () => pending.retryOldest({
      isRecording: () => session.state === 'recording',
      transcribeOne: retryOne,
      anyCooling: () => coolingProviders().length > 0,
    }),
    onQuit: () => { app.quit(); },
  });
  tray.init();

  // ⑥ IPC
  ipc.register(buildIpcDeps());

  // ⑦ 热键启动 + 事件接线
  hotkeys.on('short-toggle', () => handleSessionAction(session.handle('short-toggle')));
  hotkeys.on('long-toggle', () => handleSessionAction(session.handle('long-toggle')));
  hotkeys.on('mode', () => { tray.refreshMenu(); pushState(); });
  hotkeys.on('conflict', ({ which, accelerator }) => {
    notify(`热键 ${accelerator} 已被其他程序占用`);
    tray.warn(`${which} 热键被占用`);
  });
  const started = hotkeys.start(cfg);
  if (started.allFailed) openSettings('hotkeys'); // 首次默认键全失败 → 直接弹设置窗

  // ⑦.5 首次启动引导（§9）：一个后端都没配就直接打开后端页。
  // 目标用户是「对这方面没有概念的新同事」，等第一次说话失败才知道没配 key
  // 是最糟的首次体验。配好之后这段再也不会触发。
  else if (!asrStatusList().some((p) => p.hasKey)) {
    logger.info(MOD, '没有任何后端配了 key，打开首次启动引导');
    openSettings('backends', { guide: true });
  }

  // ⑧ 异步预热粘贴宿主（H2 ③）
  pasteMod.prewarm().then((ok) => logger.info(MOD, `粘贴宿主预热 ${ok ? '完成' : '未就绪'}`));

  // ⑧.5 开机自启与文件夹监听按配置落地
  try {
    app.setLoginItemSettings({ openAtLogin: !!cfg.开机自启 });
  } catch (e) {
    logger.warn(MOD, `同步开机自启失败：${e && e.message}`);
  }
  restartWatcher();

  // ⑨ 崩溃残留扫描 + 补转定时器
  pending.scanTmp();
  stopRetryLoop = pending.startRetryLoop({
    isRecording: () => session.state === 'recording',
    transcribeOne: retryOne,
    // 全 stuck 且没有后端在冷却时自愈清一次（评审 H1）：冷却到期是惰性判断、
    // 没有回调，不给这个出口的话网好了队列也再不会自己动。
    anyCooling: () => coolingProviders().length > 0,
  });

  // 到上限自动收尾（§5.2）
  setInterval(() => {
    const r = session.tick();
    if (r) handleSessionAction(r);
  }, 1000);

  // 睡眠：立即停录走完整流程，不丢数据
  powerMonitor.on('suspend', () => {
    if (session.state === 'recording') {
      logger.info(MOD, '系统即将睡眠，停录并走完整流程');
      stopRecording('suspend');
    }
  });

  if (cfg.历史保留天数 > 0) history.prune(cfg.历史保留天数);

  // ⑩ 热词自动提炼：启动后延迟 30 秒跑一次（不抢启动），之后每 6 小时查一次是否到期。
  // 到期判断在 autohotwords.dueNow 里按「上次跑完的时间 + 频率」算，所以
  // 开着不关机也不会漏，关机好几天再开也只会补跑一次。
  setTimeout(() => runAutoHotwords(false), 30000);
  setInterval(() => runAutoHotwords(false), 6 * 3600 * 1000);
}

/** 补转一条：结果一律存文件，不粘贴（光标早就不在原来的位置了）。 */
async function retryOne(item) {
  const meta = item.meta || {};
  // 队列里也可能是 .webm（录音时 PCM 轨一块都没收到，opus 是唯一副本）。
  // 这种条目没有 PCM、也不能切段，按「不可切的短输入」组链，时长用 sidecar 记的那个。
  const isWav = (item.ext || 'wav') === 'wav';
  const pcm = isWav ? wav.readPcm(item.path) : null;
  const hotwords = hotwordsMod.load();
  const r = await asr.transcribe({
    tracks: isWav
      ? { opus: null, wavPath: item.path }
      : { opus: fs.readFileSync(item.path), wavPath: null },
    mime: isWav ? undefined : 'audio/webm',
    durationSec: isWav
      ? meta.durationSec || pcm.length / 16000
      : (Number.isFinite(meta.durationSec) && meta.durationSec > 0 ? meta.durationSec : null),
    mode: isWav ? meta.mode || '短输入' : '短输入',
    hotwords,
    cfg,
    creds: credsSnapshot(),
  });
  const raw = (r.text || '').trim();
  if (raw === '') return { text: '' };
  if (hotwordsMod.looksLikeContextEcho(raw, hotwords)) return { text: '', echo: true };
  if (cfg.记录历史 !== false) history.append({ text: raw, mode: meta.mode, durationSec: meta.durationSec, provider: r.providerId });
  const { rules } = correctionsMod.load();
  const fixed = correctionsMod.apply(raw, rules).text; // 补转不过 polish（不变量 17）
  const saved = archive.save({
    text: fixed,
    durationSec: meta.durationSec || 0,
    audioPath: item.path,
    dir: cfg.转录目录 || paths.defaultTranscriptDir(),
    stamp: archive.stampOf(new Date()),
    deleteTmp: false,
  });
  // 补转是定时器驱动的，和 bootstrap 不是同一条生命周期：will-quit 里
  // stopRetryLoop() 与 tray.destroy() 在同一个同步块，已经在飞的这一轮仍可能在 destroy 之后落地。
  if (tray) tray.ok();
  return { text: fixed, mdPath: saved.mdPath };
}

// ───────────────────────── 生命周期 ─────────────────────────

// 两个实例会抢同一组全局热键，后者注册失败、前者行为诡异（不变量 10）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    logger.info(MOD, '第二个实例启动，把设置窗拉到前台');
    const w = openSettings();
    if (w) { w.show(); w.focus(); }
  });

  app.whenReady().then(bootstrap);

  // Windows 关窗不退出，只隐藏到托盘；退出只走托盘菜单
  app.on('window-all-closed', () => { /* 故意不 quit */ });

  app.on('will-quit', () => {
    if (stopRetryLoop) stopRetryLoop();
    if (watcher) watcher.stop();
    if (hotkeys) hotkeys.stop();
    pasteMod.shutdown();
    if (tray) tray.destroy();
    logger.info(MOD, '退出');
  });
}

module.exports = { ensureMicAccess, openSettings };
