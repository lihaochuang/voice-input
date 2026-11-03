'use strict';
// 双模式热键（design.md §5.1）：single（uiohook 全局钩子，默认）优先，
// 四层自动降级到 combo（globalShortcut 组合键）。
//
// 三个踩坑点，改回去就坏：
// ① KEYMAP 用 **UiohookKey 的数字常量**，不是 libuiohook 的 C 枚举名。
//    VC_ALT_R / VC_META_R / VC_CONTROL_R 只存在于 C 头文件里，uiohook-napi
//    的 JS 侧拿这几个名字是 undefined，比较永远不等、主交互直接哑掉（评审 H3）。
// ② KEY_LABEL 必须按平台取文案：macOS 上显示「右 Alt」是错的，那个键叫
//    右 Option（评审 N4）。
// ③ validate() 是纯函数，副作用（真正去 register）单独放 tryRegister()，
//    否则裸 Node 的单测没法测（评审 M8）。
// ④ createController 返回的 mode / reason / accelerators 必须用
//    Object.defineProperties 定义，**不能**塞进 Object.assign 的对象字面量里：
//    Object.assign 对 source 做 [[Get]]，getter 会被当场求值成普通数据属性，
//    于是 hotkeys.mode 被永久冻在初值 'combo'。后果是托盘「热键模式」那行和
//    设置页顶部永远显示「组合键」，而同一个菜单里 describe()（普通方法，读闭包活变量）
//    却显示「右 Option 单击」——一个菜单两种事实。test/hotkeys.test.js 有回归断言。
//
// ⑤ 单键键位**不再写死**：start(cfg) 从 cfg.热键.单键短输入 / 单键长录音 取，
//    键码表与冲突规则搬到了纯模块 keycodes.js（config.js 也要用它）。
//    下面的 KEYMAP / KEY_LABEL 只是「默认值」的别名，保留导出是因为托盘与老测试在用。
// ⑥ 录制键位期间（beginCapture）feed() 一律不判定，否则用户为了录键按下的那一下
//    会顺手开一次录音。录制期按下的键**不会被拦住**，照常传给前台应用（uiohook 不支持吞事件）。
//
// 加载期不碰 electron，也不碰 uiohook-napi：两者都在函数体里 require。
const fs = require('fs');
const EventEmitter = require('events');
const logger = require('./logger');
const paths = require('./paths');
const keycodes = require('./keycodes');

const MOD = 'hotkeys';

// ───────────────────────── 纯常量与纯函数 ─────────────────────────

// 键码表的事实源是 keycodes.js（写死数值的理由见那个文件顶部 ①）。
// 这三张表只是「默认键位」的视图，留着是因为托盘与 test/hotkeys.test.js 在用；
// 用户自定义的键位走 state.targets，不在这里。
const KEYCODE = {
  AltRight: keycodes.KEY.AltRight,
  MetaRight: keycodes.KEY.MetaRight,
  CtrlRight: keycodes.KEY.CtrlRight,
};

/** 平台**默认**键位。short = 短输入，long = 长录音。与 keycodes.DEFAULTS 深等（有测试盯着）。 */
const KEYMAP = {
  darwin: { ...keycodes.DEFAULTS.darwin },
  win32: { ...keycodes.DEFAULTS.win32 },
};

/** 默认键位的人类可读键名（托盘与设置页文案，评审 N4）。 */
const KEY_LABEL = {
  darwin: {
    short: keycodes.labelOf(KEYMAP.darwin.short, 'darwin'),
    long: keycodes.labelOf(KEYMAP.darwin.long, 'darwin'),
  },
  win32: {
    short: keycodes.labelOf(KEYMAP.win32.short, 'win32'),
    long: keycodes.labelOf(KEYMAP.win32.long, 'win32'),
  },
};

const SUPPRESS_MS = 400; // 覆盖 osascript 80~150ms 与 PowerShell 宿主 ~50ms 的回写延迟
const SENTINEL_HEALTHY_MS = 10000; // 钩子健康运行多久后删哨兵
const ACCESSIBILITY_RECHECK_MS = 30000; // 辅助功能权限复查间隔（仅 darwin）
const MAX_CALLBACK_ERRORS = 2; // 回调连续抛错几次就切 combo

const keymapFor = (platform = process.platform) => KEYMAP[platform] || KEYMAP.win32;
const labelFor = (platform = process.platform) => KEY_LABEL[platform] || KEY_LABEL.win32;

const MODIFIERS = new Set([
  'command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl',
  'alt', 'option', 'altgr', 'shift', 'super', 'meta',
]);

