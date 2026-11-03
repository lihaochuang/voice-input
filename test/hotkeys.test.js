'use strict';
// 热键纯逻辑：加速键校验、单键防误触、抑制窗口、键码与文案表。
const test = require('node:test');
const assert = require('node:assert');

const hk = require('../src/main/hotkeys');

const TAB = 15; // UiohookKey.Tab

test('validate：合法与非法四条', () => {
  assert.strictEqual(hk.validate('Control+Shift+Space').ok, true);
  assert.strictEqual(hk.validate('Space').ok, false, '没有修饰键');
  assert.strictEqual(hk.validate('Control+Shift').ok, false, '只有修饰键');
  assert.strictEqual(hk.validate('Control+Shift+A+B').ok, false, '两个主键');
});

test('validate：空、空白、尾部加号都拒', () => {
  assert.strictEqual(hk.validate('').ok, false);
  assert.strictEqual(hk.validate('   ').ok, false);
  assert.strictEqual(hk.validate('Control+ Shift+A').ok, false);
  assert.strictEqual(hk.validate('Control+A+').ok, false);
  assert.strictEqual(hk.validate(undefined).ok, false);
});

test('validate：常用默认键都合法', () => {
  for (const a of ['Control+Shift+L', 'CommandOrControl+Alt+V', 'Alt+Shift+F1']) {
    assert.strictEqual(hk.validate(a).ok, true, a);
  }
});

test('干净按下再松开 → 触发 toggle', () => {
  const s = hk.createState('darwin');
  assert.strictEqual(hk.feed({ type: 'down', keycode: 3640, t: 100 }, s), null);
  assert.strictEqual(hk.feed({ type: 'up', keycode: 3640, t: 200 }, s), 'short-toggle');
  assert.strictEqual(s.holding, null);
});

test('长录音键同理', () => {
  const s = hk.createState('darwin');
  hk.feed({ type: 'down', keycode: 3676, t: 1 }, s);
  assert.strictEqual(hk.feed({ type: 'up', keycode: 3676, t: 2 }, s), 'long-toggle');
});

test('holding 期间有别的键按下 → contaminated → 松手丢弃（防误触）', () => {
  const s = hk.createState('darwin');
  hk.feed({ type: 'down', keycode: 3640, t: 1 }, s);
  hk.feed({ type: 'down', keycode: TAB, t: 2 }, s);
  assert.strictEqual(s.contaminated, true);
  assert.strictEqual(hk.feed({ type: 'up', keycode: 3640, t: 3 }, s), null, 'Alt+Tab 不许开录音');
  assert.strictEqual(s.holding, null);
  assert.strictEqual(s.contaminated, false, '丢弃后状态要清干净');
});

test('别的键松开时不清 holding 状态', () => {
  const s = hk.createState('darwin');
  hk.feed({ type: 'down', keycode: 3640, t: 1 }, s);
  hk.feed({ type: 'up', keycode: 3613, t: 2 }, s);
  assert.strictEqual(s.holding, 3640);
  assert.strictEqual(hk.feed({ type: 'up', keycode: 3640, t: 3 }, s), 'short-toggle');
});

test('判定不看按住时长：按 5 秒也算一次单击', () => {
  const s = hk.createState('darwin');
  hk.feed({ type: 'down', keycode: 3640, t: 0 }, s);
  assert.strictEqual(hk.feed({ type: 'up', keycode: 3640, t: 5000 }, s), 'short-toggle');
});

test('suppress 窗口内全部事件被丢（防自己发的 Cmd+V 自激）', () => {
  const s = hk.createState('darwin');
  hk.suppressIn(s, 400, 1000);
  assert.strictEqual(hk.feed({ type: 'down', keycode: 3640, t: 1100 }, s), null);
  assert.strictEqual(hk.feed({ type: 'up', keycode: 3640, t: 1200 }, s), null);
  assert.strictEqual(s.holding, null, '抑制期内连状态都不该改');
  // 窗口过了就恢复
  assert.strictEqual(hk.feed({ type: 'down', keycode: 3640, t: 1500 }, s), null);
  assert.strictEqual(hk.feed({ type: 'up', keycode: 3640, t: 1600 }, s), 'short-toggle');
});

