'use strict';
// 通道白名单的静态检查（评审 M5 的挡板）。
//
// 两条断言就是挡「通道表有、preload 没有」那类漏项的手段：
// ① 两个 preload 与 ipc.js 源码里出现的通道名，全部在 CHANNELS 白名单里；
// ② 白名单里每条 renderer 方向通道，都被至少一个 preload 暴露出去。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { CHANNELS, META, ALL, RENDERER_CHANNELS, byDir } = require('../src/main/ipc-channels');

const ROOT = path.join(__dirname, '..');
const SRC = {
  recorderPreload: fs.readFileSync(path.join(ROOT, 'src/preload/recorder-preload.js'), 'utf8'),
  settingsPreload: fs.readFileSync(path.join(ROOT, 'src/preload/settings-preload.js'), 'utf8'),
  ipc: fs.readFileSync(path.join(ROOT, 'src/main/ipc.js'), 'utf8'),
};

// 像通道名的字符串字面量：'xxx:yyy'
const CHANNEL_LIKE = /['"`]([a-z][a-zA-Z0-9]*:[a-zA-Z][a-zA-Z0-9]*)['"`]/g;

function channelLiterals(src) {
  const out = new Set();
  let m;
  CHANNEL_LIKE.lastIndex = 0;
  while ((m = CHANNEL_LIKE.exec(src)) !== null) out.add(m[1]);
  return out;
}

/** preload 里 CHANNELS.FOO 的引用。 */
function channelRefs(src) {
  const out = new Set();
  const re = /CHANNELS\.([A-Z0-9_]+)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    assert.ok(CHANNELS[m[1]] !== undefined, `CHANNELS.${m[1]} 不存在`);
    out.add(CHANNELS[m[1]]);
  }
  return out;
}

test('白名单自身一致：CHANNELS 与 META 一一对应', () => {
  assert.deepStrictEqual(new Set(ALL), new Set(Object.keys(META)));
  assert.strictEqual(new Set(ALL).size, ALL.length, '通道名有重复');
  for (const c of ALL) {
    assert.ok(['m2r', 'r2m'].includes(META[c].dir), `${c} 的 dir 非法`);
    assert.ok(['send', 'invoke'].includes(META[c].mech), `${c} 的 mech 非法`);
  }
});

test('① 源码里出现的通道名全部在白名单里', () => {
  const white = new Set(ALL);
  for (const [name, src] of Object.entries(SRC)) {
    for (const lit of channelLiterals(src)) {
      assert.ok(white.has(lit), `${name} 用了白名单外的通道名 ${lit}`);
    }
  }
});

test('② 白名单里每条 renderer 方向通道都被至少一个 preload 暴露', () => {
  const exposed = new Set([
    ...channelLiterals(SRC.recorderPreload),
    ...channelLiterals(SRC.settingsPreload),
  ]);
  const missing = RENDERER_CHANNELS.filter((c) => !exposed.has(c));
  assert.deepStrictEqual(missing, [], `这些通道没有任何 preload 暴露：${missing.join(', ')}`);
});

test('两个 preload 的通道名加起来正好等于白名单，不多不少', () => {
  const exposed = new Set([
    ...channelLiterals(SRC.recorderPreload),
    ...channelLiterals(SRC.settingsPreload),
  ]);
  assert.deepStrictEqual([...exposed].sort(), [...ALL].sort());
});

test('preload 不许 require 相对路径的本地模块（sandbox:true 下会加载失败）', () => {
  // 实测踩过：require('../main/ipc-channels') → module not found → 整个 preload
  // 不加载 → window.vi 是 undefined → 症状只表现为主进程侧「PCM 块 0 个」。
  for (const name of ['recorderPreload', 'settingsPreload']) {
    const code = SRC[name].replace(/\/\/.*$/gm, '');
    const reqs = [...code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const r of reqs) {
      assert.ok(!r.startsWith('.'), `${name} 里有相对 require：${r}`);
    }
    assert.deepStrictEqual(reqs, ['electron'], `${name} 只应该 require electron`);
  }
});

