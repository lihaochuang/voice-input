'use strict';
// 导入链路（design.md §24.1 / §24.2，评审 H3）。
//
// 本文件盯的是 H3 的全部判据：白名单十种格式（含大写）、amr 不落默认 MIME、
// 两条体积闸门各自的行为、解码失败降级、以及**整个文件的 buffer 不许当 IPC
// 载荷发送**那条静态检查。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { useTempDataDir, sine, constant } = require('./_helpers');

useTempDataDir();
const importer = require('../src/main/importer');
const wav = require('../src/main/wav');

const {
  IMPORT_MAX_BYTES, DECODE_MAX_BYTES, EXTS, MIME_BY_EXT, STATUS,
  extOf, isSupported, mimeOf, plan, rawCapacity, assertRawUploadable, uniqueName, writeMarkdown,
} = importer;

// ───────────────────────── 格式白名单与 MIME ─────────────────────────

test('白名单正好是事实源那十种', () => {
  assert.deepStrictEqual(EXTS, ['wav', 'mp3', 'm4a', 'mp4', 'webm', 'ogg', 'opus', 'flac', 'aac', 'amr']);
  assert.strictEqual(EXTS.length, 10);
});

test('十种扩展名全覆盖，大写也认（手机导出常见 .WAV / .M4A）', () => {
  for (const e of EXTS) {
    assert.strictEqual(isSupported(`/x/a.${e}`), true, `小写 ${e}`);
    assert.strictEqual(isSupported(`/x/a.${e.toUpperCase()}`), true, `大写 ${e}`);
    assert.strictEqual(extOf(`/x/a.${e.toUpperCase()}`), e);
  }
  assert.strictEqual(isSupported('/x/a.txt'), false);
  assert.strictEqual(isSupported('/x/noext'), false);
  assert.strictEqual(extOf('/x/noext'), '');
});

test('amr 映射到 audio/amr，不是落到默认 audio/wav（原实现的 bug，别照抄）', () => {
  assert.strictEqual(MIME_BY_EXT.amr, 'audio/amr');
  assert.strictEqual(mimeOf('/x/录音.amr'), 'audio/amr');
  assert.strictEqual(mimeOf('/x/录音.AMR'), 'audio/amr');
  assert.notStrictEqual(mimeOf('/x/录音.amr'), 'audio/wav');
});

test('MIME 映射十项齐全且与 asr_shim.py 的表一致', () => {
  assert.deepStrictEqual(MIME_BY_EXT, {
    wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', webm: 'audio/webm',
    ogg: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', amr: 'audio/amr',
  });
  assert.strictEqual(Object.keys(MIME_BY_EXT).length, 10);
  // 不在表里的才落默认
  assert.strictEqual(mimeOf('/x/a.unknown'), 'audio/wav');
});

// ───────────────────────── 两条体积闸门 ─────────────────────────

test('常量按评审 H3 定：导入 500MB（不是 2GB）、解码 150MB', () => {
  assert.strictEqual(IMPORT_MAX_BYTES, 500 * 1024 * 1024);
  assert.strictEqual(DECODE_MAX_BYTES, 150 * 1024 * 1024);
  assert.ok(DECODE_MAX_BYTES < IMPORT_MAX_BYTES);
});

test('常规大小走解码路线', () => {
  const p = plan('/x/面试.m4a', 30 * 1024 * 1024);
  assert.strictEqual(p.mode, 'decode');
  assert.strictEqual(p.skipSilence, false);
  assert.strictEqual(p.mime, 'audio/wav'); // 解码后统一成 WAV
});

test('size > DECODE_MAX_BYTES 走原样上传，且 skipSilence=true', () => {
  const p = plan('/x/长会.mp3', DECODE_MAX_BYTES + 1);
  assert.strictEqual(p.mode, 'raw');
  assert.strictEqual(p.skipSilence, true, '没解码就拿不到 PCM，静音拦截必须跳过');
  assert.strictEqual(p.mime, 'audio/mpeg', '原样上传要用真实 MIME');
  assert.match(p.note, /未解码/);
});

test('size > IMPORT_MAX_BYTES 直接拒绝，错误可识别', () => {
  assert.throws(
    () => plan('/x/巨大.wav', IMPORT_MAX_BYTES + 1),
    (e) => e.kind === 'import-too-large' && /超过导入上限/.test(e.message)
  );
});

test('不在白名单与空文件各有可识别的 kind', () => {
  assert.throws(() => plan('/x/a.txt', 100), (e) => e.kind === 'unsupported');
  assert.throws(() => plan('/x/a.wav', 0), (e) => e.kind === 'empty-file');
  assert.throws(() => plan('/x/a.wav', NaN), (e) => e.kind === 'empty-file');
});

