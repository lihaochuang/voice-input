'use strict';
// 文件夹监听（design.md §24.3）。
//
// 核心是「连续两轮 size 相同才算写完」这条判定与指纹去重，两者都是纯函数，
// 所以主干测试不碰定时器、不等真实轮询。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { useTempDataDir } = require('./_helpers');

const DATA = useTempDataDir();
const watcher = require('../src/main/watcher');
const paths = require('../src/main/paths');

const {
  DONE_DIR, MIN_INTERVAL_SEC, MAX_INTERVAL_SEC, DEFAULT_INTERVAL_SEC,
  fingerprint, validate, clampInterval, scan, createState, feed, loadDone, appendDone, moveToDone,
} = watcher;

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vi-w-'));

// ───────────────────── 大小稳定判定 ─────────────────────

test('第一次见到的文件不处理（可能还在写）', () => {
  const st = createState();
  assert.deepStrictEqual(feed(st, [{ name: 'a.wav', size: 100, mtimeMs: 1 }]), []);
});

test('两次采样大小不等 → 不处理', () => {
  const st = createState();
  feed(st, [{ name: 'a.wav', size: 100, mtimeMs: 1 }]);
  const r = feed(st, [{ name: 'a.wav', size: 200, mtimeMs: 1 }]);
  assert.deepStrictEqual(r, [], '还在写，必须等下一轮');
});

test('两次采样大小相等 → 处理，且只处理一次', () => {
  const st = createState();
  feed(st, [{ name: 'a.wav', size: 100, mtimeMs: 7 }]);
  const first = feed(st, [{ name: 'a.wav', size: 100, mtimeMs: 7 }]);
  assert.strictEqual(first.length, 1);
  assert.strictEqual(first[0].name, 'a.wav');
  assert.strictEqual(first[0].fingerprint, fingerprint('a.wav', 100, 7));
  // 再扫几轮都不该重复入队
  assert.deepStrictEqual(feed(st, [{ name: 'a.wav', size: 100, mtimeMs: 7 }]), []);
  assert.deepStrictEqual(feed(st, [{ name: 'a.wav', size: 100, mtimeMs: 7 }]), []);
});

test('先变大再稳定 → 稳定之后才处理一次', () => {
  const st = createState();
  feed(st, [{ name: 'b.mp3', size: 10, mtimeMs: 1 }]);
  feed(st, [{ name: 'b.mp3', size: 500, mtimeMs: 2 }]);
  assert.deepStrictEqual(feed(st, [{ name: 'b.mp3', size: 900, mtimeMs: 3 }]), []);
  const r = feed(st, [{ name: 'b.mp3', size: 900, mtimeMs: 3 }]);
  assert.strictEqual(r.length, 1);
});

test('同指纹第二次出现 → 跳过（文件被拖回来也认得出）', () => {
  const fp = fingerprint('c.m4a', 42, 99);
  const st = createState([fp]);
  feed(st, [{ name: 'c.m4a', size: 42, mtimeMs: 99 }]);
  assert.deepStrictEqual(feed(st, [{ name: 'c.m4a', size: 42, mtimeMs: 99 }]), [], '已处理过');
});

test('指纹是「文件名+size+mtime」，不是绝对路径（转完文件会被挪走）', () => {
  assert.strictEqual(fingerprint('a.wav', 1, 2), fingerprint('a.wav', 1, 2));
  assert.notStrictEqual(fingerprint('a.wav', 1, 2), fingerprint('a.wav', 1, 3));
  assert.notStrictEqual(fingerprint('a.wav', 1, 2), fingerprint('b.wav', 1, 2));
  assert.notStrictEqual(fingerprint('a.wav', 1, 2), fingerprint('a.wav', 2, 2));
  assert.match(fingerprint('a.wav', 1, 2), /^[0-9a-f]{40}$/);
  // mtime 取整：同一文件两轮之间的亚毫秒抖动不该变成一个新指纹
  assert.strictEqual(fingerprint('a.wav', 1, 2.4), fingerprint('a.wav', 1, 2));
});

test('文件消失后同名新文件要重新等一轮，不能沿用上一轮的 size', () => {
  const st = createState();
  feed(st, [{ name: 'd.wav', size: 100, mtimeMs: 1 }]);
  feed(st, []); // 消失
  assert.deepStrictEqual(feed(st, [{ name: 'd.wav', size: 100, mtimeMs: 9 }]), [], '必须重新等一轮');
});

