'use strict';
// IPC 通道白名单——design.md §16 那张通道表的唯一事实源。
//
// main 注册（ipc.js）与两个 preload 的转发都必须从这里取名字，不许写字面量。
// test/ipc-channels.test.js 用正则扫源码，断言两件事（评审 M5 的挡板）：
//   ① 源码里出现的通道名全部在本表里；
//   ② 本表里每条通道都被至少一个 preload 暴露出去。
// 表里没有的名字一律不注册。
//
// 本文件不 require 任何东西（包括 electron），裸 Node 可直接加载。

/** 通道名常量。键名是代码里用的符号，值是实际通道名。 */
const CHANNELS = {
  CAPTURE_START: 'capture:start',
  CAPTURE_STOP: 'capture:stop',
  PCM_CHUNK: 'pcm:chunk',
  OPUS_DONE: 'opus:done',
  RECORDER_ERROR: 'recorder:error',
  DECODE_REQUEST: 'decode:request',
  DECODE_CHUNK: 'decode:chunk',
  DECODE_DONE: 'decode:done',
  STATE_CHANGED: 'state:changed',
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  HOTWORDS_GET: 'hotwords:get',
  HOTWORDS_SET: 'hotwords:set',
  HOTWORDS_MINE: 'hotwords:mine',
  HOTWORDS_MERGE: 'hotwords:merge',
  KEY_SET: 'key:set',
  KEY_HAS: 'key:has',
  KEY_TEST: 'key:test',
  HISTORY_LIST: 'history:list',
  CLIPBOARD_COPY: 'clipboard:copy',
  IMPORT_FILES: 'import:files',
  HOTKEY_REGISTER: 'hotkey:register',
  DIALOG_PICK_DIR: 'dialog:pickDir',
  SHELL_OPEN_DATA_DIR: 'shell:openDataDir',
  SHELL_OPEN_PATH: 'shell:openPath',
  SPONSOR_GET: 'sponsor:get',
  // §16 的通道表里没有这两条，是 FEAT-004 补的（plan 条目 25 的 Files 行点名要）：
  // 设置页的 provider 状态点（可用/未配置/冷却中+剩余秒数/已禁用）要实时读
  // asr.statusOf，而「重置后端状态」按钮是事实源要求的两个入口之一。
  // 塞进 config:get 的返回值里也能做，但那样配置与运行期状态就混成一个载荷，
  // 冷却剩余秒数每秒刷一次会把整份配置也跟着来回搬。
  ASR_STATUS: 'asr:status',
  ASR_RESET: 'asr:reset',
  // 追加需求二·二：一个输入框粘 Key → 探测它属于哪家。
  // 不能复用 key:test —— 那条要先知道 providerId，而这里要解决的恰恰是「不知道是哪家」。
  KEY_DETECT: 'key:detect',
  // 追加需求二·四：自动热词的台账管理（列表 / 移除 / 清空 / 黑名单 / 立刻跑一次）。
  // 四件事合成一条带 action 的通道，而不是开四条：它们是同一份资源的增删查。
  HOTWORDS_AUTO: 'hotwords:auto',
  // 单键键位录制（v0.1.1 ①）。开始/取消合成一条带 action 的通道，照 hotwords:auto 的先例。
  // 载荷 { action: 'start'|'cancel', which: 'short'|'long' }。
  HOTKEY_CAPTURE: 'hotkey:capture',
  // 录到键之后 main 回推结果：{ which, keycode, label, verdict, message }。
  // 不能用 invoke 的返回值顶替：用户可能 8 秒都不按，而键名与冲突判定只有 main 算得出
  // （keycodes.js 在 main 侧，renderer 碰不到）。
  HOTKEY_CAPTURED: 'hotkey:captured',
  // 强制重建音频图（v0.1.1 ④-a/-d）。零块的权威判定在 main 侧 collect()，
  // 判出来之后得有办法命令 renderer 丢掉那套僵尸图——这就是那条命令。
  // 不能靠 renderer 自己发现：它看到的 ctx.state 会说谎（实测自报 running 却一块不送）。
  CAPTURE_REBUILD: 'capture:rebuild',
};

