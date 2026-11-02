'use strict';
// 本地 whisper.cpp —— 离线兜底（断网、出差、内网环境下仍可用）。
//
// 两种接入方式，用户在设置里二选一：
//   exec    spawn 本地可执行文件，读 --output-txt 产物
//   server  本地 whisper.cpp server 暴露 OpenAI 兼容路由 → **直接复用 openai-compat.js**
//
// 三个和别的后端不一样的地方：
//   ① limits.needsWav = true。whisper.cpp 不解码 opus/webm，注册表得喂它 WAV。
//      §4.5 那个「只有 opus 没有 PCM」的降级场景下注册表**跳过**它（记 info，不计失败、不进冷却）
//      —— 它不是坏了，是喂不进去。
//   ② 超时单独 600 秒。CPU 推理本来就慢，用全局 120 秒会把正常会成功的本地转写判成超时并切走，
//      等于永远用不上离线兜底。
//   ③ 没配置就返回 isConfigured()=false（**不是错误**，排序时不进链）。装不装 whisper.cpp
//      不影响产品可用性，所以也不随包分发二进制和模型（几百 MB，且 macOS 上会被 Gatekeeper 拦）。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const logger = require('../logger');
const paths = require('../paths');
const openaiCompat = require('./openai-compat');
const { LIMITS, MIME_WAV, fail } = require('./types');

const TIMEOUT_MS = 600000; // 10 分钟，只给本地推理用
const DEFAULT_SERVER_URL = 'http://127.0.0.1:8080/v1';
// 时间戳前缀形如 [00:00:00.000 --> 00:00:02.000]
const STAMP_RE = /^\s*\[\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}\]\s*/;

/**
 * 命令行参数。纯函数。
 * 热词紧跟在 --prompt 之后（§6.4）。**返回数组给 spawn，不拼 shell 字符串** ——
 * 路径带中文或空格时只有数组形式是安全的。
 */
function buildArgs({ execPath: _execPath, modelPath, wavPath, hotwords = [] }) {
  return ['-m', modelPath, '-f', wavPath, '-l', 'zh', '--prompt', hotwords.join(' '), '--no-timestamps', '--output-txt'];
}

/** 优先读 --output-txt 产物，读不到退回 stdout 并剥掉时间戳前缀。纯函数（只读文件）。 */
function parseOutput(stdout, txtPath) {
  if (txtPath) {
    try {
      const t = fs.readFileSync(txtPath, 'utf8').trim();
      if (t) return t;
    } catch {
      /* 没产出 txt，退回 stdout */
    }
  }
  return String(stdout ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(STAMP_RE, '').trim())
    .filter((l) => l)
    .join('')
    .trim();
}

const serverUrlOf = (cfg = {}) => cfg.serverUrl || DEFAULT_SERVER_URL;
const isServer = (cfg = {}) => cfg.mode === 'server';

function isConfigured(cfg = {}, _creds) {
  if (isServer(cfg)) return openaiCompat.isUrlAllowed(serverUrlOf(cfg));
  if (!cfg.execPath || !cfg.modelPath) return false;
  try {
    fs.accessSync(cfg.execPath, fs.constants.X_OK);
    fs.accessSync(cfg.modelPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** 本次请求用的 WAV 文件：整份文件就用它自己，分段则落一个临时文件。 */
function materializeWav(buffer, wavPath) {
  if (wavPath && fs.existsSync(wavPath)) return { file: wavPath, temp: false };
  const dir = paths.tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `whispercpp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  fs.writeFileSync(file, buffer);
  return { file, temp: true };
}

function runExec({ execPath, args, signal, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(fail('local', `whisper.cpp 启动失败：${e && e.message}`));
      return;
    }
    let out = '';
    let err = '';
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(v);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, fail('timeout', `whisper.cpp 超过 ${Math.round(timeoutMs / 1000)} 秒未返回`));
    }, timeoutMs);
    const onAbort = () => {
      child.kill('SIGKILL');
      finish(reject, fail('timeout', 'whisper.cpp 被取消'));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', (e) => {
      // ENOENT（路径填错）、EACCES（没有执行权限）都是配置问题，不是后端故障
      finish(reject, fail('local', `whisper.cpp 无法执行（${e && e.code}）：${execPath}`));
    });
    child.on('close', (code) => {
      if (code === 0) finish(resolve, out);
      else finish(reject, fail('local', `whisper.cpp 退出码 ${code}：${String(err).slice(0, 300)}`));
    });
  });
}

async function transcribe({ buffer, mime = MIME_WAV, hotwords = [], signal, creds, cfg = {}, wavPath, segIndex = 0, fetchImpl, spawnImpl }) {
  // server 模式整条路都走 openai-compat，连热词位置（prompt 字段）都一样
  if (isServer(cfg)) {
    return openaiCompat.post({
      baseUrl: openaiCompat.normalizeBaseUrl(serverUrlOf(cfg)),
      model: cfg.model || 'whisper-1',
      buffer,
      mime,
      hotwords,
      key: typeof creds === 'string' ? creds : '',
      signal,
      segIndex,
      fetchImpl,
      timeoutMs: TIMEOUT_MS,
      tagId: 'whispercpp',
    });
  }

  if (!cfg.execPath || !cfg.modelPath) throw fail('local', 'whisper.cpp 没配可执行文件或模型路径');
  if (!fs.existsSync(cfg.modelPath)) throw fail('local', `whisper.cpp 模型不存在：${cfg.modelPath}`);

  const { file, temp } = materializeWav(buffer, wavPath);
  const args = buildArgs({ execPath: cfg.execPath, modelPath: cfg.modelPath, wavPath: file, hotwords });
  const started = Date.now();
  try {
    const stdout = await (spawnImpl || runExec)({ execPath: cfg.execPath, args, signal, timeoutMs: TIMEOUT_MS });
    const text = parseOutput(stdout, `${file}.txt`);
    logger.info('asr/whispercpp', `provider=whispercpp bytes=${buffer.length} mime=${mime} segIndex=${segIndex} ms=${Date.now() - started} ok chars=${text.length}`);
    return text;
  } finally {
    try {
      fs.rmSync(`${file}.txt`, { force: true });
      if (temp) fs.rmSync(file, { force: true });
    } catch {
      /* 清不掉临时文件不影响结果 */
    }
  }
}

module.exports = {
  id: 'whispercpp',
  name: '本地 whisper.cpp',
  limits: LIMITS.whispercpp,
  isConfigured,
  transcribe,
  buildArgs,
  parseOutput,
  runExec,
  TIMEOUT_MS,
  DEFAULT_SERVER_URL,
};
