'use strict';
// 口语清理（删词器）。默认关闭，只给短输入用——
// 「嗯」「这个我没细看」这类犹豫本身就是复盘和面试的材料，长录音删了就没法诊断。
//
// 模式门控不在这里（在 pipeline，FEAT-003）：三个条件同时成立才调用。
// 本文件的硬约束：**任何失败路径一律返回原文**，清理永远不能让用户丢话。

const POLISH_MIN_CHARS = 8; // 太短的话没必要清理，而且容易被改坏
const POLISH_MAX_GROWTH = 1.4; // 结果比原文长这么多倍，说明模型在加话，直接弃用
const POLISH_TIMEOUT_MS = 8000;
const DEFAULT_MODEL = 'qwen-flash'; // 实测 0.9 秒，够快；qwen-plus 慢一半但没明显更好
const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode';

const POLISH_PROMPT = `你是语音转写的删词器。你唯一被允许的操作是：删掉整个词，以及调整标点。

可以删：嗯、啊、呃、哦、那个、这个、就是、然后、对、反正 这类没有信息的口头禅；
       紧挨着的字级口吃（「咱咱」→「咱」，「我我」→「我」，「再我再」→「我再」）。

不许删重复出现的实词。比如「是方案 A，然后是方案 B，还是方案 A」里三个名词
一个都不能删——说话人可能是在对比、列举、或者刻意重复强调，
删掉就改变了原意，哪怕看起来像卡顿。
判断规则：只有相邻且完全相同的单字才算口吃，两个字以上的词一律保留。

绝对不许：换字、改词、加字、补主语、调语序、把两句合成一句、
         把「再还有」改成「再看看」这类看似通顺的改写。
         哪怕原句读起来不通顺、语法不对、意思不完整，也必须原样留着。

判断标准：把你的输出和原文逐字对照，除了被删掉的词和标点，
剩下每一个字都必须和原文完全一致、顺序完全一致。做不到就少删。

只输出结果，不要解释，不要加引号。

原文：
{text}`;

/**
 * 剥掉标点和空白，只留实义字符，用于逐字比对。
 * 用 \p{L}\p{N}（Unicode 字母+数字）而不是 Python 那套 [^\w\u4e00-\u9fa5]：
 * JS 的 \w 只有 ASCII，照抄会把带音标的拉丁字母（café 的 é）当标点剥掉，
 * 于是「café → cafe」这种**改字**会被误判成纯删除。
 */
const core = (s) => String(s ?? '').replace(/[^\p{L}\p{N}]/gu, '');

/**
 * 结果必须是原文的子序列，也就是「只删不改」。
 *
 * 这是硬约束。提示词管不住模型编造——它会把「再还有」顺成「再看看」，
 * 读着通顺但不是用户说的话。语音输入里编造比留口头禅危险得多，
 * 所以这里用代码卡死：凡是出现原文里没有的字，整个清理结果作废。
 */
function isPureDeletion(original, result) {
  const src = core(original);
  const out = core(result);
  let i = 0;
  for (const ch of out) {
    const at = src.indexOf(ch, i);
    if (at < 0) return false;
    i = at + 1;
  }
  return true;
}

/**
 * 清理端点 base URL 归一化：剥尾斜杠、以及用户多填的 /v1、/chat/completions。
 * 存的是**不含 /v1** 的 base，请求 URL 由 polishUrl() 拼出来。
 */
function normalizePolishBaseUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return DEFAULT_BASE_URL;
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
  s = s.replace(/\/v1$/i, '').replace(/\/+$/, '');
  return s || DEFAULT_BASE_URL;
}

const polishUrl = (baseUrl) => `${normalizePolishBaseUrl(baseUrl)}/v1/chat/completions`;

/**
 * 口语清理。失败一律返回原文。
 * @param {string} text ASR 原文（纠错之后、输出之前）
 * @param {{cfg?:object, key?:string, fetchImpl?:Function}} deps
 * @returns {Promise<{text:string, changed:boolean, reason:string|null}>}
 */
async function polish(text, { cfg = {}, key, fetchImpl = globalThis.fetch } = {}) {
  const src = String(text ?? '');
  const keep = (reason) => ({ text: src, changed: false, reason });
  if (src.length < POLISH_MIN_CHARS) return keep('太短，跳过清理');
  if (!key) return keep('没有清理用的 key');
  if (typeof fetchImpl !== 'function') return keep('没有可用的 fetch');

  const body = {
    model: cfg.polish?.model || DEFAULT_MODEL,
    messages: [{ role: 'user', content: POLISH_PROMPT.replace('{text}', src) }],
    temperature: 0,
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), POLISH_TIMEOUT_MS);
  let out;
  try {
    const resp = await fetchImpl(polishUrl(cfg.polish?.baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!resp.ok) return keep(`清理失败(HTTP ${resp.status})`);
    const data = await resp.json();
    out = String(data?.choices?.[0]?.message?.content ?? '').trim();
  } catch (e) {
    return keep(`清理失败(${e.name})`);
  } finally {
    clearTimeout(timer);
  }
  if (!out) return keep('清理返回空');
  if (out.length > src.length * POLISH_MAX_GROWTH) return keep('清理结果异常变长，已弃用');
  if (!isPureDeletion(src, out)) return keep('清理结果改了字（疑似编造），已弃用');
  return { text: out, changed: out !== src, reason: null };
}

module.exports = {
  POLISH_MIN_CHARS,
  POLISH_MAX_GROWTH,
  POLISH_TIMEOUT_MS,
  DEFAULT_MODEL,
  DEFAULT_BASE_URL,
  POLISH_PROMPT,
  core,
  isPureDeletion,
  normalizePolishBaseUrl,
  polishUrl,
  polish,
};
