'use strict';
// OpenAI 兼容的 /v1/audio/transcriptions（multipart）。groq / openai / custom 三个后端
// **共用这一份**，差异只有默认 Base URL 与默认模型名——写三份代码没有理由。
// whisper.cpp 的 server 模式也复用它（base URL 填 http://127.0.0.1:8080/v1）。
//
// 热词位置（§6.4）：multipart 的 prompt 字段，**不是 system message**。
// 两个最常见的事故都在这里防住了：
//   ① 显式设 Content-Type 会覆盖 runtime 生成的 boundary → 400。所以绝不设。
//   ② file 的文件名必须带扩展名，多数实现靠它判容器。

const logger = require('../logger');
const { LIMITS, MIME_WAV, MIME_WEBM, fail, bodyPreview, kindFromStatus, kindFromFetchError } = require('./types');

const DEFAULTS = {
  groq: { name: 'Groq Whisper', baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' },
  openai: { name: 'OpenAI Whisper', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
  custom: { name: '自定义 OpenAI 兼容端点', baseUrl: '', model: '' }, // 两项都由用户填
};

// 热词截断阈值。whisper 系的真实上限是约 224 **token**（不是字符），中文 token 比在 1:1~1:2,
// 所以 224 token 大致对应 110–220 个汉字 —— 200 是估值。
// TODO(§21.2 第 16 条)：用递增长度的热词表测出真实截断点后回填这个常量。
// 界面文案只说「容量有限、长表只有开头生效」，**不写具体字数**：先写一个没测过的数字比不写更糟。
const PROMPT_MAX_CHARS = 200;

const TIMEOUT_MS = 120000;
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]', '::1'];

/** https，或本地回环上的 http（whisper.cpp server 是唯一例外，否则本地服务根本填不进来）。 */
function isUrlAllowed(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && LOOPBACK.includes(u.hostname);
}

/**
 * Base URL 归一成 .../v1 结尾。自定义端点最常见的配置错误就在这里：
 * 带不带尾斜杠、是否已经带 /v1、有没有把整条 /v1/audio/transcriptions 都填进来。
 * 纯函数；协议不合规 → kind:'local'（是配置问题，不是后端故障）。
 */
function normalizeBaseUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw fail('local', 'Base URL 为空');
  if (!isUrlAllowed(s)) throw fail('local', `Base URL 必须是 https（本地回环可用 http）：${s}`);
  let out = s.replace(/\/+$/, '');
  out = out.replace(/\/audio\/transcriptions$/i, '').replace(/\/+$/, '');
  if (!/\/v1$/i.test(out)) out += '/v1';
  return out;
}

/** 热词表拼成 prompt，超长截断（尽量切在空格处，不切断一个词）。 */
function truncatePrompt(hotwords = [], max = PROMPT_MAX_CHARS) {
  const full = (Array.isArray(hotwords) ? hotwords : [hotwords]).join(' ').trim();
  if (full.length <= max) return { prompt: full, truncated: false, dropped: 0 };
  const cut = full.slice(0, max);
  const at = cut.lastIndexOf(' ');
  const prompt = at > max / 2 ? cut.slice(0, at) : cut;
  return { prompt, truncated: true, dropped: full.length - prompt.length };
}

const fileNameFor = (mime) => (mime === MIME_WEBM ? 'audio.webm' : 'audio.wav');

/**
 * multipart 表单。用全局 FormData + Blob（Node 20+ 原生），fetch 直接吃。
 * language=zh 写死：whisper 的自动语种检测在中文短句上会误判成日语/英语。
 */
function buildForm({ buffer, mime = MIME_WAV, hotwords = [], model }) {
  const form = new FormData();
  form.set('file', new Blob([buffer], { type: mime }), fileNameFor(mime));
  form.set('model', String(model || ''));
  const { prompt, truncated, dropped } = truncatePrompt(hotwords);
  form.set('prompt', prompt);
  form.set('response_format', 'json');
  form.set('language', 'zh');
  if (truncated) {
    logger.warn('asr/openai-compat', `热词表超过 ${PROMPT_MAX_CHARS} 字，已截断（丢弃 ${dropped} 字），该后端只有开头部分生效`);
  }
  return form;
}