// 每条通道的方向与机制。
//   dir: 'm2r' = main → renderer（preload 用 ipcRenderer.on 订阅）
//        'r2m' = renderer → main
//   mech: 'send'（ipcMain.on）/ 'invoke'（ipcMain.handle）
//   target: 哪个 renderer 窗口
const META = {
  'capture:start': { dir: 'm2r', mech: 'send', target: 'recorder' },
  'capture:stop': { dir: 'm2r', mech: 'send', target: 'recorder' },
  'pcm:chunk': { dir: 'r2m', mech: 'send', target: 'recorder' },
  'opus:done': { dir: 'r2m', mech: 'send', target: 'recorder' },
  'recorder:error': { dir: 'r2m', mech: 'send', target: 'recorder' },
  'decode:request': { dir: 'm2r', mech: 'send', target: 'recorder' },
  'decode:chunk': { dir: 'r2m', mech: 'send', target: 'recorder' },
  'decode:done': { dir: 'r2m', mech: 'send', target: 'recorder' },
  'state:changed': { dir: 'm2r', mech: 'send', target: 'settings' },
  'config:get': { dir: 'r2m', mech: 'invoke', target: 'settings' },
  'config:set': { dir: 'r2m', mech: 'invoke', target: 'settings' },
  'hotwords:get': { dir: 'r2m', mech: 'invoke', target: 'settings' },
  'hotwords:set': { dir: 'r2m', mech: 'invoke', target: 'settings' },
  'hotwords:mine': { dir: 'r2m', mech: 'invoke', target: 'settings' },
  'hotwords:merge': { dir: 'r2m', mech: 'invoke', target: 'settings' },
  'key:set': { dir: 'r2m', mech: 'invoke', target: 'settings' },
  'key:has': { dir: 'r2m', mech: 'invoke', target: 'settings' },
  'key:test': { dir: 'r2m', mech: 'invoke', target: 'settings' },
  'history:list': { dir: 'r2m', mech: 'invoke', target: 'settings' },
  'clipboard:copy': { dir: 'r2m', mech: 'invoke', target: 'settings' },
  'import:files': { dir: 'r2m', mech: 'invoke', target: 'settings' },
  'hotkey:register': { dir: 'r2m', mech: 'invoke', target: 'settings' },
  'dialog:pickDir': { dir: 'r2m', mech: 'invoke', target: 'settings' },
  'shell:openDataDir': { dir: 'r2m', mech: 'invoke', target: 'settings' },
  'shell:openPath': { dir: 'r2m', mech: 'invoke', target: 'settings' },
  'sponsor:get': { dir: 'r2m', mech: 'invoke', target: 'settings' },
  'asr:status': { dir: 'r2m', mech: 'invoke', target: 'settings' },
  'asr:reset': { dir: 'r2m', mech: 'invoke', target: 'settings' },
  'key:detect': { dir: 'r2m', mech: 'invoke', target: 'settings' },
  'hotwords:auto': { dir: 'r2m', mech: 'invoke', target: 'settings' },
  'hotkey:capture': { dir: 'r2m', mech: 'invoke', target: 'settings' },
  'hotkey:captured': { dir: 'm2r', mech: 'send', target: 'settings' },
  'capture:rebuild': { dir: 'm2r', mech: 'send', target: 'recorder' },
};

/** 全部通道名。 */
const ALL = Object.values(CHANNELS);

/**
 * 「renderer 方向」通道 = 表里每一条。
 * §16 的通道表只收录「有 renderer 一端」的通道（main 内部调用不走 IPC），
 * 所以这个集合等于 ALL——每条都必须被某个 preload 暴露出去，否则 renderer
 * 根本碰不到它，注册了也是死通道（这正是评审 M5 发现的那类漏项）。
 */
const RENDERER_CHANNELS = ALL.slice();

/** 按方向取通道名。 */
const byDir = (dir) => ALL.filter((c) => META[c].dir === dir);

/** recorder:error 的 kind 枚举（§16 校验落点）。 */
const ERROR_KINDS = ['mic', 'worklet', 'audio-context', 'decode'];

module.exports = { CHANNELS, META, ALL, RENDERER_CHANNELS, byDir, ERROR_KINDS };