// ───────────── 超后端上限且未解码 → 抛错而不是静默成功 ─────────────

test('rawCapacity：base64 内联的后端只能用 maxBytes 的 3/4，needsWav 的不算', () => {
  assert.strictEqual(rawCapacity([{ id: 'dashscope', limits: { maxBytes: 8 * 1024 * 1024, inlineBase64: true } }]),
    Math.floor((8 * 1024 * 1024 * 3) / 4));
  assert.strictEqual(rawCapacity([{ id: 'groq', limits: { maxBytes: 25 * 1024 * 1024, inlineBase64: false } }]),
    25 * 1024 * 1024);
  // 只能吃 WAV 的后端接不了原文件，不该把容量算进来
  assert.strictEqual(rawCapacity([{ id: 'whispercpp', limits: { maxBytes: Infinity, needsWav: true } }]), 0);
  assert.strictEqual(rawCapacity([]), 0);
  // 取最大的那个
  assert.strictEqual(rawCapacity([
    { id: 'dashscope', limits: { maxBytes: 8 * 1024 * 1024, inlineBase64: true } },
    { id: 'groq', limits: { maxBytes: 25 * 1024 * 1024 } },
  ]), 25 * 1024 * 1024);
});

test('超 maxBytes 且未解码 → 抛可识别错误，不许静默成功', () => {
  assert.strictEqual(assertRawUploadable(100, 200), true);
  assert.throws(
    () => assertRawUploadable(30 * 1024 * 1024, 25 * 1024 * 1024),
    (e) => e.kind === 'too-large-unsplittable' && /无法切分/.test(e.message)
  );
  // 一个后端都用不上时容量是 0，同样必须抛，不能当成「无限」
  assert.throws(() => assertRawUploadable(1, 0), (e) => e.kind === 'too-large-unsplittable');
});

// ───────────────────────── 产物 ─────────────────────────

test('同名冲突加 -2 / -3，不覆盖', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vi-imp-'));
  assert.strictEqual(uniqueName(dir, '面试'), '面试');
  fs.writeFileSync(path.join(dir, '面试.md'), 'x');
  assert.strictEqual(uniqueName(dir, '面试'), '面试-2');
  fs.writeFileSync(path.join(dir, '面试-2.md'), 'x');
  assert.strictEqual(uniqueName(dir, '面试'), '面试-3');
});

test('产物结构与长录音归档同一套，「原始音频」是源文件名、另有「识别后端」', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vi-imp-'));
  const md = writeMarkdown({
    dir, base: '面试录音', text: '你好世界', durationSec: 3661,
    audioName: '面试录音.m4a', providerId: 'dashscope', stamp: '2026-11-02_1530',
  });
  const body = fs.readFileSync(md, 'utf8');
  assert.strictEqual(path.basename(md), '面试录音.md');
  assert.match(body, /^# 录音转录 2026-11-02_1530$/m);
  assert.match(body, /- 时间：2026-11-02 15:30/);
  assert.match(body, /- 时长：61 分 1 秒/);
  assert.match(body, /- 字数：4/);
  assert.match(body, /- 原始音频：面试录音\.m4a/);
  assert.match(body, /- 识别后端：dashscope/);
  assert.match(body, /\n---\n\n你好世界\n/);
});

// ───────── H3 的硬判据：整文件 buffer 不当 IPC 载荷 ─────────

test('importer.js 里没有任何一处把整个文件 buffer 当 IPC 载荷发送', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/importer.js'), 'utf8');
  // 本模块根本不该碰 IPC：发送面全在 main.js 的 createDecoder 里
  assert.doesNotMatch(src, /webContents\s*\.\s*send|postMessage|ipcMain|ipcRenderer/, 'importer 不该自己做 IPC');
  // 也不该 require electron（它要能在裸 Node 里测）
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /require\(\s*['"]electron['"]/);
});

test('decode:request 走 MessageChannelMain 分块送，回传是分块的（main.js 侧）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/main.js'), 'utf8');
  assert.match(src, /MessageChannelMain/, 'H3 要求用 MessageChannelMain 送字节');
  // decode:request 的载荷只有 {jobId, size}，不带 bytes
  assert.match(src, /DECODE_REQUEST,\s*\{\s*jobId,\s*size\s*\}/);
  assert.match(src, /DECODE_SEND_BYTES\s*=\s*4\s*\*\s*1024\s*\*\s*1024/, '送文件要分块');
  // 回传分块落盘：收一块 appendPcm 一次，renderer 侧不留整份 PCM
  assert.match(src, /onChunk[\s\S]{0,400}appendPcm/);
  // 解码期间 render-process-gone 必须判这个 job 失败，不静默丢任务
  assert.match(src, /render-process-gone[\s\S]{0,400}decoder\.crashed\(\)/);
});

