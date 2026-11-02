'use strict';
// 阿里百炼 Qwen3-ASR（DashScope 原生 multimodal-generation，base64 内联）。
//
// 为什么不复用 openai-compat.js：设计决策.md 实测 compatible-mode 的
// /v1/audio/transcriptions 返回 404，百炼这条路只有原生端点能走。
// 也不用 filetrans —— 那个要求音频先传到公网 URL。
//
// 热词位置（§6.4 最容易抄错的地方）：input.messages[0]（role: system）的 content[0].text。

const logger = require('../logger');
const { LIMITS, MIME_WAV, MIME_WEBM, fail, bodyPreview, kindFromStatus, kindFromFetchError } = require('./types');

const ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const DEFAULT_MODEL = 'qwen3-asr-flash';
const TIMEOUT_MS = 120000; // 对齐 asr_shim.py 的 TIMEOUT

/**
 * 请求体。纯函数，可单测。
 * enable_itn 把「一百二十」规范成「120」；enable_lid 是语种识别。
 */
function buildPayload({ buffer, mime = MIME_WAV, hotwords = [], model = DEFAULT_MODEL }) {
  const b64 = Buffer.from(buffer).toString('base64');
  return {
    model: model || DEFAULT_MODEL,
    input: {
      messages: [
        { role: 'system', content: [{ text: hotwords.join(' ') }] },
        { role: 'user', content: [{ audio: `data:${mime};base64,${b64}` }] },
      ],
    },
    parameters: { asr_options: { enable_lid: true, enable_itn: true } },
  };
}

/**
 * 响应解析。纯函数。
 * 口径照抄 asr_shim.py:458-462：choices 缺失或空 → shape 失败；
 * content[] 里所有 text 用空串拼接（中文之间不加空格）后 trim。
 */
function parseResponse(json) {
  const choices = json && json.output ? json.output.choices : undefined;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw fail('shape', `百炼返回里没有 choices：${bodyPreview(json)}`);
  }
  const message = choices[0] && choices[0].message;
  const parts = message && Array.isArray(message.content) ? message.content : [];
  const text = parts
    .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
    .join('')
    .trim();
  return text;
}

const keyOf = (creds) => {
  if (typeof creds === 'string') return creds;
  if (creds && typeof creds === 'object') return creds.apiKey || creds.key || '';
  return '';
};

function isConfigured(_cfg, creds) {
  return keyOf(creds).trim() !== '';
}

async function transcribe({ buffer, mime = MIME_WAV, hotwords = [], signal, creds, cfg = {}, segIndex = 0, fetchImpl }) {
  const key = keyOf(creds);
  if (!key) throw fail('local', '百炼缺 API Key');
  const doFetch = fetchImpl || globalThis.fetch;
  const payload = buildPayload({ buffer, mime, hotwords, model: cfg.model || DEFAULT_MODEL });

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  // 日志只记这几项：请求体里有 base64 音频和热词全文，一个字都不许进日志（§18）。
  const tag = () => `provider=dashscope bytes=${buffer.length} mime=${mime} segIndex=${segIndex} ms=${Date.now() - started}`;

  let res;
  try {
    res = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    logger.warn('asr/dashscope', `${tag()} fetch 失败 ${e && e.name}`);
    throw fail(kindFromFetchError(e, ctrl.signal.aborted), `百炼请求失败：${e && e.message}`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    logger.warn('asr/dashscope', `${tag()} http=${res.status}`);
    throw fail(kindFromStatus(res.status, raw), `百炼 HTTP ${res.status}：${bodyPreview(raw)}`, { status: res.status });
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw fail('shape', `百炼返回的不是 JSON：${bodyPreview(raw)}`);
  }
  const text = parseResponse(json);
  logger.info('asr/dashscope', `${tag()} ok chars=${text.length}`);
  return text;
}

module.exports = {
  id: 'dashscope',
  name: '阿里百炼 Qwen3-ASR',
  limits: LIMITS.dashscope,
  isConfigured,
  transcribe,
  // 导出给测试与其他模块的纯函数 / 常量
  buildPayload,
  parseResponse,
  ENDPOINT,
  DEFAULT_MODEL,
  TIMEOUT_MS,
  MIME_WAV,
  MIME_WEBM,
};
