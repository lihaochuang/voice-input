'use strict';
// 设置窗的 preload。只做转发，不含业务判断（design.md §3.2 / §16）。
//
// ⚠ 通道名写字面量，理由同 recorder-preload.js 顶部那段：sandbox:true 的
// preload 不能 require 相对路径的本地模块，require 失败会让整个 preload 不加载。
// 白名单一致性由 test/ipc-channels.test.js 的静态扫描保证。
//
// pathForFile 必须是 webUtils.getPathForFile(file)，不是 File 的 path 属性：
// 后者自 Electron 32 起已被移除，而 electron.d.ts 里还残留着对应的声明，
// 所以写错了编译期无感、运行时拿到 undefined，症状是「拖进去没反应」。
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('vi', {
  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),

  // 热词
  getHotwords: () => ipcRenderer.invoke('hotwords:get'),
  setHotwords: (text) => ipcRenderer.invoke('hotwords:set', text),
  mineHotwords: () => ipcRenderer.invoke('hotwords:mine'),
  mergeHotwords: (words) => ipcRenderer.invoke('hotwords:merge', words),
  // 自动热词台账：action ∈ list | remove | clear | blacklist | unblacklist | run
  autoHotwords: (action, word) => ipcRenderer.invoke('hotwords:auto', { action, word }),

  // 密钥（key:has 只回掩码，永不回明文，§9）
  // detectKey：粘一个 Key 进来，main 去打各家的轻量端点看哪家认它
  detectKey: (key) => ipcRenderer.invoke('key:detect', { key }),
  setKey: (providerId, key) => ipcRenderer.invoke('key:set', { providerId, key }),
  hasKey: (providerId) => ipcRenderer.invoke('key:has', { providerId }),
  testKey: (providerId) => ipcRenderer.invoke('key:test', { providerId }),

  // 历史与剪贴板
  listHistory: (limit) => ipcRenderer.invoke('history:list', { limit }),
  copyText: (text) => ipcRenderer.invoke('clipboard:copy', { text }),

  // 热键
  registerHotkey: (which, accelerator) => ipcRenderer.invoke('hotkey:register', { which, accelerator }),
  // 单键键位录制：action ∈ start | cancel，which ∈ short | long
  captureHotkey: (action, which) => ipcRenderer.invoke('hotkey:capture', { action, which }),
  onHotkeyCaptured: (fn) => ipcRenderer.on('hotkey:captured', (_e, payload) => fn(payload)),

  // 目录与文件
  pickTranscriptDir: (kind) => ipcRenderer.invoke('dialog:pickDir', { kind }),
  openDataDir: () => ipcRenderer.invoke('shell:openDataDir'),
  // openPath 在 §16 通道表里但原方法清单漏了（评审 M5 同类漏项），补上。
  // main 侧只接受自己产出过的转录文件，不接受任意路径。
  openPath: (p) => ipcRenderer.invoke('shell:openPath', { path: p }),

  // 导入：拖拽进来的 File 对象靠 webUtils 取真实路径
  pathForFile: (file) => webUtils.getPathForFile(file),
  importFiles: (paths) => ipcRenderer.invoke('import:files', paths),

  // 后端运行期状态（状态点 + 冷却剩余秒数）与「重置后端状态」
  asrStatus: () => ipcRenderer.invoke('asr:status'),
  asrReset: (providerId) => ipcRenderer.invoke('asr:reset', { providerId }),

  // 赞助
  getSponsor: () => ipcRenderer.invoke('sponsor:get'),

  // main → settings
  onState: (fn) => ipcRenderer.on('state:changed', (_e, payload) => fn(payload)),
});