test('recorder 侧按已知总长一次开好缓冲、PCM 分块回传，块大小低于 ipc 的 64KB 上限', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/recorder.js'), 'utf8');
  assert.match(src, /DECODE_BATCH\s*=\s*16384/);
  assert.ok(16384 * 2 <= require('../src/main/ipc').PCM_MAX_BYTES, '回传块必须 ≤64KB，否则会被 ipc.js 丢掉');
  assert.match(src, /new Uint8Array\(size\)/, '按声明的总长一次开好，不做 concat');
  assert.match(src, /sendDecodeChunk/);
  // 多声道先平均混单声道，不是只取左声道
  assert.match(src, /numberOfChannels/);
});

// ───────────────────────── 队列状态机 ─────────────────────────

/** 造一份能被 wav.readPcm 读回的真 WAV。 */
function writeWav(file, int16) {
  fs.writeFileSync(file, wav.encode(int16));
  return file;
}

function makeQueue(over = {}) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vi-q-'));
  const calls = { decode: [], transcribe: [] };
  const q = importer.create({
    decodeFile: async ({ wavPath, filePath }) => {
      calls.decode.push(filePath);
      writeWav(wavPath, sine(1.0));
      return { ok: true };
    },
    transcribe: async (args) => {
      calls.transcribe.push(args);
      return { text: '识别结果', providerId: 'dashscope' };
    },
    hotwords: () => ['口径'],
    cfg: () => ({}),
    transcriptDir: () => dir,
    chainCapacity: () => 25 * 1024 * 1024,
    corrections: () => ({ rules: [] }),
    applyCorrections: (t) => ({ text: t, hits: [] }),
    isRecording: () => false,
    onChange: () => {},
    log: { info() {}, warn() {}, error() {}, debug() {} },
    ...over,
  });
  return { q, dir, calls };
}

const settle = async (q) => {
  for (let i = 0; i < 200; i += 1) {
    if (q.activeCount() === 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('队列没跑完');
};

test('解码成功 → 按长录音转写 → 写出产物，列表标完成', async () => {
  const { q, dir, calls } = makeQueue();
  const src = writeWav(path.join(dir, '会议.wav'), sine(1.0));
  q.add([src]);
  await settle(q);
  const job = q.list()[0];
  assert.strictEqual(job.status, STATUS.done);
  assert.ok(fs.existsSync(job.mdPath));
  assert.strictEqual(calls.transcribe[0].mode, '长录音');
  assert.ok(calls.transcribe[0].tracks.wavPath, '解码过的走 wavPath');
  assert.match(fs.readFileSync(job.mdPath, 'utf8'), /识别后端：dashscope/);
  // 手动导入的原文件保持原地不动
  assert.ok(fs.existsSync(src));
});

test('解码失败 → 原样上传，带真实 MIME、不切片、列表标「未解码」', async () => {
  const { q, dir, calls } = makeQueue({
    decodeFile: async () => ({ ok: false, reason: 'EncodingError 不支持的格式' }),
  });
  const src = path.join(dir, '手机录音.amr');
  fs.writeFileSync(src, Buffer.alloc(2048, 7));
  q.add([src]);
  await settle(q);
  const job = q.list()[0];
  assert.strictEqual(job.status, STATUS.done);
  assert.match(job.note, /未解码/);
  const args = calls.transcribe[0];
  assert.strictEqual(args.mime, 'audio/amr');
  assert.strictEqual(args.tracks.wavPath, null);
  assert.ok(Buffer.isBuffer(args.tracks.opus));
  assert.strictEqual(args.durationSec, null, '没解码就不知道时长');
});

test('解码期间 render-process-gone（decodeFile reject）也走原样上传，不静默丢任务', async () => {
  const { q, dir, calls } = makeQueue({
    decodeFile: async () => { throw new Error('recorder 渲染进程在解码期间退出'); },
  });
  const src = path.join(dir, '长录音.mp3');
  fs.writeFileSync(src, Buffer.alloc(4096, 3));
  q.add([src]);
  await settle(q);
  assert.strictEqual(q.list()[0].status, STATUS.done);
  assert.strictEqual(calls.transcribe[0].mime, 'audio/mpeg');
});

test('超 maxBytes 且未解码 → 这个文件失败，队列继续跑下一个', async () => {
  const { q, dir } = makeQueue({
    decodeFile: async () => ({ ok: false, reason: '解不了' }),
    chainCapacity: () => 1024,
  });
  const big = path.join(dir, '大.mp3');
  fs.writeFileSync(big, Buffer.alloc(8192, 1));
  const small = writeWav(path.join(dir, '小.wav'), sine(0.5));
  q.add([big, small]);
  await settle(q);
  const [a, b] = q.list();
  assert.strictEqual(a.status, STATUS.failed);
  assert.strictEqual(a.kind, 'too-large-unsplittable');
  assert.strictEqual(b.status, STATUS.failed, '第二个也解不了码（同一个 decodeFile）');
  assert.strictEqual(b.kind, 'too-large-unsplittable');
});

test('静音文件不发请求', async () => {
  const { q, dir, calls } = makeQueue({
    decodeFile: async ({ wavPath }) => { writeWav(wavPath, constant(1.0, 0)); return { ok: true }; },
  });
  q.add([writeWav(path.join(dir, '空.wav'), constant(1.0, 0))]);
  await settle(q);
  assert.strictEqual(q.list()[0].kind, 'silent');
  assert.strictEqual(calls.transcribe.length, 0);
});

test('不支持的格式入队即失败，且不动用户的文件', async () => {
  const { q, dir, calls } = makeQueue();
  const src = path.join(dir, '笔记.txt');
  fs.writeFileSync(src, 'hi');
  q.add([src]);
  await settle(q);
  assert.strictEqual(q.list()[0].status, STATUS.failed);
  assert.strictEqual(q.list()[0].kind, 'unsupported');
  assert.strictEqual(calls.decode.length, 0);
  assert.ok(fs.existsSync(src));
});

test('队列串行：第二个文件要等第一个跑完', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const { q, dir } = makeQueue({
    transcribe: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return { text: 'x', providerId: 'groq' };
    },
  });
  q.add([
    writeWav(path.join(dir, 'a.wav'), sine(0.5)),
    writeWav(path.join(dir, 'b.wav'), sine(0.5)),
  ]);
  await settle(q);
  assert.strictEqual(maxInFlight, 1, '一次只能有一个在转写');
  assert.deepStrictEqual(q.list().map((j) => j.status), [STATUS.done, STATUS.done]);
});