test('四个 KEYMAP 值都是正整数（有人改回 C 常量名这条立刻红）', () => {
  const vals = [
    hk.KEYMAP.darwin.short, hk.KEYMAP.darwin.long,
    hk.KEYMAP.win32.short, hk.KEYMAP.win32.long,
  ];
  assert.strictEqual(vals.length, 4);
  for (const v of vals) {
    assert.ok(Number.isInteger(v), `${v} 不是整数——很可能写成了 VC_ALT_R 这类 C 枚举名`);
    assert.ok(v > 0, `${v} 必须 > 0`);
  }
  assert.strictEqual(hk.KEYMAP.darwin.short, 3640);
  assert.strictEqual(hk.KEYMAP.darwin.long, 3676);
  assert.strictEqual(hk.KEYMAP.win32.short, 3640);
  assert.strictEqual(hk.KEYMAP.win32.long, 3613);
});

test('KEY_LABEL 两平台四个值都非空，且 darwin 分支不含「右 Alt」', () => {
  for (const p of ['darwin', 'win32']) {
    for (const w of ['short', 'long']) {
      assert.ok(hk.KEY_LABEL[p][w] && hk.KEY_LABEL[p][w].length > 0, `${p}.${w} 为空`);
    }
  }
  const mac = `${hk.KEY_LABEL.darwin.short} ${hk.KEY_LABEL.darwin.long}`;
  assert.doesNotMatch(mac, /右 Alt/, 'macOS 上那个键叫右 Option，不叫右 Alt');
  assert.doesNotMatch(mac, /右 Ctrl/);
  assert.strictEqual(hk.KEY_LABEL.darwin.short, '右 Option');
  assert.strictEqual(hk.KEY_LABEL.darwin.long, '右 Command');
  assert.strictEqual(hk.KEY_LABEL.win32.short, '右 Alt');
  assert.strictEqual(hk.KEY_LABEL.win32.long, '右 Ctrl');
});

test('labelFor / keymapFor 未知平台退到 win32', () => {
  assert.deepStrictEqual(hk.keymapFor('linux'), hk.KEYMAP.win32);
  assert.deepStrictEqual(hk.labelFor('linux'), hk.KEY_LABEL.win32);
});

test('win32 的 state 认 3613 为长录音键', () => {
  const s = hk.createState('win32');
  hk.feed({ type: 'down', keycode: 3613, t: 1 }, s);
  assert.strictEqual(hk.feed({ type: 'up', keycode: 3613, t: 2 }, s), 'long-toggle');
});

test('非 darwin 上 accessibilityTrusted 直接返回 true（平台门控，评审 N1）', () => {
  if (process.platform === 'darwin') return; // darwin 上会去碰 electron，这里只验门控
  assert.strictEqual(hk.accessibilityTrusted(), true);
});

test('SUPPRESS_MS 覆盖 osascript 的回写延迟量级', () => {
  assert.ok(hk.SUPPRESS_MS >= 300, '太短会被自己发的 Cmd+V 误吃');
  assert.ok(hk.SUPPRESS_MS <= 1000, '太长会吃掉用户的下一次按键');
});
test('mode / reason / accelerators 必须是活 getter，不能是快照（托盘文案永停「组合键」的那个 bug）', () => {
  // createController 只建 EventEmitter、不碰 electron，裸 Node 可直接构造。
  const c = hk.createController({ platform: 'darwin' });
  for (const k of ['mode', 'reason', 'accelerators']) {
    const d = Object.getOwnPropertyDescriptor(c, k);
    assert.strictEqual(typeof d.get, 'function',
      `${k} 必须用 Object.defineProperties 定义：Object.assign 会把 getter 求值成快照，托盘「热键模式」会永久停在 combo`);
    assert.strictEqual(d.value, undefined,
      `${k} 成了数据属性，说明 getter 已被 Object.assign 求值成快照`);
  }
});
