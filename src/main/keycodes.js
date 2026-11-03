'use strict';
// uiohook 键码表、键名、平台默认键位、以及「这个键能不能当热键」的三条冲突规则。
//
// 为什么单独成一个模块：config.js（校验配置里的键位）和 hotkeys.js（判定按键）
// 都要用这张表。如果把它留在 hotkeys.js 里，config 就得反过来依赖 hotkeys，
// 而 hotkeys 要碰 electron / uiohook-napi——config 在裸 Node 单测里就加载不了。
// 所以本模块**不 require electron、不 require fs、不 require hotkeys**，纯数据 + 纯函数。
//
// 两个踩坑点：
// ① KEY 里的值是**写死的数值**，不是 require('uiohook-napi').UiohookKey 取来的。
//    钩子加载失败（预编译包缺平台 / .node 没 unpack / 被管控软件删掉）时这张表仍要能用，
//    托盘和设置页的键名文案都指着它。数值与包里常量的一致性由 test/keycodes.test.js
//    在包能加载时逐个对照（加载不了就跳过，它是 optionalDependency）。
// ② uiohook 的左侧修饰键常量名**没有 Left 后缀**（Ctrl / Alt / Shift / Meta），
//    右侧才有（CtrlRight / AltRight / …）。这里统一补成 CtrlLeft 之类，
//    免得读代码时把 Ctrl 当成「随便哪个 Ctrl」。对照测试里有一张名字映射表。

/** uiohook 键码（uiohook-napi@1.5.5 的 UiohookKey）。 */
const KEY = {
  // 修饰键
  CtrlLeft: 29, CtrlRight: 3613,
  AltLeft: 56, AltRight: 3640,
  ShiftLeft: 42, ShiftRight: 54,
  MetaLeft: 3675, MetaRight: 3676,
  CapsLock: 58,
  // 功能键
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  F11: 87, F12: 88,
  F13: 91, F14: 92, F15: 93, F16: 99, F17: 100, F18: 101, F19: 102,
  PrintScreen: 3639, ScrollLock: 70, NumLock: 69,
  // 字母
  A: 30, B: 48, C: 46, D: 32, E: 18, F: 33, G: 34, H: 35, I: 23, J: 36, K: 37, L: 38, M: 50,
  N: 49, O: 24, P: 25, Q: 16, R: 19, S: 31, T: 20, U: 22, V: 47, W: 17, X: 45, Y: 21, Z: 44,
  // 数字（主键区）
  Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6,
  Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  // 编辑与导航
  Space: 57, Enter: 28, Tab: 15, Backspace: 14, Escape: 1,
  Delete: 3667, Insert: 3666, Home: 3655, End: 3663, PageUp: 3657, PageDown: 3665,
  ArrowUp: 57416, ArrowLeft: 57419, ArrowRight: 57421, ArrowDown: 57424,
  // 标点
  Minus: 12, Equal: 13, BracketLeft: 26, BracketRight: 27, Semicolon: 39, Quote: 40,
  Backquote: 41, Backslash: 43, Comma: 51, Period: 52, Slash: 53,
  // 小键盘
  Numpad0: 82, Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad4: 75, Numpad5: 76,
  Numpad6: 77, Numpad7: 71, Numpad8: 72, Numpad9: 73,
  NumpadMultiply: 55, NumpadSubtract: 74, NumpadAdd: 78, NumpadDecimal: 83,
  NumpadDivide: 3637, NumpadEnter: 3612,
};

/** 平台默认键位。short = 短输入，long = 长录音。hotkeys.KEYMAP 必须与它深等。 */
const DEFAULTS = {
  darwin: { short: KEY.AltRight /* 右 Option */, long: KEY.MetaRight /* 右 Command */ },
  win32: { short: KEY.AltRight /* 右 Alt */, long: KEY.CtrlRight /* 右 Ctrl */ },
};

/** 未知平台退 win32，与 hotkeys.keymapFor 的口径保持一致。 */
const defaultsFor = (platform = process.platform) => DEFAULTS[platform] || DEFAULTS.win32;