// ───────────────────── 目录校验（§16） ─────────────────────

test('监听目录等于转录目录 → 拒绝（否则自己的产物会被当新输入，无限循环）', () => {
  const dir = tmpdir();
  const r = validate({ dir, transcriptDir: dir });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /转录目录/);
});

test('监听目录包含转录目录 → 拒绝', () => {
  const dir = tmpdir();
  const inner = path.join(dir, '语音输入转录');
  fs.mkdirSync(inner);
  const r = validate({ dir, transcriptDir: inner });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /包含转录目录/);
});

test('转录目录在监听目录之外 → 通过', () => {
  assert.deepStrictEqual(validate({ dir: tmpdir(), transcriptDir: tmpdir() }), { ok: true });
});

test('同名前缀不算包含（…/录音 与 …/录音备份）', () => {
  const root = tmpdir();
  const a = path.join(root, '录音');
  const b = path.join(root, '录音备份');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  assert.deepStrictEqual(validate({ dir: a, transcriptDir: b }), { ok: true });
});

test('空值、相对路径、不存在、不是目录都拒绝并给原因', () => {
  assert.strictEqual(validate({ dir: '' }).ok, false);
  assert.strictEqual(validate({}).ok, false);
  assert.match(validate({ dir: '相对/路径' }).reason, /绝对路径/);
  assert.match(validate({ dir: path.join(tmpdir(), '不存在') }).reason, /不存在/);
  const f = path.join(tmpdir(), 'x.txt');
  fs.writeFileSync(f, 'x');
  assert.match(validate({ dir: f }).reason, /不是一个目录/);
});

test('轮询间隔收进 2–300，非法值回退 5', () => {
  assert.strictEqual(clampInterval(5), 5);
  assert.strictEqual(clampInterval(MIN_INTERVAL_SEC), MIN_INTERVAL_SEC);
  assert.strictEqual(clampInterval(MAX_INTERVAL_SEC), MAX_INTERVAL_SEC);
  for (const bad of [1, 301, 0, -1, 2.5, NaN, undefined, null, '5']) {
    assert.strictEqual(clampInterval(bad), DEFAULT_INTERVAL_SEC, `${bad} 该回退`);
  }
});

// ───────────────────── 扫目录 ─────────────────────

test('目录不存在 → 返回停止信号，不抛错', () => {
  const r = scan(path.join(tmpdir(), '没这个目录'));
  assert.strictEqual(r.gone, true);
  assert.deepStrictEqual(r.entries, []);
});

test('只收白名单扩展名，跳过 已完成/ 与子目录，非音频文件不动', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'a.wav'), 'x');
  fs.writeFileSync(path.join(dir, 'b.M4A'), 'xx');
  fs.writeFileSync(path.join(dir, '笔记.txt'), 'xxx');
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'xxxx');
  fs.mkdirSync(path.join(dir, DONE_DIR));
  fs.writeFileSync(path.join(dir, DONE_DIR, 'old.wav'), 'x');
  fs.mkdirSync(path.join(dir, '子目录'));
  const r = scan(dir);
  assert.strictEqual(r.gone, false);
  assert.deepStrictEqual(r.entries.map((e) => e.name).sort(), ['a.wav', 'b.M4A']);
  // 非音频文件只是被跳过，没被移动也没被删
  assert.ok(fs.existsSync(path.join(dir, '笔记.txt')));
});

// ───────────────────── 已完成/ 与指纹台账 ─────────────────────

test('转完挪进 已完成/，原文件保留在那里，同名加 -1 / -2 不覆盖', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'x.wav'), 'first');
  assert.strictEqual(path.basename(moveToDone(dir, 'x.wav')), 'x.wav');
  assert.strictEqual(fs.readFileSync(path.join(dir, DONE_DIR, 'x.wav'), 'utf8'), 'first');
  assert.ok(!fs.existsSync(path.join(dir, 'x.wav')), '源文件挪走了');

  fs.writeFileSync(path.join(dir, 'x.wav'), 'second');
  assert.strictEqual(path.basename(moveToDone(dir, 'x.wav')), 'x-1.wav');
  fs.writeFileSync(path.join(dir, 'x.wav'), 'third');
  assert.strictEqual(path.basename(moveToDone(dir, 'x.wav')), 'x-2.wav');
  // 一个都没被覆盖
  assert.strictEqual(fs.readFileSync(path.join(dir, DONE_DIR, 'x.wav'), 'utf8'), 'first');
  assert.strictEqual(fs.readFileSync(path.join(dir, DONE_DIR, 'x-1.wav'), 'utf8'), 'second');
});