/**
 * accelerator 合法性：≥1 个修饰键 + 恰好 1 个主键。纯函数，不碰 electron。
 * 真正能不能注册成功（会不会被别的程序占用）由 tryRegister() 负责。
 */
function validate(accelerator) {
  if (typeof accelerator !== 'string' || accelerator.trim() === '') {
    return { ok: false, reason: 'empty' };
  }
  if (/\s/.test(accelerator)) return { ok: false, reason: 'whitespace' };
  const parts = accelerator.split('+').filter((s) => s !== '');
  if (parts.length !== accelerator.split('+').length) return { ok: false, reason: 'shape' };
  if (parts.length < 2) return { ok: false, reason: 'need-modifier' };
  const mods = parts.filter((p) => MODIFIERS.has(p.toLowerCase()));
  const keys = parts.filter((p) => !MODIFIERS.has(p.toLowerCase()));
  if (mods.length < 1) return { ok: false, reason: 'need-modifier' };
  if (keys.length !== 1) return { ok: false, reason: keys.length === 0 ? 'need-key' : 'too-many-keys' };
  return { ok: true };
}

/**
 * single 模式的判定状态。
 * @param keys 可选 {short, long} 数值键码（来自配置）。不给就用平台默认。
 */
function createState(platform = process.platform, keys = null) {
  const km = keymapFor(platform);
  const targets = {
    short: Number.isInteger(keys && keys.short) ? keys.short : km.short,
    long: Number.isInteger(keys && keys.long) ? keys.long : km.long,
  };
  return { holding: null, contaminated: false, downAt: 0, suppressUntil: 0, capturing: false, targets };
}

/** 设置抑制窗口：paste.js 发按键前调，防自己的 Cmd/Ctrl+V 被钩子吃成一次按键。 */
function suppressIn(state, ms = SUPPRESS_MS, now = Date.now()) {
  state.suppressUntil = now + ms;
  return state;
}

/**
 * 单键判定（纯函数）。event 只有数字 keycode——uiohook 的事件对象没有键名字段。
 *   down(target)        → 记 holding
 *   down(非 target)     → 正在 holding 时置 contaminated（防误触，实测必需）
 *   up(=== holding)     → contaminated ? 丢弃 : 触发 toggle；清状态
 *   up(其他)            → 不动状态
 * 抑制窗口内一律丢弃全部事件。
 * 判定不看按住时长：任何时长的「干净按下再松开」都算一次单击。
 * state.capturing（正在录制键位）时一律不判定，连状态都不改——否则用户为了
 * 录键按下的那一下会顺手开一次录音。
 */
function feed(event, state) {
  const { type, keycode, t } = event || {};
  const now = typeof t === 'number' ? t : Date.now();
  if (state.capturing) return null;
  if (state.suppressUntil && now < state.suppressUntil) return null;

  const { short, long } = state.targets;
  if (type === 'down') {
    if (keycode === short || keycode === long) {
      state.holding = keycode;
      state.contaminated = false;
      state.downAt = now;
    } else if (state.holding !== null) {
      state.contaminated = true;
    }
    return null;
  }
  if (type === 'up') {
    if (keycode !== state.holding) return null; // 别的键松开不清状态
    const dirty = state.contaminated;
    const which = state.holding === short ? 'short-toggle' : 'long-toggle';
    state.holding = null;
    state.contaminated = false;
    state.downAt = 0;
    return dirty ? null : which;
  }
  return null;
}

// ───────────────────────── 副作用：控制器 ─────────────────────────

/** 哨兵：start() 之前写、健康 10 秒后删。原生崩溃 JS 捕获不到，只能靠磁盘痕迹。 */
function sentinelExists() {
  try {
    return fs.existsSync(paths.sentinelPath());
  } catch {
    return false;
  }
}
function writeSentinel() {
  try {
    fs.writeFileSync(paths.sentinelPath(), String(Date.now()));
  } catch (e) {
    logger.warn(MOD, `写哨兵失败：${e && e.message}`);
  }
}
function clearSentinel() {
  try {
    fs.unlinkSync(paths.sentinelPath());
  } catch (e) {
    if (e && e.code !== 'ENOENT') logger.warn(MOD, `删哨兵失败：${e.message}`);
  }
}

/** macOS 辅助功能权限查询。**整段只在 darwin 调**（评审 N1：别的平台没这个 API）。 */
function accessibilityTrusted() {
  if (process.platform !== 'darwin') return true;
  try {
    // eslint-disable-next-line global-require
    return require('electron').systemPreferences.isTrustedAccessibilityClient(false);
  } catch (e) {
    logger.warn(MOD, `辅助功能查询失败，按未授权处理：${e && e.message}`);
    return false;
  }
}

