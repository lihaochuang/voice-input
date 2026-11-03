'use strict';
// 隐藏录音窗：opus + PCM 双轨采集（design.md §4.3）。
//
// 建图顺序一处不省：
//   getUserMedia(单声道，三个增强全关)
//     → new AudioContext({sampleRate:16000})       ← 采样率在 context 上强制
//       → src = createMediaStreamSource
//         ├─ AudioWorkletNode(pcm-worklet) → GainNode(gain=0) → ctx.destination
//         └─ MediaStreamAudioDestinationNode → MediaRecorder(webm;opus, 24kbps)
//
// 两个必须项（都是「静默劣化而不报错」那一类）：
// ① **worklet 必须接零增益 sink**。Chromium 的音频渲染是从 sink 反向拉取的，
//    不在任何 sink 上游的节点 process() 不会被周期调用，PCM 轨一个块都收不到，
//    而功能表面上一直「正常」。
// ② **await ctx.resume() 之后必须二次校验 state === 'running'**。隐藏窗里新建的
//    context 可能是 suspended，此时 worklet 不被回调**且** MediaStreamDestination
//    不出样本——症状与①一模一样。两个原因挂同一个症状，必须在建图时就分开，
//    所以这里直接抛 audio-context-<state> 走 §15-42 的 error 分支。
// resume() 的 promise 兑现不保证最终状态是 running（设备被独占、系统音频服务
// 异常时会回到 suspended），所以不能只 resume 不校验。

const api = window.vi;

let ctx = null;
let stream = null;
// src 必须和其他节点一样存成模块级变量。MediaStreamAudioSourceNode 在
// Chromium 里没有「播放中」的隐式引用，只当局部变量时会被 GC 掉，连带把
// 两条链一起掐断——症状与 sink 漏接、context 不 running 完全一样：graph 建
// 得「成功」，PCM 0 块、opus 只有容器头。实测踩过。
let srcNode = null;
let worklet = null;
let sink = null;
let dest = null;
let recorder = null;
let current = null; // {sessionId}
let pcmChunks = 0; // 本次会话回传了几块，给日志对照 ≈11±1 用
let graphDead = false; // 这套图已知坏了，下次录音重建

function report(kind, err) {
  const msg = typeof err === 'string' ? err : `${(err && err.name) || ''} ${(err && err.message) || err}`;
  api.reportError(kind, msg);
}