test('指纹台账写得进、读得回，坏行跳过不影响其他行', () => {
  fs.rmSync(paths.importDonePath(), { force: true });
  assert.deepStrictEqual(loadDone(), [], '文件不存在时是空的');
  appendDone('aaa', 'a.wav');
  fs.appendFileSync(paths.importDonePath(), '{坏行\n');
  appendDone('bbb', 'b.wav');
  assert.deepStrictEqual(loadDone().sort(), ['aaa', 'bbb']);
  assert.ok(paths.importDonePath().startsWith(DATA));
});

// ───────────────────── 监听器接线 ─────────────────────

function makeWatcher(over = {}) {
  const dir = tmpdir();
  const tdir = tmpdir();
  const calls = { enqueued: [], stopped: [], notified: [] };
  const w = watcher.create({
    enqueue: (list, opts) => calls.enqueued.push({ list, opts }),
    transcriptDir: () => tdir,
    notify: (m) => calls.notified.push(m),
    onStopped: (r) => calls.stopped.push(r),
    log: { info() {}, warn() {}, error() {}, debug() {} },
    ...over,
  });
  return { w, dir, tdir, calls };
}

test('开关关着就不启动；校验不过也不启动并回原因', () => {
  const { w, dir, tdir } = makeWatcher();
  assert.deepStrictEqual(w.start({ watch: { enabled: false, dir } }), { ok: false, reason: 'disabled' });
  assert.strictEqual(w.running, false);
  const r = w.start({ watch: { enabled: true, dir: tdir }, 转录目录: tdir });
  assert.strictEqual(r.ok, false, '监听目录等于转录目录，不许启动');
  assert.strictEqual(w.running, false);
});

test('启动后 tick 一次只入队稳定下来的文件，第二轮不重复', () => {
  const { w, dir, calls } = makeWatcher();
  fs.writeFileSync(path.join(dir, 'a.wav'), 'hello');
  assert.strictEqual(w.start({ watch: { enabled: true, dir, intervalSec: 300 } }).ok, true);
  assert.strictEqual(w.tick().enqueued, 0, '第一轮只记 size');
  assert.strictEqual(w.tick().enqueued, 1);
  assert.strictEqual(calls.enqueued.length, 1);
  assert.strictEqual(calls.enqueued[0].list[0], path.join(dir, 'a.wav'));
  assert.strictEqual(w.tick().enqueued, 0);
  w.stop();
  assert.strictEqual(w.running, false);
});

test('入队时给的 onFinished 会记指纹并把文件挪进 已完成/', () => {
  const { w, dir, calls } = makeWatcher();
  fs.rmSync(paths.importDonePath(), { force: true });
  fs.writeFileSync(path.join(dir, 'z.wav'), 'bye');
  w.start({ watch: { enabled: true, dir, intervalSec: 300 } });
  w.tick();
  w.tick();
  calls.enqueued[0].opts.onFinished();
  assert.ok(fs.existsSync(path.join(dir, DONE_DIR, 'z.wav')));
  assert.strictEqual(loadDone().length, 1);
  w.stop();
});

test('目录消失 → 停止监听 + 通知 + 回调上报原因，不静默空转', () => {
  const { w, dir, calls } = makeWatcher();
  w.start({ watch: { enabled: true, dir, intervalSec: 300 } });
  fs.rmSync(dir, { recursive: true, force: true });
  const r = w.tick();
  assert.strictEqual(r.gone, true);
  assert.strictEqual(w.running, false);
  assert.strictEqual(calls.stopped.length, 1);
  assert.match(calls.notified[0], /监听目录/);
});

test('不用 fs.watch（网络盘/SD 卡上漏报，而且写到一半就报）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/watcher.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(src, /fs\.watch\(|watchFile\(/);
  assert.match(src, /setInterval\(/);
});
