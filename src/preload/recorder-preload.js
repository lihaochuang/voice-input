'use strict';
// 隐藏录音窗的 preload。只做 ipcRenderer 的转发，不含任何业务判断——
// renderer 是不可信输入源，全部校验在 main（design.md §16）。
//
// ⚠ 通道名在这里**必须写字面量**，不能 require('../main/ipc-channels')：
// sandbox:true 的 preload 只能 require electron 与少数被 polyfill 的内建模块，
// 相对路径的本地文件一律 `module not found`，整个 preload 加载失败 →
// window.vi 是 undefined → recorder.js 第一行就抛 → **按了热键什么都不发生，
// 而主进程侧只看到「PCM 块 0 个」**。实测踩过，别改回去。
//
// 白名单仍然只有一份（src/main/ipc-channels.js）：
// test/ipc-channels.test.js 扫这里的字面量，断言①全在白名单里、②白名单里
// 每条 renderer 方向通道都被某个 preload 暴露。漏项会在 npm test 里红。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vi', {
  // main → recorder
  onStart: (fn) => ipcRenderer.on('capture:start', (_e, payload) => fn(payload)),
  onStop: (fn) => ipcRenderer.on('capture:stop', (_e, payload) => fn(payload)),
  // main 判定本次会话零块后命令强制重建音频图（v0.1.1 ④）
  onRebuild: (fn) => ipcRenderer.on('capture:rebuild', (_e, payload) => fn(payload)),
  // decode:request 不在这里暴露成回调，见文件末尾那段：它带着一个
  // MessagePort，而 MessagePort 过不了 contextBridge。

  // recorder → main
  sendPcm: (sessionId, bytes) => ipcRenderer.send('pcm:chunk', { sessionId, bytes }),
  sendOpus: (sessionId, bytes) => ipcRenderer.send('opus:done', { sessionId, bytes }),
  reportError: (kind, msg) => ipcRenderer.send('recorder:error', { kind, msg }),
  sendDecodeChunk: (jobId, bytes) => ipcRenderer.send('decode:chunk', { jobId, bytes }),
  sendDecodeDone: (jobId, ok, reason) => ipcRenderer.send('decode:done', { jobId, ok, reason }),
});

// 导入解码的端口转交（§24.2 / 评审 H3）。
//
// decode:request 的载荷只有 {jobId, size}，**文件字节一个也不走这条 IPC**——
// 它们由 main 侧的 MessageChannelMain 分块送过来，端口跟着这条消息一起到。
//
// MessagePort 不能经 contextBridge 暴露（它不可结构化克隆），所以按 Electron
// 官方 recipe 用 window.postMessage 把端口交给主世界，让 recorder.js 自己收。
// 让 preload 代收再转给主世界的话，等于在内存里多复制一整份文件，而「1 小时
// 录音」正是这个功能的头号场景。
ipcRenderer.on('decode:request', (e, payload) => {
  window.postMessage({ __viDecode: payload || {} }, '*', e.ports);
});