async function buildGraph() {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      // 三个增强必须显式关：autoGainControl 会把静音底噪拉到和说话同一量级，
      // 让静音阈值失效；noiseSuppression 会吃掉轻声词尾。Chromium 默认开着。
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  ctx = new AudioContext({ sampleRate: 16000 });
  srcNode = ctx.createMediaStreamSource(stream);
  if (ctx.state !== 'running') await ctx.resume();
  if (ctx.state !== 'running') throw new Error(`audio-context-${ctx.state}`);

  // 第三个「PCM 0 块」的原因，比 sink 漏接和 suspended 都更阴：
  // context 能停在 **state==='running' 但渲染器已经死了** 的状态——别的进程
  // 正占着麦克风、设备被切走时就是这样。Chromium 事后才抛一个 'error' 事件
  // （实测晚到 10 秒），在那之前 ensureGraph() 看 state 是 running 就一直复用
  // 这个死掉的 context，于是**每一次录音都录不到东西**。所以除了听 error，
  // 还要在 stop 时按「有没有收到块」自愈（见 markDead 的调用处）。
  // 这里原来给 ctx 挂过一个 onerror 回调 —— 已删，`BaseAudioContext` 没有这个事件，
  // 那只是个永不触发的自有属性（白等了一个兜底）。Chromium 那条
  // 'The AudioContext encountered an error from the audio device or the WebAudio renderer.'
  // 是内部 console 输出，唯一能截到它的地方是 main 的 console-message 回调，
  // 它会调 audiohealth.deviceError() 标记「下次录音前先重建」（main.js ④-c）。
  //
  // onstatechange 的闭包必须认自己那个 context：重建之后旧 context 关闭时也会回调一次，
  // 读模块级 ctx 就会把**刚建好的新图**标死，症状是每次录音都白重建一遍。
  const self = ctx;
  self.onstatechange = () => {
    if (self !== ctx) return; // 旧 context 的回调，与现在这套图无关
    if (ctx.state !== 'running') markDead('audio-context', `AudioContext 变成 ${ctx.state}`);
  };

  await ctx.audioWorklet.addModule('pcm-worklet.js');
  worklet = new AudioWorkletNode(ctx, 'pcm-worklet');
  // processor 构造或 process() 抛错时，节点照样存在、ctx 照样 running，
  // 只是永远不被回调——又一个「PCM 0 块」的无声原因。必须报出来。
  worklet.onprocessorerror = (e) => report('worklet', (e && e.message) || 'AudioWorkletProcessor 出错');
  dest = ctx.createMediaStreamDestination();
  sink = ctx.createGain();
  sink.gain.value = 0; // 不出声，避免把麦克风回放到扬声器

  srcNode.connect(worklet);
  worklet.connect(sink).connect(ctx.destination); // ← 缺这条 PCM 一块都收不到
  srcNode.connect(dest);

  worklet.port.onmessage = (e) => {
    if (!current) return;
    const arr = e.data; // Int16Array
    pcmChunks += 1;
    api.sendPcm(current.sessionId, new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
  };

  const track = stream.getAudioTracks()[0];
  // 建图后记一行现状。四种原因（sink 漏接 / context 不 running / context 死了 /
  // 设备拿错）症状都是「一块 PCM 都没有」，没有这行就只能靠猜。
  // eslint-disable-next-line no-console
  console.log(`graph ok: ctx=${ctx.state}/${ctx.sampleRate}Hz track=${track ? track.label : 'none'} enabled=${track && track.enabled} muted=${track && track.muted}`);
  if (track) {
    track.onended = () => {
      report('mic', '麦克风轨道结束（设备被拔出或被占用）');
      stopCapture();
    };
  }
}

/** 标记这套图不可用，下次录音重建。report 一次，不静默。 */
function markDead(kind, msg) {
  if (graphDead) return; // 同一次只报一次
  graphDead = true;
  report(kind, msg);
}

/**
 * 保证有一套可用的图。**必须串行**，这是实测踩出来的坑：
 * 日志 15:49:36~15:50:23 那四次「PCM 块 0 个、opus 0 字节」就是重入造出来的。
 * 当时麦克风权限框弹着，第一次 buildGraph() 卡在 getUserMedia 上不返回；
 * 用户 1.2 秒后又按一次键 → 第二次进来直接 `await teardown()`，把第一份正在建的
 * stream/ctx 清成 null 并 stop 掉 track，两条执行流互相踩，最后留下一个
 * 「ctx.state === 'running'、worklet 非空、但源流已经死了」的僵尸图——
 * 下面那行守卫判它健康就一直复用，于是**之后每次录音都零块**。
 * 所以先等在飞的那次建完再判守卫，而不是判完再建。
 *
 * 等锁必须用 **while 而不是 if**：那四次零块是四次重叠的会话，权限框挂着时
 * 第一次卡在 getUserMedia，后三次全排在同一个 building 上；第一次失败后
 * 这三个同时醒来，`if` 只在入口看一眼锁、醒来不回看，于是三个各自又建一遍图
 * （buildGraph 中间有三个 await，逐段赋值的 ctx/stream/srcNode/worklet 交错后
 * 还是那个僵尸图）。改成 while，醒来的调用方会重新回看锁、排到新的那次后面。
 */
let building = null;

/**
 * 把一次「改图」的操作排到在飞的那次后面，并自己占住锁。
 * teardown 也必须走这里：它在建图途中到达会把 ctx 置 null，让在飞的 buildGraph
 * 抛 TypeError（后果不致命，但那是条白跑的错误上报）。
 */
function serialize(fn) {
  const prev = building;
  const p = (async () => {
    if (prev) {
      try { await prev; } catch { /* 上一次的失败由它自己的调用方 report 过了 */ }
    }
    return fn();
  })();
  building = p;
  const release = () => { if (building === p) building = null; };
  p.then(release, release);
  return p;
}

async function ensureGraph() {
  while (building) {
    // 别管上一次成没成：成了下面守卫会放行，没成 graphDead/ctx 的状态会让它重建
    try { await building; } catch { /* 同上 */ }
  }
  if (!graphDead && ctx && ctx.state === 'running' && worklet) return;
  await serialize(async () => {
    await teardown();
    graphDead = false;
    await buildGraph();
  });
}

async function teardown() {
  try {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  } catch { /* 已停 */ }
  recorder = null;
  try {
    if (worklet) worklet.port.onmessage = null;
    if (worklet) worklet.disconnect();
    if (srcNode) srcNode.disconnect();
    if (sink) sink.disconnect();
    if (dest) dest.disconnect();
  } catch { /* 节点已释放 */ }
  if (stream) {
    for (const t of stream.getTracks()) {
      try { t.stop(); } catch { /* 已停 */ }
    }
  }
  if (ctx) {
    try { await ctx.close(); } catch { /* 已关 */ }
  }
  ctx = null; stream = null; srcNode = null; worklet = null; sink = null; dest = null;
}

async function startCapture({ sessionId }) {
  try {
    await ensureGraph();
  } catch (e) {
    const kind = /^audio-context-/.test((e && e.message) || '') ? 'audio-context'
      : /addModule|worklet/i.test((e && e.message) || '') ? 'worklet' : 'mic';
    report(kind, e);
    return;
  }
  current = { sessionId };
  pcmChunks = 0;
  try {
    // 不用 timeslice：分块拼接的 WebM 要自己处理头部，没必要。只在 onstop 取一个完整 Blob。
    recorder = new MediaRecorder(dest.stream, {
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 24000,
    });
  } catch (e) {
    report('worklet', e); // MediaRecorder 不支持该 mime 时 PCM 轨仍可用，走降级
    recorder = null;
    return;
  }
  const blobs = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) blobs.push(e.data); };
  recorder.onerror = (e) => report('worklet', (e && e.error) || 'MediaRecorder 出错');
  recorder.onstop = async () => {
    const sid = current ? current.sessionId : sessionId;
    const got = pcmChunks;
    try {
      const blob = new Blob(blobs, { type: 'audio/webm' });
      const ab = await blob.arrayBuffer();
      api.sendOpus(sid, new Uint8Array(ab));
    } catch (e) {
      report('worklet', e); // main 侧 3 秒超时后会降级按 WAV 上传
    }
    // 自愈的**快路径**：一块都没收到说明这套图是死的（设备被占、渲染器挂了）。
    // 不标脏的话下一次录音还会复用它，于是每次都录不到东西（实测如此）。
    // 但这条不是唯一兜底 —— 权威判定在 main 侧 collect()：MediaRecorder 压根没起来时
    // （权限框挂住 ensureGraph）onstop 根本不发生，这里一次都不会跑到，
    // 而 main 每次会话都拿得到 chunkCount，由它经 capture:rebuild 命令重建（见 onRebuild）。
    if (got === 0) markDead('audio-context', '本次录音没有收到任何 PCM 块，已标记音频图重建');
  };
  recorder.start();
}

