'use strict';
// 键码表、键名、平台默认键位、三条冲突规则。纯逻辑，裸 Node 可跑。
const test = require('node:test');
const assert = require('node:assert');

const kc = require('../src/main/keycodes');

test('KEY 里每个值都是正整数（有人改回 VC_ALT_R 这类 C 枚举名立刻红）', () => {
  const names = Object.keys(kc.KEY);
  assert.ok(names.length > 80, `键码表只有 ${names.length} 项，像是被删过`);
  for (const n of names) {
    const v = kc.KEY[n];
    assert.ok(Number.isInteger(v), `KEY.${n} = ${v} 不是整数`);
    assert.ok(v > 0, `KEY.${n} = ${v} 必须 > 0`);
  }
});

test('写死的键码与 uiohook-napi 的常量逐个一致（包加载不了就跳过）', () => {
  let UiohookKey = null;
  try {
    // optionalDependency：CI 的裸 Node 环境可能根本没装它，加载失败不算测试失败
    // eslint-disable-next-line global-require
    UiohookKey = require('uiohook-napi').UiohookKey;
  } catch {
    return;
  }
  if (!UiohookKey) return;
  // uiohook 的左侧修饰键常量**没有 Left 后缀**，数字键直接叫 '1'…'0'
  const ALIAS = {
    CtrlLeft: 'Ctrl', AltLeft: 'Alt', ShiftLeft: 'Shift', MetaLeft: 'Meta',
    Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4',
    Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
  };
  for (const [name, value] of Object.entries(kc.KEY)) {
    const upstream = UiohookKey[ALIAS[name] || name];
    assert.strictEqual(upstream, value, `KEY.${name} 写的是 ${value}，uiohook 里是 ${upstream}`);
  }
});

test('defaultsFor：两平台的值 + 未知平台退 win32', () => {
  assert.deepStrictEqual(kc.defaultsFor('darwin'), { short: 3640, long: 3676 });
  assert.deepStrictEqual(kc.defaultsFor('win32'), { short: 3640, long: 3613 });
  assert.deepStrictEqual(kc.defaultsFor('linux'), kc.DEFAULTS.win32);
});

test('labelOf：按平台取名，表外的键也必须有非空文案', () => {
  assert.strictEqual(kc.labelOf(3640, 'darwin'), '右 Option');
  assert.strictEqual(kc.labelOf(3640, 'win32'), '右 Alt');
  assert.doesNotMatch(kc.labelOf(3640, 'darwin'), /右 Alt/, 'macOS 上那个键叫右 Option');
  assert.strictEqual(kc.labelOf(3676, 'darwin'), '右 Command');
  assert.strictEqual(kc.labelOf(91, 'darwin'), 'F13');
  const unknown = kc.labelOf(99999, 'darwin');
  assert.match(unknown, /键码/, '表外键码必须回「键码 N」，不能是空串');
  assert.ok(unknown.length > 0);
});

test('规则 (a) 打字/导航键 → blocked（字母、空格、方向键、小键盘、CapsLock）', () => {
  for (const code of [kc.KEY.A, kc.KEY.Space, kc.KEY.ArrowUp, kc.KEY.Numpad5, kc.KEY.CapsLock, kc.KEY.Digit1]) {
    const r = kc.classify(code, 'darwin');
    assert.strictEqual(r.verdict, 'blocked', `键码 ${code} 应该被拒`);
    assert.ok(r.message.length > 0, `键码 ${code} 被拒但没给原因`);
    assert.strictEqual(kc.isBlocked(code), true);
  }
});

test('规则 (c) 左侧修饰键与系统占用键 → warn，且允许强行设置', () => {
  for (const code of [kc.KEY.CtrlLeft, kc.KEY.MetaLeft]) {
    const r = kc.classify(code, 'darwin');
    assert.strictEqual(r.verdict, 'warn');
    assert.match(r.message, /右侧/);
  }
  // macOS 把 F1~F12 分给了亮度/音量/调度中心，文案要点名具体冲突
  const f11 = kc.classify(kc.KEY.F11, 'darwin');
  assert.strictEqual(f11.verdict, 'warn');
  assert.match(f11.message, /显示桌面/);
  assert.strictEqual(kc.classify(kc.KEY.F1, 'darwin').verdict, 'warn');
  // 同一个 F11 在 Windows 上没这个冲突
  assert.strictEqual(kc.classify(kc.KEY.F11, 'win32').verdict, 'ok');
  assert.strictEqual(kc.classify(kc.KEY.PrintScreen, 'win32').verdict, 'warn');
  assert.strictEqual(kc.classify(kc.KEY.F1, 'win32').verdict, 'warn');
});

test('右侧修饰键与 F13~F19 → ok', () => {
  for (const code of [kc.KEY.AltRight, kc.KEY.MetaRight, kc.KEY.F13, kc.KEY.F19]) {
    assert.strictEqual(kc.classify(code, 'darwin').verdict, 'ok', `键码 ${code} 应该放行`);
  }
  // 非整数 / 负数不是「ok」，界面不能把它存下去
  assert.strictEqual(kc.classify(undefined, 'darwin').verdict, 'blocked');
  assert.strictEqual(kc.classify(-1, 'darwin').verdict, 'blocked');
});

test('规则 (b) 两个角色不能撞同一个键', () => {
  const dup = kc.checkPair(3640, 3640);
  assert.strictEqual(dup.ok, false);
  assert.strictEqual(dup.reason, 'duplicate');
  assert.match(dup.message, /同一个键/);
  assert.strictEqual(kc.checkPair(3640, 3676).ok, true);
});

test('RECOMMENDED 每一项在两个平台都是 ok，且键名非空', () => {
  assert.ok(kc.RECOMMENDED.length >= 11);
  for (const platform of ['darwin', 'win32']) {
    for (const item of kc.recommendedFor(platform)) {
      assert.strictEqual(kc.classify(item.keycode, platform).verdict, 'ok',
        `推荐键 ${item.label}(${item.keycode}) 在 ${platform} 上不是 ok，推荐表和冲突规则打架了`);
      assert.ok(item.label && item.label.length > 0);
      assert.doesNotMatch(item.label, /^键码 /, `推荐键 ${item.keycode} 没有人类可读键名`);
    }
  }
});

test('默认键位本身必须通过冲突规则（不然开箱就是个警告）', () => {
  for (const platform of ['darwin', 'win32']) {
    const d = kc.defaultsFor(platform);
    assert.strictEqual(kc.classify(d.short, platform).verdict, 'ok');
    assert.strictEqual(kc.classify(d.long, platform).verdict, 'ok');
    assert.strictEqual(kc.checkPair(d.short, d.long).ok, true);
  }
});
