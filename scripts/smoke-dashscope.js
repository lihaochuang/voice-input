'use strict';
// 百炼（DashScope）内联 base64 冒烟。这是 验证清单.md 第 0 项，**由你本人执行**：
// Agent 没有百炼 Key，而整条「短输入走 opus 内联」的分流设计都压在这个脚本的结论上。
//
// 跑法：
//   export DASHSCOPE_API_KEY=你的key          # 只认环境变量，不接受命令行传 key
//   node scripts/smoke-dashscope.js [一个webm文件]
//
// 它一次验三件事：
//   ① qwen3-asr-flash 真的接受 data:audio/webm;base64, 内联 opus（HTTP 200 + 文本正确）；
//   ② MediaRecorder 产的 webm/opus 能被它解（用的就是本应用录出来的文件）；
//   ③ 内联 base64 的请求体上限 —— 文档没给这个数，而导入路径能喂进任意长文件，
//      没有它就只能靠线上 413 来发现。测出来的值回填 src/main/asr/types.js 的
//      LIMITS.dashscope.maxBytes（当前是 8MB 暂定值）。
//
// 上限这一轮刻意用 48kHz 立体声 WAV 而不是加长音频：这样 20MB 的体积只对应约 104 秒，
// 全程不碰 maxSeconds=180 的时长上限，失败点就能归到「请求体太大」而不是「音频太长」。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildPayload, parseResponse } = require('../src/main/asr/dashscope');
const { redact } = require('../src/main/logger');

const ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const MODEL = 'qwen3-asr-flash';

const KEY = (process.env.DASHSCOPE_API_KEY || '').trim();
if (!KEY) {
  console.error('缺 DASHSCOPE_API_KEY。先在当前终端里设好再跑：');
  console.error('  export DASHSCOPE_API_KEY=sk-你的百炼key');
  console.error('  node scripts/smoke-dashscope.js [一个webm文件]');
  console.error('Key 只从环境变量读，不接受命令行参数、不写进任何文件。');
  process.exit(2);
}

// ---------- 找一个真实的 webm/opus ----------
function findWebm() {
  const given = process.argv[2];
  if (given) {
    if (!fs.existsSync(given)) {
      console.error(`找不到文件：${given}`);
      process.exit(2);
    }
    return given;
  }
  // 应用录完没删的那些就在 userData 下，按新到旧找一个。
  const base = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'VoiceInput')
    : path.join(process.env.APPDATA || os.homedir(), 'VoiceInput');
  const found = [];
  for (const sub of ['tmp', '待处理']) {
    const dir = path.join(base, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.webm')) {
        const p = path.join(dir, f);
        found.push({ p, mtime: fs.statSync(p).mtimeMs });
      }
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0].p;
}

// ---------- 合成 WAV（上限测试用，48kHz 立体声，不碰时长上限） ----------
function sineWav(bytes) {
  const rate = 48000, ch = 2, bps = rate * ch * 2;
  const frames = Math.max(1, Math.floor((bytes - 44) / (ch * 2)));
  const data = Buffer.alloc(frames * ch * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000);
    for (let c = 0; c < ch; c++) data.writeInt16LE(v, (i * ch + c) * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(bps, 28); h.writeUInt16LE(ch * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return { buf: Buffer.concat([h, data]), seconds: frames / rate };
}

async function post(payload) {
  const body = JSON.stringify(payload);
  const started = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(180000),
    });
    const text = await res.text();
    return { status: res.status, text, bodyBytes: Buffer.byteLength(body), ms: Date.now() - started };
  } catch (e) {
    return { status: 0, text: redact(String(e && e.message)), bodyBytes: Buffer.byteLength(body), ms: Date.now() - started };
  }
}

async function main() {
  const MB = 1024 * 1024;

  // ① + ② 真实 webm 内联
  const webm = findWebm();
  if (!webm) {
    console.log('【跳过 ①②】没找到 webm 文件。');
    console.log('  拿一个的办法：打开本应用，按一次热键说一句话（文件会落在 userData 的 tmp/ 或 待处理/），');
    console.log('  或者在 Chrome 里用 MediaRecorder 录一段 audio/webm;codecs=opus，然后：');
    console.log('    node scripts/smoke-dashscope.js /路径/xxx.webm');
  } else {
    const buf = fs.readFileSync(webm);
    console.log(`【①②】webm 内联：${path.basename(webm)}，${buf.length} 字节`);
    const r = await post(buildPayload({ buffer: buf, mime: 'audio/webm', hotwords: [], model: MODEL }));
    console.log(`  HTTP ${r.status}，请求体 ${(r.bodyBytes / MB).toFixed(2)}MB，${r.ms}ms`);
    if (r.status === 200) {
      let out = '';
      try { out = parseResponse(JSON.parse(r.text)); } catch (e) { out = `解析失败：${e.message}`; }
      console.log(`  识别结果：${JSON.stringify(out)}`);
      console.log('  → 文本对得上就说明 data:audio/webm;base64 内联 opus 可用（§4 的分流设计成立）。');
    } else {
      console.log(`  响应：${r.text.slice(0, 300)}`);
      console.log('  → 不是 200 就说明内联 opus 这条路不通，按 design.md §23-4 整体退回全程 WAV。');
    }
  }

  // ③ 请求体上限
  console.log('\n【③】请求体上限（48kHz 立体声 WAV，时长全程 < 180 秒，排除时长上限干扰）');
  let lastOk = 0;
  for (const mb of [1, 5, 10, 20]) {
    const { buf, seconds } = sineWav(mb * MB);
    const r = await post(buildPayload({ buffer: buf, mime: 'audio/wav', hotwords: [], model: MODEL }));
    const ok = r.status === 200;
    console.log(`  音频 ${mb}MB（${seconds.toFixed(0)}s）→ 请求体 ${(r.bodyBytes / MB).toFixed(2)}MB → HTTP ${r.status}${ok ? '' : `：${r.text.slice(0, 160)}`}`);
    if (ok) lastOk = mb; else break;
  }
  if (lastOk === 0) {
    console.log('  第一档就失败：先确认 Key 与模型权限，再看响应里的原因，别直接当成体积上限。');
  } else {
    console.log(`\n  最后通过的一档是音频 ${lastOk}MB。建议回填 src/main/asr/types.js：`);
    console.log(`    LIMITS.dashscope.maxBytes = ${lastOk} * 1024 * 1024   // 实测通过的最大一档（原文件字节，内联后约 ×1.34）`);
    if (lastOk === 20) console.log('  20MB 都过了说明上限更高，可自行把档位往上加再测。');
  }
}

main().catch((e) => { console.error(redact(String(e && e.stack || e))); process.exit(1); });