function stopCapture() {
  try {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  } catch (e) {
    report('worklet', e);
  }
  current = null;
}

api.onStart((p) => { startCapture(p || {}); });
api.onStop(() => { stopCapture(); });
// main 判定零块后的强制重建。**无条件**销毁，不看 ctx.state —— 实测它会说谎
// （自报 running/16000Hz、track enabled=true，却一块 PCM 都不送）。
// 只置脏 + teardown，不在这里重建：下次 startCapture 的 ensureGraph 会建，
// 那时才知道该用哪个设备。teardown 走 serialize 排到在飞的那次建图后面——
// 直接调会在建图途中把 ctx 置 null，让那半套图抛 TypeError。
if (api.onRebuild) {
  api.onRebuild(() => {
    graphDead = true;
    serialize(() => teardown()).catch(() => { /* 本来就是要扔掉它 */ });
  });
}

// ───────────────────── 导入音频的解码（§24.2，评审 H3） ─────────────────────
//
// 为什么解码放在这个隐藏窗里：整个应用只有这里有 Web Audio，而 decodeAudioData
// 复用的是 Chromium 自带的 mp3/aac/m4a/flac/ogg/opus/wav/webm 解码器，零新依赖。
//
// 内存纪律，这是 1 小时面试录音能不能导进来的全部原因：
// ① 文件字节**不走 ipcRenderer**，走 main 侧 MessageChannelMain 的端口分块送来，
//    这里按已知总长一次性开好一块 Uint8Array 回填（不做 concat，不留中间副本）；
// ② PCM **按段分块回传**，main 边收边 appendPcm 落盘，renderer 不留整份 PCM。
// 唯一躲不开的大块是 decodeAudioData 的输出 AudioBuffer（1 小时 16k 单声道约
// 230MB float32），所以 main 侧用 DECODE_MAX_BYTES 封住入口，真撑爆了
// render-process-gone 会被当成这个 job 解码失败、走原样上传降级。
const DECODE_BATCH = 16384; // 样本数；回传 32KB/块，低于 ipc.js 的 64KB 上限

