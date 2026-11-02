'use strict';
// provider 接口的约定（CommonJS 不做运行时强制，这里是唯一的文字事实源 + 常量表）。
//
// provider 形状：
//   id                                  唯一标识，进配置、进日志、进 creds/<id>.enc
//   name                                界面显示名
//   isConfigured(cfg, creds) → boolean  必需的 Key / BaseURL / 可执行文件齐不齐。
//                                       cfg   = 该 provider 在 配置.json providers[] 里的那一项
//                                       creds = **只有它自己的那份凭据**（index.js 只传 creds[p.id]，
//                                               绝不把一个后端的 key 发给另一个后端，§6.5）
//   transcribe({buffer, mime, hotwords, signal, creds, cfg, wavPath, segIndex}) → Promise<string>
//                                       音频进、文本出。协议差异与热词注入位置由 provider 自己处理，
//                                       index.js 绝不替 provider 拼协议字段（§6.4）。
//                                       wavPath 只在「本次请求就是整份 WAV 文件」时给，
//                                       whispercpp 的 exec 模式靠它免掉一次落盘。
//   limits   {maxSeconds, maxBytes, needsWav, inlineBase64}
//
// 返回值与错误的三条约定（违反会让失败切换出诡异行为）：
//   1. 成功返回**字符串**。空串 = 后端听不出内容，**不是失败**（§6.5：切过去只是让下一个后端
//      对同一段静音再按时长收一次费）。
//   2. 失败一律 throw 带 kind 字段的 Error。注册表只按 kind 决策，不解析文案（文案会随服务商变）。
//   3. kind ∈ KINDS。其中 SWITCH_KINDS 才切后端；'local' 跳过但不进冷却（配置错误修好要立刻可用）；
//      其余（http4xx）直接抛出，不切换。

const KINDS = ['net', 'timeout', 'http4xx', 'http429', 'http5xx', 'auth', 'quota', 'shape', 'local'];

/** 这些 kind 算「后端侧故障」：进冷却 + 切下一个（§6.5）。 */
const SWITCH_KINDS = new Set(['net', 'timeout', 'http5xx', 'http429', 'auth', 'quota', 'shape']);

// limits 取值集中在这里，五个后端一眼可比（§6.2 的表）。
//   maxSeconds   单请求能吃下的最长音频秒数
//   maxBytes     单请求音频体积上限，**按最终发出去的形态算**
//   needsWav     只能吃 WAV（不解码 opus/webm）
//   inlineBase64 请求体里内联 base64（true）还是 multipart 裸字节（false）。
//                slice.bytesToSeconds 按它折算，缺了就只能靠 id 猜。
const LIMITS = {
  // TODO(§21.2 第 0 项)：maxBytes 是**内联 base64 之后的请求体上限**，文档没给，
  //   8MB 是暂定值，等用户用自己的 key 跑一次 scripts/smoke-dashscope.js 实测回填这一行。
  //   录音路径最长 170 秒（base64 约 680KB，安全），真正会撞上限的是 §24 的导入路径。
  dashscope: { maxSeconds: 180, maxBytes: 8 * 1024 * 1024, needsWav: false, inlineBase64: true },
  // 25MB 是 Groq / OpenAI 的上传上限，裸字节口径。maxSeconds 对齐 SPLIT_SECONDS=170：
  // whisper 系没有硬时长限制，真正的约束是那 25MB。
  groq: { maxSeconds: 170, maxBytes: 25 * 1024 * 1024, needsWav: false, inlineBase64: false },
  openai: { maxSeconds: 170, maxBytes: 25 * 1024 * 1024, needsWav: false, inlineBase64: false },
  custom: { maxSeconds: 170, maxBytes: 25 * 1024 * 1024, needsWav: false, inlineBase64: false },
  // 本地无硬限。7200 / Infinity 是占位，needsWav=true 是真的：whisper.cpp 不解码 opus/webm。
  whispercpp: { maxSeconds: 7200, maxBytes: Infinity, needsWav: true, inlineBase64: false },
};

/** 单次最多试几个后端（评审 N6：不许硬编码 3）。长录音收紧成 2，因为一段失败要整次重转。 */
const MAX_PROVIDERS = { short: 3, long: 2 };

/** 冷却默认 5 分钟（cfg.cooldownMs 可配 1–60 分钟）。in-memory，不持久化。 */
const COOLDOWN_MS_DEFAULT = 300000;

/** 错误消息里带的响应体长度上限（已脱敏）。 */
const BODY_PREVIEW = 300;

const MIME_WEBM = 'audio/webm'; // opus 轨（WebM 容器）。v1 不产生 Ogg，所以不用 audio/ogg
const MIME_WAV = 'audio/wav'; // PCM 轨与所有分段

/** 造一个带 kind 的错误。 */
function fail(kind, message, extra = {}) {
  const e = new Error(message);
  e.kind = kind;
  Object.assign(e, extra);
  return e;
}

/** 响应体截成前 300 字塞进错误消息（脱敏由 logger.redact 在落盘时兜底）。 */
function bodyPreview(body) {
  let s;
  if (typeof body === 'string') s = body;
  else {
    try {
      s = JSON.stringify(body);
    } catch {
      s = String(body);
    }
  }
  s = String(s ?? '').replace(/sk-[A-Za-z0-9_\-]{8,}/g, 'sk-***');
  return s.length > BODY_PREVIEW ? `${s.slice(0, BODY_PREVIEW)}…` : s;
}

/** HTTP 状态 + 响应体 → kind。余额/配额归 quota（它和 auth 一样是账号级问题，连环重试只放大损失）。 */
function kindFromStatus(status, bodyText = '') {
  if (status === 429) return 'http429';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'http5xx';
  if (status === 402) return 'quota';
  if (status >= 400) {
    if (/余额|配额|quota|insufficient|billing|credit/i.test(String(bodyText))) return 'quota';
    return 'http4xx';
  }
  return 'http4xx';
}

/** fetch 抛出来的异常 → kind。AbortController 触发的是超时，其余当网络问题。 */
function kindFromFetchError(err, aborted = false) {
  if (aborted || (err && (err.name === 'AbortError' || err.name === 'TimeoutError'))) return 'timeout';
  return 'net';
}

module.exports = {
  KINDS,
  SWITCH_KINDS,
  LIMITS,
  MAX_PROVIDERS,
  COOLDOWN_MS_DEFAULT,
  BODY_PREVIEW,
  MIME_WEBM,
  MIME_WAV,
  fail,
  bodyPreview,
  kindFromStatus,
  kindFromFetchError,
};