// 两平台共用的键名。修饰键四个在下面按平台覆盖（macOS 那个键叫 Option，不叫 Alt）。
const BASE_LABEL = {
  [KEY.CapsLock]: 'Caps Lock',
  [KEY.PrintScreen]: 'PrintScreen', [KEY.ScrollLock]: 'ScrollLock', [KEY.NumLock]: 'Num Lock',
  [KEY.Space]: '空格', [KEY.Enter]: '回车', [KEY.Tab]: 'Tab',
  [KEY.Backspace]: '退格', [KEY.Escape]: 'Esc',
  [KEY.Delete]: 'Delete', [KEY.Insert]: 'Insert',
  [KEY.Home]: 'Home', [KEY.End]: 'End', [KEY.PageUp]: 'Page Up', [KEY.PageDown]: 'Page Down',
  [KEY.ArrowUp]: '↑', [KEY.ArrowLeft]: '←', [KEY.ArrowRight]: '→', [KEY.ArrowDown]: '↓',
  [KEY.Minus]: '-', [KEY.Equal]: '=', [KEY.BracketLeft]: '[', [KEY.BracketRight]: ']',
  [KEY.Semicolon]: ';', [KEY.Quote]: "'", [KEY.Backquote]: '`', [KEY.Backslash]: '\\',
  [KEY.Comma]: ',', [KEY.Period]: '.', [KEY.Slash]: '/',
  [KEY.NumpadMultiply]: '小键盘 *', [KEY.NumpadSubtract]: '小键盘 -',
  [KEY.NumpadAdd]: '小键盘 +', [KEY.NumpadDecimal]: '小键盘 .',
  [KEY.NumpadDivide]: '小键盘 /', [KEY.NumpadEnter]: '小键盘回车',
};
for (const n of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') BASE_LABEL[KEY[n]] = n;
for (let d = 0; d <= 9; d += 1) BASE_LABEL[KEY[`Digit${d}`]] = String(d);
for (let d = 0; d <= 9; d += 1) BASE_LABEL[KEY[`Numpad${d}`]] = `小键盘 ${d}`;
for (let f = 1; f <= 19; f += 1) if (KEY[`F${f}`] !== undefined) BASE_LABEL[KEY[`F${f}`]] = `F${f}`;

/** 按平台的人类可读键名（评审 N4：macOS 上显示「右 Alt」是错的）。 */
const LABEL = {
  darwin: {
    ...BASE_LABEL,
    [KEY.CtrlLeft]: '左 Control', [KEY.CtrlRight]: '右 Control',
    [KEY.AltLeft]: '左 Option', [KEY.AltRight]: '右 Option',
    [KEY.ShiftLeft]: '左 Shift', [KEY.ShiftRight]: '右 Shift',
    [KEY.MetaLeft]: '左 Command', [KEY.MetaRight]: '右 Command',
  },
  win32: {
    ...BASE_LABEL,
    [KEY.CtrlLeft]: '左 Ctrl', [KEY.CtrlRight]: '右 Ctrl',
    [KEY.AltLeft]: '左 Alt', [KEY.AltRight]: '右 Alt',
    [KEY.ShiftLeft]: '左 Shift', [KEY.ShiftRight]: '右 Shift',
    [KEY.MetaLeft]: '左 Win', [KEY.MetaRight]: '右 Win',
  },
};

/**
 * 键名。表里没有的返回「键码 N」——**绝不返回空串**：
 * 界面上那一行要是空的，用户就不知道自己录到了什么键。
 */
function labelOf(keycode, platform = process.platform) {
  const table = LABEL[platform] || LABEL.win32;
  return table[keycode] || `键码 ${keycode}`;
}

// ───────────────────── 三条冲突规则 ─────────────────────
//
// (a) 打字/导航键 → blocked：这类键按一下就会乱开录音，一律拒。
// (b) 短输入与长录音撞成同一个键 → 拒（checkPair，另见 config.js 的成对校验）。
// (c) 容易误触或被系统占用的键 → warn，但**允许强行设置**：
//     哪些键真的被占用只有用户自己知道（他可能已经在系统设置里改过），
//     我们没资格替他拒。界面上做二次确认就够了。

/** (a) 打字与导航键黑名单。字母/数字/标点/编辑导航/小键盘/CapsLock 全在内。 */
const BLOCKED = new Set([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((n) => KEY[n]),
  KEY.Digit0, KEY.Digit1, KEY.Digit2, KEY.Digit3, KEY.Digit4,
  KEY.Digit5, KEY.Digit6, KEY.Digit7, KEY.Digit8, KEY.Digit9,
  KEY.Space, KEY.Enter, KEY.Tab, KEY.Backspace, KEY.Escape,
  KEY.Delete, KEY.Insert, KEY.Home, KEY.End, KEY.PageUp, KEY.PageDown,
  KEY.ArrowUp, KEY.ArrowLeft, KEY.ArrowRight, KEY.ArrowDown,
  KEY.Minus, KEY.Equal, KEY.BracketLeft, KEY.BracketRight, KEY.Semicolon,
  KEY.Quote, KEY.Backquote, KEY.Backslash, KEY.Comma, KEY.Period, KEY.Slash,
  KEY.Numpad0, KEY.Numpad1, KEY.Numpad2, KEY.Numpad3, KEY.Numpad4,
  KEY.Numpad5, KEY.Numpad6, KEY.Numpad7, KEY.Numpad8, KEY.Numpad9,
  KEY.NumpadMultiply, KEY.NumpadSubtract, KEY.NumpadAdd, KEY.NumpadDecimal,
  KEY.NumpadDivide, KEY.NumpadEnter, KEY.NumLock,
  KEY.CapsLock,
]);

/** (c1) 左侧修饰键：和 Ctrl+C / Cmd+V 这类快捷键共用。 */
const LEFT_MODS = new Set([KEY.CtrlLeft, KEY.AltLeft, KEY.ShiftLeft, KEY.MetaLeft]);

/** (c2) macOS 默认把 F1~F12 分给了这些系统功能。 */
const MAC_FKEY_USE = {
  [KEY.F1]: '降低亮度', [KEY.F2]: '提高亮度', [KEY.F3]: '调度中心', [KEY.F4]: '聚焦搜索',
  [KEY.F5]: '听写', [KEY.F6]: '勿扰模式', [KEY.F7]: '上一首', [KEY.F8]: '播放/暂停',
  [KEY.F9]: '下一首', [KEY.F10]: '静音', [KEY.F11]: '显示桌面', [KEY.F12]: '调整音量',
};

const isBlocked = (keycode) => BLOCKED.has(keycode);

/**
 * 这个键能不能当单键热键。
 * @returns {{verdict:'ok'|'warn'|'blocked', message:string}}
 *   blocked 一律拒，warn 要用户二次确认，ok 直接存。
 */
function classify(keycode, platform = process.platform) {
  const name = labelOf(keycode, platform);
  if (!Number.isInteger(keycode) || keycode <= 0) {
    return { verdict: 'blocked', message: '没认出这个键，换一个试试' };
  }
  if (isBlocked(keycode)) {
    return {
      verdict: 'blocked',
      message: `「${name}」是日常打字或导航要用的键，选它会在你打字时乱触发录音，不能用`,
    };
  }
  if (LEFT_MODS.has(keycode)) {
    return {
      verdict: 'warn',
      message: '左侧修饰键和 Ctrl+C / Cmd+V 这类快捷键共用，按一下就可能误触发；建议改用右侧那几个',
    };
  }
  if (platform === 'darwin' && MAC_FKEY_USE[keycode]) {
    return {
      verdict: 'warn',
      message: `macOS 默认把 ${name} 给了「${MAC_FKEY_USE[keycode]}」，要用得先在键盘设置里改成标准功能键`,
    };
  }
  if (platform !== 'darwin' && keycode === KEY.PrintScreen) {
    return {
      verdict: 'warn',
      message: 'PrintScreen 被系统截图和各种截图工具抢着用，可能根本收不到这个键',
    };
  }
  if (platform !== 'darwin' && keycode === KEY.F1) {
    return { verdict: 'warn', message: 'Windows 上 F1 普遍是「帮助」，很多程序会把它抢走' };
  }
  return { verdict: 'ok', message: '' };
}

/** (b) 两个角色不能用同一个键。config 与 main 两处都要调（renderer 不可信）。 */
function checkPair(short, long) {
  if (short === long) {
    return { ok: false, reason: 'duplicate', message: '短输入和长录音不能用同一个键' };
  }
  return { ok: true };
}

/** 推荐键位：右侧四个修饰键 + F13~F19（基本没人占用）。给设置页做提示用。 */
const RECOMMENDED_KEYCODES = [
  KEY.AltRight, KEY.MetaRight, KEY.CtrlRight, KEY.ShiftRight,
  KEY.F13, KEY.F14, KEY.F15, KEY.F16, KEY.F17, KEY.F18, KEY.F19,
];
const recommendedFor = (platform = process.platform) =>
  RECOMMENDED_KEYCODES.map((keycode) => ({ keycode, label: labelOf(keycode, platform) }));
const RECOMMENDED = recommendedFor();

module.exports = {
  KEY,
  DEFAULTS,
  LABEL,
  BLOCKED,
  LEFT_MODS,
  MAC_FKEY_USE,
  RECOMMENDED,
  RECOMMENDED_KEYCODES,
  defaultsFor,
  labelOf,
  isBlocked,
  classify,
  checkPair,
  recommendedFor,
};