function f32ToI16(ch, at, end) {
  const out = new Int16Array(end - at);
  for (let i = 0; i < out.length; i += 1) {
    let v = ch[at + i];
    if (v > 1) v = 1; else if (v < -1) v = -1;
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

// 多久没有新 chunk 就判这次送字节死了。按「上次收到数据」滑动判，不按总时长：
// 150MB 本来就要送一会儿，拿总时长当上限会把正常的大文件误杀。
const RECV_IDLE_TIMEOUT_MS = 60000;
/**
 * 从端口上把 size 字节收齐。
 * 必须有看门狗：MessagePort 在 Chromium 里没有 close 事件，main 侧只要在 done 之前
 * settle()（送字节途中 readSync 抛错、appendPcm 写盘失败、10 分钟解码超时）就 port1.close()，
 * 消息流一断这个 promise 会永久 pending，而 recorder 是长期存活的进程，
 * 那块最大 150MB 的 bytes 就被闭包一直引用着，堆几次连录音一起拖垮。
 */
function receiveBytes(port, size) {
  return new Promise((resolve, reject) => {
    let bytes = new Uint8Array(size);
    let at = 0;
    let timer = null;
    const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const arm = () => {
      stop();
      timer = setTimeout(() => {
        bytes = null; // 解引用，别让超时的这块留在闭包里
        reject(new Error(`等字节超时：${RECV_IDLE_TIMEOUT_MS / 1000} 秒没有新数据（收到 ${at}/${size}）`));
      }, RECV_IDLE_TIMEOUT_MS);
    };
    const die = (msg) => { stop(); bytes = null; reject(new Error(msg)); };
    port.onmessage = (e) => {
      const d = e.data || {};
      if (!bytes) return; // 已经判失败，后到的消息直接丢
      if (d.done) {
        stop();
        if (at !== size) die(`字节数不对：收到 ${at}，应为 ${size}`);
        else resolve(bytes);
        return;
      }
      if (!d.chunk) return;
      const part = new Uint8Array(d.chunk);
      if (at + part.length > size) { die('字节数超过声明的长度'); return; }
      bytes.set(part, at);
      at += part.length;
      arm();
    };
    port.onmessageerror = () => die('端口消息错误');
    arm();
    port.start();
  });
}

async function runDecode(port, { jobId, size }) {
  if (!jobId) return;
  let tmp = null;
  try {
    const bytes = await receiveBytes(port, size);
    tmp = new AudioContext({ sampleRate: 16000 });
    // decodeAudioData 会 detach 这个 ArrayBuffer，正好——我们也不需要它了
    const buf = await tmp.decodeAudioData(bytes.buffer);
    // 多声道先平均混成单声道（手机录的 m4a 常是立体声，只取左声道会丢一半信息）
    const n = buf.length;
    const chans = [];
    for (let c = 0; c < buf.numberOfChannels; c += 1) chans.push(buf.getChannelData(c));
    const mono = chans.length === 1
      ? chans[0]
      : (() => {
        const m = new Float32Array(n);
        for (let i = 0; i < n; i += 1) {
          let s = 0;
          for (let c = 0; c < chans.length; c += 1) s += chans[c][i];
          m[i] = s / chans.length;
        }
        return m;
      })();
    for (let at = 0; at < n; at += DECODE_BATCH) {
      const seg = f32ToI16(mono, at, Math.min(at + DECODE_BATCH, n));
      api.sendDecodeChunk(jobId, new Uint8Array(seg.buffer));
    }
    api.sendDecodeDone(jobId, true);
  } catch (e) {
    // amr 几乎确定不在 Chromium 的支持列表里，这条路一定会被走到。
    // main 侧据此走「原文件原样上传」降级，不是硬失败。
    api.sendDecodeDone(jobId, false, `${(e && e.name) || ''} ${(e && e.message) || e}`);
  } finally {
    try { if (tmp) await tmp.close(); } catch { /* 已关 */ }
    try { port.close(); } catch { /* 已关 */ }
  }
}

// 端口由 preload 用 window.postMessage 交过来（MessagePort 过不了 contextBridge）
window.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || !d.__viDecode || !e.ports || !e.ports[0]) return;
  runDecode(e.ports[0], d.__viDecode);
});