/**
 * 控制器。emit 'short-toggle' / 'long-toggle' / 'mode' / 'conflict'。
 * session.js 只认这两个事件，不关心是 single 还是 combo（防误触在本模块消化掉）。
 */
function createController({ platform = process.platform, saveMode, notify } = {}) {
  const bus = new EventEmitter();
  const state = createState(platform);
  let mode = 'combo';
  let reason = '';
  let uio = null;
  let hookStarted = false;
  let callbackErrors = 0;
  let healthyTimer = null;
  let recheckTimer = null;
  let registered = { short: null, long: null };
  let capture = null; // 正在录制键位：{ which, onResult, timer }
  let swallowUp = null; // 刚录到的键，它配对的 keyup 要吞掉
  let startedForCapture = false; // 钩子是为了录制才起的（combo 模式下录完要停掉）

  const label = labelFor(platform);
  const setMode = (m, why) => {
    mode = m;
    reason = why || '';
    logger.info(MOD, `热键模式 = ${m}${why ? `（${why}）` : ''}`);
    bus.emit('mode', { mode: m, reason });
  };

  /** 对外：发按键前抑制自己的钩子。combo 模式下是空操作，但统一调省掉隐含前提。 */
  const suppress = (ms = SUPPRESS_MS) => suppressIn(state, ms);

  function stopHook() {
    if (healthyTimer) { clearTimeout(healthyTimer); healthyTimer = null; }
    if (recheckTimer) { clearInterval(recheckTimer); recheckTimer = null; }
    if (uio && hookStarted) {
      try {
        uio.uIOhook.stop();
      } catch (e) {
        logger.warn(MOD, `停钩子抛错：${e && e.message}`);
      }
    }
    hookStarted = false;
    clearSentinel();
  }

  /** combo：注册单个加速键。返回 false 必须被处理（被别的软件占用是常态）。 */
  function tryRegister(which, accelerator) {
    const v = validate(accelerator);
    if (!v.ok) return { ok: false, reason: v.reason };
    // eslint-disable-next-line global-require
    const { globalShortcut } = require('electron');
    const prev = registered[which];
    if (prev) {
      try { globalShortcut.unregister(prev); } catch { /* 没注册过 */ }
    }
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, () => {
        try {
          bus.emit(which === 'short' ? 'short-toggle' : 'long-toggle');
        } catch (e) {
          logger.error(MOD, `组合键回调抛错：${e && e.message}`);
        }
      });
    } catch (e) {
      logger.warn(MOD, `register 抛错：${e && e.message}`);
      ok = false;
    }
    if (!ok) {
      // 回滚到上一个可用键
      if (prev) {
        try { globalShortcut.register(prev, () => bus.emit(which === 'short' ? 'short-toggle' : 'long-toggle')); } catch { /* 回滚也失败就只剩另一个键 */ }
      }
      logger.warn(MOD, `${which} 加速键 ${accelerator} 注册失败（已被其他程序占用）`);
      bus.emit('conflict', { which, accelerator });
      return { ok: false, reason: 'occupied' };
    }
    registered[which] = accelerator;
    return { ok: true };
  }

  function startCombo(cfg) {
    const a = tryRegister('short', (cfg.热键 && cfg.热键.短输入) || 'Control+Shift+Space');
    const b = tryRegister('long', (cfg.热键 && cfg.热键.长录音) || 'Control+Shift+L');
    return { shortOk: a.ok, longOk: b.ok, allFailed: !a.ok && !b.ok };
  }

  function stopCombo() {
    try {
      // eslint-disable-next-line global-require
      const { globalShortcut } = require('electron');
      globalShortcut.unregisterAll();
    } catch (e) {
      logger.warn(MOD, `unregisterAll 抛错：${e && e.message}`);
    }
    registered = { short: null, long: null };
  }

  /** 四层降级：加载失败 → start 抛错 → 无辅助功能权限 → 上次崩溃的哨兵残留。 */
  function startSingle() {
    // 钩子已经在跑就直接认成功：键位是从 state.targets 读的，改完键位不需要重挂钩子。
    // 不守这一下的后果：每次录完键位都 saveConfig → setConfig → start(cfg) → 这里，
    // 于是又挂一对 keydown/keyup 监听、又起一个 recheckTimer（旧 handle 被覆盖、
    // 旧 interval 永不清）。第二次录制时 keydown 被两个监听各处理一次，第一个已
    // finishCapture 把 capturing 置 false，第二个就落到正常分支调 feed——重录同一个
    // 当前生效的键时真会顺手开一次录音，与文件头 ⑥ 的承诺矛盾。
    if (hookStarted) return { ok: true };
    if (sentinelExists()) {
      // 第 4 层：上次在钩子活跃期间非正常退出。强制 combo 并**持久化**，防启动循环。
      clearSentinel();
      if (saveMode) saveMode('combo');
      if (notify) notify('单键模式上次导致异常退出，已切到组合键，可在设置里手动再试');
      logger.error(MOD, '发现 hook.sentinel 残留，强制 combo 并持久化');
      return { ok: false, reason: '上次崩溃' };
    }
    if (process.platform === 'darwin' && !accessibilityTrusted()) {
      // 第 3 层：这正是已知崩溃案例的触发条件，提前判定比事后捕获可靠。
      return { ok: false, reason: '无辅助功能权限' };
    }
    try {
      // eslint-disable-next-line global-require
      uio = require('uiohook-napi'); // 第 1 层：预编译包缺平台 / .node 没 unpack / 被管控软件删掉
    } catch (e) {
      logger.warn(MOD, `uiohook-napi 加载失败：${e && e.message}`);
      return { ok: false, reason: '单键不可用' };
    }
    const onKey = (type) => (e) => {
      try {
        if (state.capturing) { onCaptureKey(type, e.keycode); return; }
        if (swallowUp !== null && type === 'up' && e.keycode === swallowUp) {
          swallowUp = null; // 刚录完键位的那一下松手，吞掉
          return;
        }
        const action = feed({ type, keycode: e.keycode, t: Date.now() }, state);
        if (action) bus.emit(action);
        callbackErrors = 0;
      } catch (err) {
        callbackErrors += 1;
        logger.error(MOD, `钩子回调抛错 ${callbackErrors} 次：${err && err.message}`);
        if (callbackErrors >= MAX_CALLBACK_ERRORS) {
          stopHook();
          setMode('combo', '单键回调连续异常');
        }
      }
    };
    writeSentinel();
    try {
      uio.uIOhook.on('keydown', onKey('down'));
      uio.uIOhook.on('keyup', onKey('up'));
      uio.uIOhook.start(); // 第 2 层
      hookStarted = true;
    } catch (e) {
      clearSentinel();
      logger.warn(MOD, `uIOhook.start 失败：${e && e.message}`);
      return { ok: false, reason: '单键启动失败' };
    }
    healthyTimer = setTimeout(clearSentinel, SENTINEL_HEALTHY_MS);
    // 权限运行中可被撤销，30 秒复查一次。**只在 darwin 起这个定时器**（评审 N1）。
    if (process.platform === 'darwin') {
      recheckTimer = setInterval(() => {
        if (!accessibilityTrusted()) {
          logger.warn(MOD, '辅助功能权限被撤销，切 combo');
          stopHook();
          setMode('combo', '辅助功能权限被撤销');
          startCombo(currentCfg);
        }
      }, ACCESSIBILITY_RECHECK_MS);
    }
    return { ok: true };
  }

  // ───────────── 按键录制（设置页「录制」按钮） ─────────────

  /** 收尾：清录制态，必要时把「只为录制而起」的钩子停掉。 */
  function cancelCapture() {
    if (capture && capture.timer) clearTimeout(capture.timer);
    capture = null;
    state.capturing = false;
    state.holding = null;
    state.contaminated = false;
    // swallowUp 也是录制残留：combo 模式下录完会 stopHook()，配对的 keyup 再也不会来，
    // 这个标记就一直挂着。之后切成单键模式、而那个键码正好等于生效的 short/long 时，
    // 第一次按它的 keyup 会被吞键分支截走、feed 收不到 up，这一下白按。
    swallowUp = null;
    if (startedForCapture) {
      startedForCapture = false;
      // combo 模式下钩子只是临时借用：留着它单键判定会和组合键一起触发，一次按键开两回录音。
      if (mode !== 'single') stopHook();
    }
  }

  function finishCapture(payload) {
    const cb = capture && capture.onResult;
    const which = capture && capture.which;
    cancelCapture();
    if (!cb) return;
    try {
      cb({ which, ...payload });
    } catch (e) {
      logger.error(MOD, `录制回调抛错：${e && e.message}`);
    }
  }

  /** 录制期的按键：取**第一个 keydown** 就算录到了，配对的 keyup 吞掉。 */
  function onCaptureKey(type, keycode) {
    if (type !== 'down') return;
    // 顺序不能反：finishCapture 会走 cancelCapture，而它要清 swallowUp（见那里的注释），
    // 先设就会被自己清掉，这一下的 keyup 漏进 feed。
    finishCapture({ keycode });
    swallowUp = keycode;
  }

  /**
   * 开始录制。钩子没在跑（combo 模式、或单键降级了）就先试着起一个，
   * 失败把原因原样回给界面——「点了录制没反应」是最难自查的症状。
   */
  function beginCapture({ which, timeoutMs = 8000, onResult } = {}) {
    if (which !== 'short' && which !== 'long') return { ok: false, reason: 'shape' };
    cancelCapture();
    if (!hookStarted) {
      const r = startSingle();
      if (!r.ok) return { ok: false, reason: r.reason };
      startedForCapture = true;
    }
    swallowUp = null;
    state.capturing = true;
    state.holding = null;
    state.contaminated = false;
    capture = { which, onResult, timer: null };
    capture.timer = setTimeout(() => finishCapture({ timeout: true }), timeoutMs);
    return { ok: true };
  }

  let currentCfg = { 热键: {} };

  /** 启动。cfg.热键.模式 为 'combo' 时直接走组合键，否则先试单键。 */
  function start(cfg) {
    currentCfg = cfg || { 热键: {} };
    // 单键键位来自配置（缺键或非法值退平台默认）。setConfig 里已有
    // `if (hotkeys && patch.热键) hotkeys.start(cfg)`，所以改完键位不用另加接线。
    const d = keycodes.defaultsFor(platform);
    const kk = currentCfg.热键 || {};
    state.targets.short = Number.isInteger(kk.单键短输入) ? kk.单键短输入 : d.short;
    state.targets.long = Number.isInteger(kk.单键长录音) ? kk.单键长录音 : d.long;
    const want = (currentCfg.热键 && currentCfg.热键.模式) || 'single';
    if (want === 'single') {
      const r = startSingle();
      if (r.ok) {
        setMode('single', '');
        return { mode: 'single' };
      }
      const c = startCombo(currentCfg);
      setMode('combo', r.reason);
      if (notify && r.reason === '无辅助功能权限') notify('单键热键需要辅助功能权限，已暂时切到组合键');
      return { mode: 'combo', reason: r.reason, ...c };
    }
    const c = startCombo(currentCfg);
    setMode('combo', '用户手动');
    return { mode: 'combo', ...c };
  }

  /** 模式热切换：stop 旧 → start 新，失败回滚。 */
  function switchMode(next) {
    const before = mode;
    if (next === mode) return { mode };
    if (mode === 'single') stopHook(); else stopCombo();
    currentCfg = { ...currentCfg, 热键: { ...(currentCfg.热键 || {}), 模式: next } };
    const r = start(currentCfg);
    if (r.mode !== next) {
      logger.warn(MOD, `切到 ${next} 失败，回滚 ${before}`);
      currentCfg = { ...currentCfg, 热键: { ...(currentCfg.热键 || {}), 模式: before } };
      if (mode === 'single') stopHook(); else stopCombo();
      return start(currentCfg);
    }
    if (saveMode) saveMode(next);
    return r;
  }

  function stop() {
    cancelCapture();
    stopHook();
    stopCombo();
  }

  // 三个活访问器单独走 defineProperties（见文件头踩坑 ④），放进下面的 Object.assign 会变成快照。
  Object.defineProperties(bus, {
    mode: { enumerable: true, get() { return mode; } },
    reason: { enumerable: true, get() { return reason; } },
    accelerators: { enumerable: true, get() { return { ...registered }; } },
  });
  return Object.assign(bus, {
    start,
    stop,
    switchMode,
    suppress,
    tryRegister,
    beginCapture,
    cancelCapture,
    state,
    label,
    /** 托盘与设置页的两行热键文案，按平台/模式取。 */
    describe() {
      // single 分支读 state.targets 而不是 label：键位是用户可改的，写死默认键名会说谎
      if (mode === 'single') {
        return {
          short: `${keycodes.labelOf(state.targets.short, platform)} 单击`,
          long: `${keycodes.labelOf(state.targets.long, platform)} 单击`,
        };
      }
      return {
        short: registered.short || (currentCfg.热键 && currentCfg.热键.短输入) || 'Control+Shift+Space',
        long: registered.long || (currentCfg.热键 && currentCfg.热键.长录音) || 'Control+Shift+L',
      };
    },
  });
}

module.exports = {
  KEYCODE,
  KEYMAP,
  KEY_LABEL,
  SUPPRESS_MS,
  SENTINEL_HEALTHY_MS,
  ACCESSIBILITY_RECHECK_MS,
  MAX_CALLBACK_ERRORS,
  keymapFor,
  labelFor,
  validate,
  createState,
  suppressIn,
  feed,
  createController,
  accessibilityTrusted,
  sentinelExists,
  writeSentinel,
  clearSentinel,
};