test('正在录音时暂停队列，录完 kick 一下接着跑', async () => {
  let recording = true;
  const { q, dir } = makeQueue({ isRecording: () => recording });
  q.add([writeWav(path.join(dir, 'c.wav'), sine(0.5))]);
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(q.list()[0].status, STATUS.queued, '录音期间不该开跑');
  recording = false;
  q.kick();
  await settle(q);
  assert.strictEqual(q.list()[0].status, STATUS.done);
});

test('onFinished 在完成后被调用（监听目录靠它把文件挪进 已完成/）', async () => {
  const { q, dir } = makeQueue();
  let called = null;
  q.add([writeWav(path.join(dir, 'd.wav'), sine(0.5))], { onFinished: (job) => { called = job.name; } });
  await settle(q);
  assert.strictEqual(called, 'd.wav');
});

test('后端返回空串 → 这个文件标失败，不写空产物', async () => {
  const { q, dir } = makeQueue({ transcribe: async () => ({ text: '  ', providerId: 'groq' }) });
  q.add([writeWav(path.join(dir, 'e.wav'), sine(0.5))]);
  await settle(q);
  assert.strictEqual(q.list()[0].kind, 'empty');
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.md')), []);
});

test('纠错表生效，口语清理一律不做（导入都按长录音处理，不变量 17）', async () => {
  const { q, dir } = makeQueue({
    transcribe: async () => ({ text: '课单价很高', providerId: 'dashscope' }),
    corrections: () => ({ rules: [{ from: '课单价', to: '客单价' }] }),
    applyCorrections: (t, rules) => ({ text: rules.reduce((s, r) => s.split(r.from).join(r.to), t), hits: [] }),
  });
  q.add([writeWav(path.join(dir, 'f.wav'), sine(0.5))]);
  await settle(q);
  assert.match(fs.readFileSync(q.list()[0].mdPath, 'utf8'), /客单价很高/);
  // importer 里不该出现 polish
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/importer.js'), 'utf8');
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /polish/i);
});

test('解码任务的 jobId 路由：只认当前那个', async () => {
  const { q, dir } = makeQueue({
    decodeFile: async ({ jobId, wavPath }) => {
      assert.strictEqual(q.isActiveDecodeJob(jobId), true);
      assert.strictEqual(q.isActiveDecodeJob('imp-别的'), false);
      assert.strictEqual(q.isActiveDecodeJob(undefined), false);
      writeWav(wavPath, sine(0.5));
      return { ok: true };
    },
  });
  q.add([writeWav(path.join(dir, 'g.wav'), sine(0.5))]);
  await settle(q);
  assert.strictEqual(q.isActiveDecodeJob(q.list()[0].id), false, '跑完就不再是活动任务');
});