test('ipc.js 注册了全部 r2m 通道', () => {
  const used = channelRefs(SRC.ipc);
  const missing = byDir('r2m').filter((c) => !used.has(c));
  assert.deepStrictEqual(missing, [], `ipc.js 没注册：${missing.join(', ')}`);
});

test('main 侧（ipc.js）不写通道名字面量，只从 ipc-channels 取', () => {
  // preload 因为 sandbox 限制必须写字面量，但 main 侧没这个限制，
  // 字面量要被挡住，否则白名单就有了第二个事实源。
  assert.deepStrictEqual([...channelLiterals(SRC.ipc)], [], 'ipc.js 里有通道名字面量');
});

test('高频的 pcm:chunk 走 send → on，校验不能只覆盖 handle', () => {
  assert.strictEqual(META[CHANNELS.PCM_CHUNK].mech, 'send');
  assert.match(SRC.ipc, /ipcMain\.on\(/, 'ipc.js 必须注册 ipcMain.on');
  // senderFrame 校验必须同时覆盖 on 与 handle 两条路径
  assert.match(SRC.ipc, /isOwnFrame\(event, channel\)/);
  const onBlock = SRC.ipc.slice(SRC.ipc.indexOf('const on = (channel'), SRC.ipc.indexOf('const handle = (channel'));
  assert.match(onBlock, /isOwnFrame/, 'ipcMain.on 的包装里没做 senderFrame 校验');
});

test('senderFrame 为 null 一律丢弃，不当成校验通过', () => {
  const ipc = require('../src/main/ipc');
  assert.strictEqual(ipc.isOwnFrame({ senderFrame: null }, 'pcm:chunk'), false);
  assert.strictEqual(ipc.isOwnFrame({}, 'pcm:chunk'), false);
  assert.strictEqual(ipc.isOwnFrame(null, 'pcm:chunk'), false);
});

test('载荷校验：PCM 块 ≤64KB 且偶数字节；opus ≤32MB', () => {
  const ipc = require('../src/main/ipc');
  assert.strictEqual(ipc.validPcmBytes(new Uint8Array(4096)), true);
  assert.strictEqual(ipc.validPcmBytes(new Uint8Array(0)), false);
  assert.strictEqual(ipc.validPcmBytes(new Uint8Array(4097)), false, '奇数字节必须拒');
  assert.strictEqual(ipc.validPcmBytes(new Uint8Array(ipc.PCM_MAX_BYTES + 2)), false);
  assert.strictEqual(ipc.validOpusBytes(new Uint8Array(10)), true);
  assert.strictEqual(ipc.validOpusBytes(new Uint8Array(0)), false);
});

test('shell:openPath 只接受转录目录下的路径', () => {
  const ipc = require('../src/main/ipc');
  const dir = path.join(path.sep, 'tmp', '语音输入转录');
  assert.strictEqual(ipc.underTranscriptDir(path.join(dir, 'a.md'), dir), true);
  // 转录目录本身也要放行：设置页的「打开文件夹」按钮传的就是它
  assert.strictEqual(ipc.underTranscriptDir(dir, dir), true);
  // 同名前缀的隔壁目录不算在内
  assert.strictEqual(ipc.underTranscriptDir(`${dir}-备份/a.md`, dir), false);
  assert.strictEqual(ipc.underTranscriptDir(path.join(path.sep, 'etc', 'passwd'), dir), false);
  assert.strictEqual(ipc.underTranscriptDir(path.join(dir, '..', 'x.md'), dir), false);
  assert.strictEqual(ipc.underTranscriptDir('relative.md', dir), false);
});

test('recorder:error 的 kind 是封闭枚举', () => {
  const { ERROR_KINDS } = require('../src/main/ipc-channels');
  assert.deepStrictEqual(ERROR_KINDS, ['mic', 'worklet', 'audio-context', 'decode']);
});

test('settings-preload 用 webUtils.getPathForFile，不用已移除的 file.path', () => {
  assert.match(SRC.settingsPreload, /webUtils\.getPathForFile\(/);
  // 注释里会提到这个坑，断言只看代码
  const code = SRC.settingsPreload.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\bfile\.path\b/);
});
