'use strict';
// 配置读写与逐字段校验（§10.4 那张权威字段表就是本文件的事实源）。
//
// 语义（config.test.js 的断言依据）：
// 1. 坏 JSON / 不是对象 → 坏文件改名 配置.json.bak，整体用默认值。
// 2. 单字段非法 → 只回退该字段，不动其他字段，不整体回退。
// 3. 嵌套对象（热键 / polish / watch）按字段粒度合并。
// 4. providers 是唯一例外：丢弃非法项后按默认顺序补齐五个 id 的全排列。
// 5. 每次回退记一条 warn（值要过脱敏）。
//
// API Key 绝不出现在这张表里，一律在 creds/<id>.enc（§9）。

const fs = require('fs');
const paths = require('./paths');
const logger = require('./logger');
const { normalizePolishBaseUrl } = require('./polish');

const PROVIDER_IDS = ['dashscope', 'groq', 'openai', 'custom', 'whispercpp'];
const MODEL_RE = /^[A-Za-z0-9._\-]+$/;

function defaults() {
  return {
    记录历史: true,
    历史保留天数: 90,
    转录目录: paths.defaultTranscriptDir(),
    开机自启: false,
    口语清理: false,
    已提示赞助: false,
    cooldownMs: 300000,
    // 热词自动提炼（设计决策.md 追加需求二·四）。阈值默认 5 而不是 mine 的 3：
    // 自动入表没有人工闸，门槛必须更严，否则一次听错重复几遍就进表了。
    热词自动提炼: { 开启: true, 频率: 'weekly', 阈值: 5 },
    热键: { 模式: 'single', 短输入: 'Control+Shift+Space', 长录音: 'Control+Shift+L' },
    // maxSeconds 故意不写进默认值：缺键 = 用后端自己的 limits.maxSeconds（§6.2），
    // 写死在这里会和 asr/types.js 的 LIMITS 形成两个事实源。
    providers: [
      { id: 'dashscope', enabled: true },
      { id: 'groq', enabled: true },
      { id: 'openai', enabled: true },
      { id: 'custom', enabled: true, baseUrl: '', model: '' },
      { id: 'whispercpp', enabled: true, mode: 'exec', execPath: '', modelPath: '', serverUrl: '' },
    ],
    polish: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode', model: 'qwen-flash' },
    watch: { enabled: false, dir: '', intervalSec: 5 },
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isStr = (v) => typeof v === 'string';

/** https 协议，或本地回环上的 http（whisper.cpp server 必须允许）。 */
function isUrlOk(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

// 热键串的形状校验。真正的 accelerator 合法性由 hotkeys.validate() 负责（FEAT-003），
// 这里只拦明显坏值，避免 config 反过来依赖 hotkeys（它要碰 electron）。
const isAccel = (v) => isStr(v) && v.trim() !== '' && !/\s/.test(v);

function validateProvider(raw, warn) {
  if (!isObj(raw) || !PROVIDER_IDS.includes(raw.id)) {
    warn(`providers 丢弃非法项：${JSON.stringify(raw)}`);
    return null;
  }
  const base = defaults().providers.find((p) => p.id === raw.id);
  const out = { ...base };
  const take = (key, ok) => {
    if (raw[key] === undefined) return;
    if (ok(raw[key])) out[key] = raw[key];
    else warn(`providers[${raw.id}].${key} 非法，已回退：${JSON.stringify(raw[key])}`);
  };
  take('enabled', (v) => typeof v === 'boolean');
  take('baseUrl', (v) => isStr(v) && (v === '' || isUrlOk(v)));
  take('serverUrl', (v) => isStr(v) && (v === '' || isUrlOk(v)));
  take('model', (v) => isStr(v) && (v === '' || (v.length <= 64 && MODEL_RE.test(v))));
  take('mode', (v) => v === 'exec' || v === 'server');
  take('execPath', isStr);
  take('modelPath', isStr);
  take('maxSeconds', (v) => isInt(v, 1, 7200));
  return out;
}

/** providers：丢弃非法项与重复 id，再按默认顺序补齐五个。 */
function validateProviders(raw, warn) {
  const def = defaults().providers;
  if (!Array.isArray(raw)) {
    if (raw !== undefined) warn(`providers 不是数组，已回退默认：${JSON.stringify(raw)}`);
    return def;
  }
  const seen = new Set();
  const kept = [];
  for (const item of raw) {
    const p = validateProvider(item, warn);
    if (!p) continue;
    if (seen.has(p.id)) {
      warn(`providers 丢弃重复 id：${p.id}`);
      continue;
    }
    seen.add(p.id);
    kept.push(p);
  }
  for (const d of def) if (!seen.has(d.id)) kept.push({ ...d });
  return kept;
}

/** 按字段粒度合并嵌套对象。 */
function mergeNested(name, raw, def, rules, warn) {
  const out = { ...def };
  if (raw !== undefined && !isObj(raw)) {
    warn(`${name} 不是对象，已回退默认：${JSON.stringify(raw)}`);
    return out;
  }
  for (const [key, rule] of Object.entries(rules)) {
    const v = raw?.[key];
    if (v === undefined) continue;
    if (rule.ok(v)) out[key] = rule.coerce ? rule.coerce(v) : v;
    else warn(`${name}.${key} 非法，已回退默认：${JSON.stringify(v)}`);
  }
  return out;
}

/**
 * 逐字段校验。
 * @returns {{value: object, warnings: string[]}}
 */
function validate(raw) {
  const def = defaults();
  const warnings = [];
  const warn = (msg) => warnings.push(logger.redact(msg));
  if (!isObj(raw)) {
    if (raw !== undefined) warn(`配置不是对象，整体回退默认：${JSON.stringify(raw)}`);
    return { value: def, warnings };
  }
  const value = { ...def };
  const top = {
    记录历史: (v) => typeof v === 'boolean',
    开机自启: (v) => typeof v === 'boolean',
    口语清理: (v) => typeof v === 'boolean',
    已提示赞助: (v) => typeof v === 'boolean',
    历史保留天数: (v) => isInt(v, 0, 3650), // ≤0 视为不清理
    cooldownMs: (v) => isInt(v, 60000, 3600000),
    转录目录: (v) => isStr(v) && v !== '' && require('path').isAbsolute(v),
  };
  for (const [key, ok] of Object.entries(top)) {
    const v = raw[key];
    if (v === undefined) continue;
    if (ok(v)) value[key] = v;
    else warn(`${key} 非法，已回退默认：${JSON.stringify(v)}`);
  }
  value.热键 = mergeNested(
    '热键',
    raw.热键,
    def.热键,
    { 模式: { ok: (v) => v === 'single' || v === 'combo' }, 短输入: { ok: isAccel }, 长录音: { ok: isAccel } },
    warn
  );
  value.polish = mergeNested(
    'polish',
    raw.polish,
    def.polish,
    {
      baseUrl: { ok: (v) => isStr(v) && isUrlOk(v), coerce: normalizePolishBaseUrl },
      model: { ok: (v) => isStr(v) && v.length <= 64 && MODEL_RE.test(v) },
    },
    warn
  );
  value.热词自动提炼 = mergeNested(
    '热词自动提炼',
    raw.热词自动提炼,
    def.热词自动提炼,
    {
      开启: { ok: (v) => typeof v === 'boolean' },
      频率: { ok: (v) => v === 'weekly' || v === 'monthly' || v === 'off' },
      阈值: { ok: (v) => isInt(v, 2, 100) },
    },
    warn
  );
  value.watch = mergeNested(
    'watch',
    raw.watch,
    def.watch,
    {
      enabled: { ok: (v) => typeof v === 'boolean' },
      dir: { ok: (v) => isStr(v) && (v === '' || require('path').isAbsolute(v)) },
      intervalSec: { ok: (v) => isInt(v, 2, 300) },
    },
    warn
  );
  value.providers = validateProviders(raw.providers, warn);
  return { value, warnings };
}

/** 读盘 + 校验。坏 JSON 改名 配置.json.bak 后整体默认。 */
function load() {
  const file = paths.configPath();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      try {
        fs.renameSync(file, paths.configBakPath());
        logger.warn('config', `配置.json 无法解析，已改名为 配置.json.bak：${e.message}`);
      } catch (e2) {
        logger.error('config', `配置.json 无法解析且改名失败：${e2.message}`);
      }
    }
    return defaults();
  }
  const { value, warnings } = validate(raw);
  for (const w of warnings) logger.warn('config', w);
  return value;
}

/** 浅层 patch（嵌套对象按字段粒度合并），校验后落盘，返回落盘后的完整配置。 */
function save(patch = {}) {
  const current = load();
  const merged = { ...current };
  for (const [key, v] of Object.entries(patch)) {
    merged[key] = isObj(v) && isObj(current[key]) ? { ...current[key], ...v } : v;
  }
  const { value, warnings } = validate(merged);
  for (const w of warnings) logger.warn('config', w);
  fs.mkdirSync(paths.dataDir(), { recursive: true });
  fs.writeFileSync(paths.configPath(), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return value;
}

module.exports = { defaults, validate, load, save, PROVIDER_IDS };
