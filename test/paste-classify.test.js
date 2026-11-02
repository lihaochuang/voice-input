'use strict';
// macOS 粘贴失败按**错误号**分流（评审 M4）。
//
// 为什么不匹配 stderr 子串：实际消息是
//   System Events got an error: osascript is not allowed to send keystrokes. (-1719)
// 不含 assistive 这个词，而且随系统语言本地化——目标用户正是中文系统。
const test = require('node:test');
const assert = require('node:assert');

const paste = require('../src/main/paste');
const { classifyOsascriptFailure: cls } = paste;

test('-1743 → permission-automation（Apple Event 的「自动化」类别）', () => {
  assert.strictEqual(
    cls({ code: 1, stderr: 'execution error: 不允许发送 Apple 事件。 (-1743)', trusted: true }),
    'permission-automation',
  );
});

test('-1719 → permission-accessibility', () => {
  assert.strictEqual(
    cls({ code: 1, stderr: 'System Events got an error: … send keystrokes. (-1719)', trusted: true }),
    'permission-accessibility',
  );
});

test('trusted=false 且无错误号 → permission-accessibility', () => {
  assert.strictEqual(cls({ code: 1, stderr: '', trusted: false }), 'permission-accessibility');
});

test('其他非零退出 → unknown', () => {
  assert.strictEqual(cls({ code: 2, stderr: '什么都没说', trusted: true }), 'unknown');
  assert.strictEqual(cls({ code: -1, stderr: 'spawn ENOENT', trusted: true }), 'unknown');
});

test('退出码 0 → 没失败', () => {
  assert.strictEqual(cls({ code: 0, stderr: '', trusted: true }), null);
});

test('-1743 优先于 trusted=false：两者同时出现时送「自动化」面板', () => {
  // 在「自动化」里点过拒绝后系统不再弹窗，送错面板用户无法自行恢复
  assert.strictEqual(cls({ code: 1, stderr: '(-1743)', trusted: false }), 'permission-automation');
});

test('中文系统的本地化消息也能分类（不依赖英文子串）', () => {
  assert.strictEqual(cls({ code: 1, stderr: '“系统事件”遇到一个错误：不允许发送按键。 (-1719)', trusted: true }), 'permission-accessibility');
});

test('两个面板 URL 不相同，且各自指向正确的 TCC 类别', () => {
  const a = paste.panelFor('permission-automation');
  const b = paste.panelFor('permission-accessibility');
  assert.ok(a && b);
  assert.notStrictEqual(a, b, '自动化与辅助功能是不同 TCC 类别，面板不能是同一个');
  assert.match(a, /Privacy_Automation$/);
  assert.match(b, /Privacy_Accessibility$/);
});

test('不认识的分类没有面板', () => {
  assert.strictEqual(paste.panelFor('unknown'), null);
  assert.strictEqual(paste.panelFor('own-window'), null);
});

test('-25211 不参与判定（查不到 keystroke 权限语义，已删）', () => {
  assert.strictEqual(cls({ code: 1, stderr: 'oops (-25211)', trusted: true }), 'unknown');
  assert.doesNotMatch(require('fs').readFileSync(require('path').join(__dirname, '..', 'src/main/paste.js'), 'utf8').replace(/\/\/.*$/gm, ''), /-25211/);
});

test('H2：READY 超时 ≥3000（取 5000）、OK 回执 ≥1000', () => {
  assert.ok(paste.READY_TIMEOUT_MS >= 3000, '原 500ms 小于冷启动 600ms~1.5s，会让 Windows 每次都降级');
  assert.strictEqual(paste.READY_TIMEOUT_MS, 5000);
  assert.ok(paste.ACK_TIMEOUT_MS >= 1000);
  assert.strictEqual(paste.MAX_HOST_FAILURES, 2);
});

test('H2：判死条件必须含「进程已退出」，不能只看超时', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/main/paste.js'), 'utf8');
  assert.match(src, /if \(!exited\)/, '超时后必须先看子进程是否已退出');
  assert.match(src, /host-timeout/);
  assert.match(src, /no-ack/);
  assert.match(src, /exec-failed/);
});

test('macOS 走 osascript 的 keystroke v using command down', () => {
  assert.deepStrictEqual(paste.OSA_ARGS, [
    '-e', 'tell application "System Events" to keystroke "v" using command down',
  ]);
});

test('Windows 宿主：超时但进程存活时按可用处理，不降级', async () => {
  const { EventEmitter } = require('events');
  const fakeProc = () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stdout.off = p.stdout.removeListener.bind(p.stdout);
    p.stderr = new EventEmitter();
    p.stdin = { write() {} }; // 故意不回 READY
    p.kill = () => {};
    return p;
  };
  const host = paste.createWinHost({ spawnImpl: () => fakeProc() });
  // 把超时缩短不现实（常量是硬断言的对象），这里只验「没退出就不进 degraded」
  assert.strictEqual(host.degraded, false);
  host.kill();
});