/**
 * 响应解析。纯函数。
 * 额外认 {error:{message}}：自定义端点填错模型名就是这个形态，必须把端点给的原因报出来，
 * 不能笼统报「解析失败」。
 */
function parseResponse(json) {
  if (json && json.error && typeof json.error.message === 'string') {
    throw fail('shape', `端点返回错误：${bodyPreview(json.error.message)}`, { endpointMessage: json.error.message });
  }
  if (!json || typeof json.text !== 'string') {
    throw fail('shape', `响应里没有 text 字段：${bodyPreview(json)}`);
  }
  return json.text.trim();
}

const keyOf = (creds) => {
  if (typeof creds === 'string') return creds;
  if (creds && typeof creds === 'object') return creds.apiKey || creds.key || '';
  return '';
};

/** 该 provider 实际用的 base URL（用户填的优先，否则默认值）。 */
function resolveBaseUrl(id, cfg = {}) {
  return normalizeBaseUrl(cfg.baseUrl || (DEFAULTS[id] ? DEFAULTS[id].baseUrl : ''));
}

function resolveModel(id, cfg = {}) {
  return cfg.model || (DEFAULTS[id] ? DEFAULTS[id].model : '');
}

async function post({
  baseUrl,
  model,
  buffer,
  mime = MIME_WAV,
  hotwords = [],
  key,
  signal,
  segIndex = 0,
  fetchImpl,
  timeoutMs = TIMEOUT_MS,
  tagId = 'openai-compat',
}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const url = `${baseUrl}/audio/transcriptions`;
  const form = buildForm({ buffer, mime, hotwords, model });

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  const tag = () => `provider=${tagId} bytes=${buffer.length} mime=${mime} segIndex=${segIndex} ms=${Date.now() - started}`;

  let res;
  try {
    res = await doFetch(url, {
      method: 'POST',
      // 只给 Authorization。Content-Type 交给 runtime 填（带 boundary），显式设会 400。
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      body: form,
      signal: ctrl.signal,
    });
  } catch (e) {
    logger.warn(`asr/${tagId}`, `${tag()} fetch 失败 ${e && e.name}`);
    throw fail(kindFromFetchError(e, ctrl.signal.aborted), `请求失败：${e && e.message}`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    logger.warn(`asr/${tagId}`, `${tag()} http=${res.status}`);
    throw fail(kindFromStatus(res.status, raw), `HTTP ${res.status}：${bodyPreview(raw)}`, { status: res.status });
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw fail('shape', `返回的不是 JSON：${bodyPreview(raw)}`);
  }
  const text = parseResponse(json);
  logger.info(`asr/${tagId}`, `${tag()} ok chars=${text.length}`);
  return text;
}

/** 造一个 groq / openai / custom provider。 */
function createProvider(id) {
  const d = DEFAULTS[id];
  if (!d) throw new Error(`未知的 openai 兼容后端：${id}`);
  return {
    id,
    name: d.name,
    limits: LIMITS[id],
    isConfigured(cfg = {}, creds) {
      if (keyOf(creds).trim() === '') return false;
      // custom 的 baseUrl 必须用户填，且要能过协议校验
      const raw = cfg.baseUrl || d.baseUrl;
      if (!raw) return false;
      return isUrlAllowed(raw);
    },
    async transcribe({ buffer, mime, hotwords, signal, creds, cfg = {}, segIndex, fetchImpl }) {
      const key = keyOf(creds);
      if (!key) throw fail('local', `${d.name} 缺 API Key`);
      return post({
        baseUrl: resolveBaseUrl(id, cfg),
        model: resolveModel(id, cfg),
        buffer,
        mime,
        hotwords,
        key,
        signal,
        segIndex,
        fetchImpl,
        tagId: id,
      });
    },
  };
}

module.exports = {
  DEFAULTS,
  PROMPT_MAX_CHARS,
  TIMEOUT_MS,
  isUrlAllowed,
  normalizeBaseUrl,
  truncatePrompt,
  fileNameFor,
  buildForm,
  parseResponse,
  resolveBaseUrl,
  resolveModel,
  post,
  createProvider,
};
