'use strict';
// 设置窗 renderer（design.md §11、§24、§25）。
//
// 三条纪律：
// ① **所有数据经 window.vi.*（preload 转发）拿，校验一律在 main**（§16）。
//    这里写的任何「检查」只是给用户的即时反馈，不是防线——renderer 是不可信输入源。
// ② **不用 innerHTML 拼任何动态内容**。历史文本、文件名、后端返回的错误消息
//    全是外部数据，一律走 textContent / createElement。
// ③ 无框架、无构建步骤。

// ⚠ 这个别名**不能叫 vi**。contextBridge 暴露出来的 window.vi 是 window 上一个
// 不可配置的属性，顶层再写 `const vi = …` 会直接抛
// `Identifier 'vi' has already been declared`，整个脚本一行都不执行 → 界面全白。
// 实测踩过（recorder.js 里同样叫 api，就是这个原因）。
const api = window.vi;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/** 建元素。children 里的字符串一律当文本（不是 HTML）。 */
function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    n.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

const fill = (node, children) => {
  node.textContent = '';
  for (const c of [].concat(children)) if (c) node.append(c);
};

/** 一闪而过的「已保存」提示。 */
let flashTimer = null;
function flash(msg, bad = false) {
  const n = $('#st-saved');
  n.textContent = msg;
  n.style.color = bad ? 'var(--bad)' : 'var(--ok)';
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { n.textContent = ''; }, 2600);
}

function say(sel, msg, bad = false) {
  const n = $(sel);
  if (!n) return;
  n.textContent = msg || '';
  n.style.color = bad ? 'var(--bad)' : 'var(--fg-dim)';
}

const STATE_TEXT = {
  idle: '待机', recording: '录音中', busy: '转写中', ok: '已存文件',
  copied: '已复制', warn: '出错了', nomic: '麦克风不可用',
};

/** kind → 人话。注册表只按 kind 决策、不解析文案，所以文案只在这一处。 */
const KIND_LABEL = {
  net: '网络不通（连不上服务器）',
  timeout: '请求超时',
  auth: 'Key 不对或没权限（HTTP 401 / 403）',
  http429: '被限流了（HTTP 429）',
  http4xx: '请求被拒（HTTP 4xx）',
  http5xx: '服务端出错（HTTP 5xx）',
  quota: '余额或配额不够',
  shape: '协议对不上（返回的结构不认识）',
  local: '配置不完整（Key / 地址 / 路径有缺）',
  'no-capable-provider': '这个后端当前用不上（没配好、被禁用，或音频超过它的时长/体积上限）',
  'all-failed': '所有后端都失败了',
  decrypt: '密钥无法解密，需要重新填一次',
  unsupported: '格式不支持',
  'import-too-large': '文件太大',
  'too-large-unsplittable': '文件过大且无法切分',
  silent: '整段都是静音',
  empty: '没识别出内容',
  decode: '解码失败',
};
const kindText = (kind) => KIND_LABEL[kind] || kind || '未知原因';

const PROV_STATE = { ok: '可用', unconfigured: '未配置', cooldown: '冷却中', disabled: '已禁用' };

let cfg = {}; // 最近一次 config:get 的结果
let lastState = {};

// ───────────────────────── 标签页 ─────────────────────────

const TABS = ['backends', 'hotwords', 'hotkeys', 'behavior', 'import', 'sponsor'];

/** 切到哪一页时要刷新什么。打开才拉数据，别在后台轮询用不到的页。 */
const ON_SHOW = {
  backends: () => refreshProviders(),
  hotwords: () => { loadHotwords(); loadAutoHotwords(); },
  hotkeys: () => renderHotkeys(),
  behavior: () => { renderBehavior(); loadHistory(); },
  import: () => renderQueue(lastState.imports || []),
  sponsor: () => loadSponsor(),
};

function showTab(name) {
  const tab = TABS.includes(name) ? name : 'backends';
  for (const b of $$('.tab')) b.classList.toggle('on', b.dataset.tab === tab);
  for (const p of $$('.panel')) p.classList.toggle('on', p.dataset.panel === tab);
  if (ON_SHOW[tab]) ON_SHOW[tab]();
}

/** hash 形如 #backends 或 #backends&guide=1（main 打开首次引导时带后者）。 */
function applyHash() {
  const raw = location.hash.replace(/^#/, '');
  const [name, ...rest] = raw.split('&');
  showTab(name);
  if (rest.includes('guide=1')) $('#guide').hidden = false;
}

function wireTabs() {
  for (const b of $$('.tab')) b.addEventListener('click', () => { location.hash = `#${b.dataset.tab}`; });
  window.addEventListener('hashchange', applyHash);
}

/**
 * 补转队列里被跳过的条目（评审 M2）。
 * 这些录音已经保住了，但没有后端能处理它，调度会一直跳过——不说一声
 * 用户只会看到一个不降的队列计数，等于音频还是丢了。所以把时长、上限、
 * 文件路径都摆出来，再给一个「打开数据目录」的出口让他自己处理。
 */
function renderStuck(list) {
  const box = $('#stuck-note');
  if (!box) return;
  if (!list.length) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  const rows = list.map((it) => {
    const secs = Number.isFinite(it.durationSec) ? `${Math.round(it.durationSec)} 秒` : '这段';
    const cap = Number.isFinite(it.maxSeconds) ? `，后端最长只能吃 ${it.maxSeconds} 秒` : '';
    // 理由要分家：说错原因等于让用户照着假线索去改配置（评审 H1 的另一半）
    const why = it.stuck === 'too-many-failures'
      ? '连续转失败多次，已停止自动重试'
      : `没有后端能处理${cap}`;
    return el('p', {}, [
      `· ${secs}的录音${why}，已跳过（后面的条目照常补转）：`,
      el('code', { text: it.path }),
    ]);
  });
  const btn = el('button', { type: 'button', text: '打开数据目录' });
  btn.addEventListener('click', () => api.openDataDir());
  fill(box, [
    el('p', {}, [el('b', { text: `有 ${list.length} 条录音转不出来，音频还在，可以自己处理` })]),
    ...rows,
    el('p', { class: 'hint', text: '配好一个能吃这个长度的后端（或点托盘里的「重置后端状态」）之后会自动重试。' }),
    btn,
  ]);
  box.hidden = false;
}

/** 顶部状态条。state:changed 推一次就刷一次（§11 的 onState）。 */
function renderStatus(s) {
  lastState = s || {};
  $('#st-state').textContent = STATE_TEXT[s.state] || s.state || '待机';
  $('#st-provider').textContent = `后端：${s.provider || '—'}`;
  $('#st-pending').textContent = s.pending > 0 ? `⏳ ${s.pending} 条待补转` : '';
  renderStuck(s.stuck || []);
  const active = (s.imports || []).filter((j) => j.status !== 'done' && j.status !== 'failed').length;
  const bits = [];
  if (s.watching) bits.push('监听中');
  if (active > 0) bits.push(`导入 ${active} 个在队列里`);
  $('#st-watch').textContent = bits.join(' · ');
  // 导入页与热键页的内容依赖这两项，顺手刷掉
  if ($('.panel[data-panel="import"]').classList.contains('on')) renderQueue(s.imports || []);
  if ($('.panel[data-panel="hotkeys"]').classList.contains('on')) renderHotkeyModeLine();
}

/** 保存配置的统一出口：main 校验不过就把原因显示出来，不自己判。 */
async function saveConfig(patch, msgSel) {
  const r = await api.setConfig(patch);
  if (!r || r.ok === false) {
    const why = (r && (r.reason || r.message)) || '保存失败';
    if (msgSel) say(msgSel, why, true);
    flash(why, true);
    return null;
  }
  cfg = await api.getConfig();
  if (msgSel) say(msgSel, '已保存');
  flash('已保存');
  return cfg;
}

// ───────────────────── 后端与密钥 ─────────────────────

/** 每个后端显示哪些字段 + 去哪拿 Key 的外链。 */
const PROV = {
  dashscope: { key: true, link: 'https://bailian.console.aliyun.com/', linkText: '去百炼控制台拿 Key' },
  groq: { key: true, link: 'https://console.groq.com/keys', linkText: '去 Groq 控制台拿 Key' },
  openai: { key: true, link: 'https://platform.openai.com/api-keys', linkText: '去 OpenAI 控制台拿 Key' },
  custom: { key: true, baseUrl: true, model: true, endpointNote: true },
  whispercpp: { mode: true, execPath: true, modelPath: true, serverUrl: true, link: 'https://github.com/ggml-org/whisper.cpp', linkText: 'whisper.cpp 安装说明' },
};

const expanded = new Set(); // 哪几行展开着，刷新时保持
let cooldownTimer = null;

const entryOf = (id) => (cfg.providers || []).find((p) => p.id === id) || { id };

/** 一行一个后端。 */
function provRow(st) {
  const spec = PROV[st.id] || {};
  const entry = entryOf(st.id);
  const open = expanded.has(st.id);

  const stateText = st.state === 'cooldown'
    ? `冷却中，还剩 ${Math.ceil((st.cooldownRemainMs || 0) / 1000)} 秒`
    : PROV_STATE[st.state] || st.state;

  const toggle = el('input', { type: 'checkbox', ...(entry.enabled === false ? {} : { checked: true }) });
  toggle.addEventListener('change', async () => {
    const next = (cfg.providers || []).map((p) => (p.id === st.id ? { ...p, enabled: toggle.checked } : p));
    await saveConfig({ providers: next });
    refreshProviders();
  });

  const expandBtn = el('button', { class: 'link', text: open ? '收起' : '展开' });
  expandBtn.addEventListener('click', () => {
    if (open) expanded.delete(st.id); else expanded.add(st.id);
    refreshProviders();
  });

  const head = el('div', { class: 'prov-head' }, [
    el('span', { class: 'grip', title: '拖动调整优先级', text: '⠿' }),
    el('span', { class: `dot ${st.state}`, title: stateText }),
    el('span', { class: 'prov-name', text: st.name }),
    el('span', { class: 'prov-state', text: stateText }),
    el('span', { class: 'spacer' }),
    el('label', {}, [toggle, ' 启用']),
    expandBtn,
  ]);

  const row = el('div', { class: 'prov', draggable: 'true', dataset: { id: st.id } }, [head]);
  if (open) row.append(provBody(st, spec, entry));
  return row;
}

/** 展开区：字段 + 测试连接 + 三处固定文案。 */
function provBody(st, spec, entry) {
  const body = el('div', { class: 'prov-body' });

  // custom 行的固定提示（评审 N6）。下方「口语清理」也要填一个 OpenAI 兼容端点，
  // 用户很容易把同一个地址也填进这里，所以这句必须出现在这一行，不能只写在 README 里。
  if (spec.endpointNote) {
    body.append(el('p', { class: 'warn prov-note' }, [
      '⚠ 这里要填的是',
      el('b', { text: '语音识别（ASR）端点' }),
      '，形如 ',
      el('code', { text: 'https://api.example.com/v1' }),
      '。只提供对话补全、没有 ASR 路由的网关',
      el('b', { text: '只能用于下方的「口语清理」' }),
      '，填在这里一定失败（常见报错是网关说不认识 ASR 这个 ApiMode）。',
    ]));
  }

  if (spec.key) {
    const input = el('input', {
      type: 'password', spellcheck: 'false', autocomplete: 'off',
      placeholder: st.mask || '粘贴 API Key',
    });
    const save = el('button', { text: '保存 Key' });
    const out = el('span', { class: 'muted', text: st.mask ? `已保存 ${st.mask}` : '未填' });
    save.addEventListener('click', async () => {
      const v = input.value.trim();
      if (v === '') { out.textContent = 'Key 不能为空'; return; }
      const r = await api.setKey(st.id, v);
      if (r && r.ok) {
        input.value = '';
        out.textContent = `已保存 ${r.mask}`;
        // 格式不像 sk-… 只警告不拦截（§16）
        if (!/^sk-[A-Za-z0-9_-]{8,}$/.test(v)) out.textContent += '（格式不太像常见的 sk-… ，已照样保存）';
        flash('Key 已保存');
        refreshProviders();
      } else {
        out.textContent = `保存失败：${kindText(r && r.reason)}`;
      }
    });
    body.append(el('div', { class: 'field' }, [el('label', { text: 'API Key' }), input, save, out]));
  }

  const textField = (label, key, placeholder, type = 'text') => {
    const input = el('input', { type, spellcheck: 'false', placeholder: placeholder || '' });
    input.value = entry[key] || '';
    input.addEventListener('change', async () => {
      const next = (cfg.providers || []).map((p) => (p.id === st.id ? { ...p, [key]: input.value.trim() } : p));
      await saveConfig({ providers: next });
      refreshProviders();
    });
    return el('div', { class: 'field' }, [el('label', { text: label }), input]);
  };

  if (spec.baseUrl) {
    body.append(textField('Base URL', 'baseUrl', 'https://… 的 OpenAI 兼容端点，会自动补 /v1'));
  }
  if (spec.model) body.append(textField('模型名', 'model', 'whisper-1'));
  if (spec.mode) {
    const sel = el('select', {}, [
      el('option', { value: 'exec', text: 'exec（调本地可执行文件）' }),
      el('option', { value: 'server', text: 'server（连本地 HTTP 服务）' }),
    ]);
    sel.value = entry.mode || 'exec';
    sel.addEventListener('change', async () => {
      const next = (cfg.providers || []).map((p) => (p.id === st.id ? { ...p, mode: sel.value } : p));
      await saveConfig({ providers: next });
      refreshProviders();
    });
    body.append(el('div', { class: 'field' }, [el('label', { text: '模式' }), sel]));
    if ((entry.mode || 'exec') === 'exec') {
      body.append(textField('可执行文件', 'execPath', '/usr/local/bin/whisper-cli'));
      body.append(textField('模型文件', 'modelPath', '…/ggml-large-v3-turbo.bin'));
    } else {
      body.append(textField('服务地址', 'serverUrl', 'http://127.0.0.1:8080'));
    }
  }

  // 时长上限（H1 配套）。不写这行，用户只会看到这个后端「从来没被用过」，
  // 而日志里连一行失败都没有——它是被静默滤掉的，不是失败。
  const capInput = el('input', { type: 'number', min: '1', max: '7200', step: '1', placeholder: String(st.maxSecondsEffective || '') });
  if (Number.isFinite(entry.maxSeconds)) capInput.value = entry.maxSeconds;
  capInput.addEventListener('change', async () => {
    const raw = capInput.value.trim();
    const v = raw === '' ? undefined : Number(raw);
    const next = (cfg.providers || []).map((p) => {
      if (p.id !== st.id) return p;
      const copy = { ...p };
      if (v === undefined) delete copy.maxSeconds; else copy.maxSeconds = v;
      return copy;
    });
    await saveConfig({ providers: next });
    refreshProviders();
  });
  body.append(el('div', { class: 'field' }, [
    el('label', { text: '时长上限' }),
    capInput, ' 秒',
    el('span', { class: 'hint', text: '留空 = 用这个后端自己的上限。填了只能更严，不能放宽。' }),
  ]));
  if (st.maxSecondsEffective && st.maxSecondsEffective < 170) {
    body.append(el('p', {
      class: 'prov-note cap',
      text: `时长上限 ${st.maxSecondsEffective} 秒，更长的录音会跳过此后端。`,
    }));
  }

  // 非百炼后端的热词容量提示。具体字数等实测回填（真实上限是约 224 token 不是
  // 字符），所以这里**不写数字**。
  if (st.id !== 'dashscope') {
    body.append(el('p', { class: 'prov-note', text: '该后端热词容量有限，长表只有开头部分生效。' }));
  }

  const testBtn = el('button', { text: '测试连接' });
  const testOut = el('span', { class: 'test-out' });
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testOut.className = 'test-out';
    testOut.textContent = '测试中…（会真发一次 0.5 秒的请求）';
    const r = await api.testKey(st.id);
    testBtn.disabled = false;
    if (r && r.ok) {
      testOut.className = 'test-out ok';
      testOut.textContent = '成功';
      refreshProviders();
    } else {
      testOut.className = 'test-out bad';
      const m = (r && r.message) || '';
      const http = /HTTP\s*(\d{3})/i.exec(m);
      testOut.textContent = http ? `失败：HTTP ${http[1]} · ${kindText(r.kind)}` : `失败：${kindText(r && r.kind)}`;
      testOut.title = m;
    }
  });
  body.append(el('p', { class: 'row' }, [testBtn, testOut]));

  if (st.lastFailKind) {
    body.append(el('p', { class: 'prov-fail', text: `上次失败原因：${kindText(st.lastFailKind)}` }));
  }
  return body;
}

/** 拖拽排序：顺序就是 chain 顺序。 */
function wireDrag(list) {
  let dragId = null;
  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.prov');
    if (!row) return;
    dragId = row.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
  });
  list.addEventListener('dragover', (e) => {
    const row = e.target.closest('.prov');
    if (!row || !dragId || row.dataset.id === dragId) return;
    e.preventDefault();
    row.classList.add('drag-over');
  });
  list.addEventListener('dragleave', (e) => {
    const row = e.target.closest('.prov');
    if (row) row.classList.remove('drag-over');
  });
  list.addEventListener('drop', async (e) => {
    const row = e.target.closest('.prov');
    if (!row || !dragId) return;
    e.preventDefault();
    row.classList.remove('drag-over');
    const ids = [...list.querySelectorAll('.prov')].map((n) => n.dataset.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(row.dataset.id);
    if (from < 0 || to < 0 || from === to) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    const byId = new Map((cfg.providers || []).map((p) => [p.id, p]));
    await saveConfig({ providers: ids.map((id) => byId.get(id)).filter(Boolean) });
    dragId = null;
    refreshProviders();
  });
}

/**
 * 主界面那条「当前可用的后端」。只列真的能用上的（已配好 / 冷却中），
 * 没配过的不摆出来——摆五个空位只增加选择负担（追加需求二·三）。
 */
function provStrip(providers) {
  const box = $('#prov-strip');
  const usable = providers.filter((p) => p.state !== 'unconfigured' && p.state !== 'disabled');
  if (usable.length === 0) {
    fill(box, [el('p', { class: 'hint', text: '还没有可用的后端。填一个 Key，或者在高级设置里配好本地 whisper.cpp。' })]);
    return;
  }
  fill(box, usable.map((st) => {
    const stateText = st.state === 'cooldown'
      ? `冷却中，还剩 ${Math.ceil((st.cooldownRemainMs || 0) / 1000)} 秒`
      : PROV_STATE[st.state] || st.state;
    const test = el('button', { text: '测试连接' });
    const out = el('span', { class: 'test-out' });
    test.addEventListener('click', async () => {
      test.disabled = true;
      out.className = 'test-out';
      out.textContent = '测试中…';
      const r = await api.testKey(st.id);
      test.disabled = false;
      if (r && r.ok) { out.className = 'test-out ok'; out.textContent = '成功'; refreshProviders(); }
      else {
        out.className = 'test-out bad';
        const m = (r && r.message) || '';
        const http = /HTTP\s*(\d{3})/i.exec(m);
        out.textContent = http ? `失败：HTTP ${http[1]} · ${kindText(r.kind)}` : `失败：${kindText(r && r.kind)}`;
        out.title = m;
      }
    });
    return el('div', { class: 'strip-row' }, [
      el('span', { class: `dot ${st.state}` }),
      el('span', { class: 'prov-name', text: st.name }),
      el('span', { class: 'prov-state', text: stateText }),
      st.mask ? el('span', { class: 'muted', text: st.mask }) : null,
      el('span', { class: 'spacer' }),
      test,
      out,
    ]);
  }));
}

async function refreshProviders() {
  cfg = await api.getConfig();
  const r = await api.asrStatus();
  const providers = (r && r.providers) || [];
  provStrip(providers);
  const list = $('#provider-list');
  fill(list, providers.map(provRow));
  if (r && r.encryptionOk === false) {
    list.prepend(el('p', { class: 'warn', text: '⚠ 当前系统无法安全存储密钥，识别功能已禁用。不会退化成明文保存 Key。' }));
  }
  // 冷却剩余秒数要走字，但只在这一页开着的时候刷
  if (cooldownTimer) clearTimeout(cooldownTimer);
  if ((r && r.providers ? r.providers : []).some((p) => p.state === 'cooldown')) {
    cooldownTimer = setTimeout(() => {
      if ($('.panel[data-panel="backends"]').classList.contains('on')) refreshProviders();
    }, 1000);
  }
}

/** 探测失败的原因 → 可操作的下一步。不要只说「无效」（追加需求二·二）。 */
const DETECT_HINT = {
  'shape-empty': '输入框是空的。',
  'shape-whitespace': 'Key 里有空格或换行，像是复制时粘到了别的东西，重新复制一次。',
  'shape-too-short': '这串太短了，不像一个完整的 Key——多半是只复制到了一半。',
  'shape-non-ascii': '这串里有中文或别的非英文字符，不像一个 Key——确认是不是把说明文字一起复制了。',
  'shape-too-long': '这串太长了，可能把别的内容一起粘进来了。',
  'all-rejected': '三家都说这个 Key 不对。先确认有没有复制完整（开头到结尾，别漏字符），以及这个 Key 在控制台里还有效。',
  'all-inconclusive': '能连上，但三家都没认它。常见原因是**还没在控制台开通对应模型**（百炼要先在模型广场开通 qwen3-asr-flash），开通后再试。',
  'all-unreachable': '一家都连不上，看着像网络问题：确认能上外网，公司网络可能需要代理。',
};

function wireDetect() {
  const input = $('#key-one');
  const btn = $('#key-detect');
  const out = $('#key-detect-out');
  const run = async () => {
    const key = input.value.trim();
    if (key === '') { out.className = 'detect-out'; out.textContent = ''; return; }
    btn.disabled = true;
    out.className = 'detect-out';
    out.textContent = '正在识别这个 Key 属于哪家…';
    const r = await api.detectKey(key);
    btn.disabled = false;
    if (!r || r.ok !== true) {
      out.className = 'detect-out bad';
      const reason = (r && (r.reason || r.kind)) || 'all-rejected';
      out.textContent = `没认出来：${DETECT_HINT[reason] || reason}`;
      return;
    }
    // 认出来了就直接存到对应后端，并把它提到第一位、确保启用
    const saved = await api.setKey(r.id, key);
    if (!saved || !saved.ok) {
      out.className = 'detect-out bad';
      out.textContent = `已识别：${r.name}，但保存失败：${kindText(saved && saved.reason)}`;
      return;
    }
    const rest = (cfg.providers || []).filter((p) => p.id !== r.id);
    const hit = (cfg.providers || []).find((p) => p.id === r.id) || { id: r.id };
    await saveConfig({ providers: [{ ...hit, enabled: true }, ...rest] });
    input.value = '';
    out.className = 'detect-out ok';
    out.textContent = `✓ 已识别：${r.name}，Key 已加密保存（${saved.mask}），已设为首选后端。`;
    flash(`已配置 ${r.name}`);
    refreshProviders();
  };
  btn.addEventListener('click', run);
  // 失焦也触发一次，省一次点击
  input.addEventListener('blur', () => { if (input.value.trim() !== '') run(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
}

function wireBackends() {
  wireDetect();
  wireDrag($('#provider-list'));
  $('#reset-cooldowns').addEventListener('click', async () => {
    await api.asrReset();
    flash('已重置后端状态');
    refreshProviders();
  });
  $('#guide-dismiss').addEventListener('click', () => { $('#guide').hidden = true; });
  $('#polish-key-save').addEventListener('click', async () => {
    const v = $('#polish-key').value.trim();
    if (v === '') { say('#polish-key-state', '留空就是复用百炼的 Key，不用保存'); return; }
    const r = await api.setKey('polish', v);
    if (r && r.ok) {
      $('#polish-key').value = '';
      say('#polish-key-state', `已保存 ${r.mask}`);
      flash('清理 Key 已保存');
    } else {
      say('#polish-key-state', `保存失败：${kindText(r && r.reason)}`, true);
    }
  });
  $('#polish-save').addEventListener('click', async () => {
    const baseUrl = $('#polish-base').value.trim();
    const model = $('#polish-model').value.trim() || 'qwen-flash';
    // 留空就是「复用百炼的 Key 走它的兼容端点」，main 会回退到默认 base
    const saved = await saveConfig({ polish: { baseUrl, model } }, '#polish-msg');
    if (!saved) return;
    renderPolish();
    // main 保存前会剥掉多填的 /v1、/chat/completions（§16），存回来的和用户填的不一样就说一声
    const after = (saved.polish && saved.polish.baseUrl) || '';
    if (baseUrl && after !== baseUrl) say('#polish-msg', `已规范化为 ${after}`);
  });
}

function renderPolish() {
  $('#polish-base').value = (cfg.polish && cfg.polish.baseUrl) || '';
  $('#polish-model').value = (cfg.polish && cfg.polish.model) || 'qwen-flash';
  api.hasKey('polish').then((r) => {
    say('#polish-key-state', r && r.has ? `已保存 ${r.mask}` : '未填（将复用百炼的 Key）');
  });
}

// ───────────────────────── 热词 ─────────────────────────

const HOTWORDS_MAX_CHARS = 20000;
const HOTWORDS_WARN_WORDS = 600;

/** 词数统计与 main 侧 hotwords.parse 同一口径：剥 # 注释后按空白切。 */
function countWords(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.split('#', 1)[0])
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

function renderHotwordCount() {
  const text = $('#hotwords-text').value;
  const words = countWords(text);
  const n = $('#hotwords-count');
  n.textContent = `${words} 个词 · ${text.length} 字符`;
  if (text.length > HOTWORDS_MAX_CHARS) {
    n.style.color = 'var(--bad)';
    n.textContent += `（超过 ${HOTWORDS_MAX_CHARS} 字符，保存会被拒）`;
  } else if (words > HOTWORDS_WARN_WORDS) {
    n.style.color = 'var(--warn-line)';
    n.textContent += '（表太长会稀释每个词的权重）';
  } else {
    n.style.color = 'var(--fg-dim)';
  }
}

async function loadHotwords() {
  $('#hotwords-text').value = await api.getHotwords();
  renderHotwordCount();
}

let candidates = [];

function renderCandidates(list) {
  candidates = list || [];
  $('#mine-box').hidden = candidates.length === 0;
  // 默认全不选：ASR 的错词同样会高频出现，自动入表会让错误自我强化
  fill($('#mine-list'), candidates.map((c) => el('label', {}, [
    el('input', { type: 'checkbox', value: c.word }),
    ` ${c.word}`,
    el('span', { class: 'cand-count', text: `×${c.count}` }),
  ])));
}

// ─────────── 自动提炼的热词台账（追加需求二·四） ───────────

const fmtTime = (ms) => {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function renderAutoHotwords(data) {
  const words = (data && data.words) || [];
  const black = (data && data.blacklist) || [];
  $('#ah-count').textContent = words.length
    ? `共 ${words.length} 个，上次提炼 ${fmtTime(data.lastRunAt)}`
    : `还没有自动添加过。上次提炼 ${fmtTime(data && data.lastRunAt)}`;
  $('#ah-clear').disabled = words.length === 0;

  fill($('#ah-list'), words.map((w) => {
    const del = el('button', { class: 'link', text: '移除并永不添加' });
    del.addEventListener('click', async () => {
      const r = await api.autoHotwords('remove', w.word);
      renderAutoHotwords(r);
      loadHotwords();
      flash(`已移除「${w.word}」`);
    });
    const keep = el('button', { class: 'link', text: '只移除' });
    keep.addEventListener('click', async () => {
      // 只移除不拉黑：下次提炼它还可能回来，这是用户要的「我这次不想要」
      const r = await api.autoHotwords('remove', w.word);
      renderAutoHotwords(r);
      loadHotwords();
    });
    return el('div', { class: 'list-item' }, [
      el('div', { class: 'list-meta' }, [
        el('b', { text: w.word }),
        el('span', { text: `说过 ${w.count} 次` }),
        el('span', { text: `加入于 ${fmtTime(w.addedAt)}` }),
        el('span', { class: 'spacer' }),
        del,
      ]),
    ]);
  }));

  $('#ah-black-label').textContent = black.length ? `永不自动添加（${black.length} 个）：` : '';
  fill($('#ah-black'), black.map((w) => {
    const un = el('button', { class: 'link', text: '解除' });
    un.addEventListener('click', async () => {
      renderAutoHotwords(await api.autoHotwords('unblacklist', w));
    });
    return el('span', { class: 'black-chip' }, [w, un]);
  }));
}

function renderAutoConf() {
  const c = cfg.热词自动提炼 || {};
  $('#ah-enabled').checked = c.开启 !== false;
  $('#ah-freq').value = c.频率 || 'weekly';
  $('#ah-min').value = Number.isFinite(c.阈值) ? c.阈值 : 5;
}

async function loadAutoHotwords() {
  renderAutoConf();
  renderAutoHotwords(await api.autoHotwords('list'));
}

function wireAutoHotwords() {
  $('#ah-save').addEventListener('click', async () => {
    const min = parseInt($('#ah-min').value, 10);
    const saved = await saveConfig({
      热词自动提炼: {
        开启: $('#ah-enabled').checked,
        频率: $('#ah-freq').value,
        阈值: Number.isFinite(min) ? min : 5,
      },
    }, '#ah-msg');
    if (saved) renderAutoConf();
  });
  $('#ah-run').addEventListener('click', async () => {
    say('#ah-msg', '提炼中…');
    const r = await api.autoHotwords('run');
    const n = (r && r.added && r.added.length) || 0;
    say('#ah-msg', n
      ? `加了 ${n} 个：${r.added.map((w) => w.word).join(' ')}`
      : `没有新词可加（候选 ${(r && r.candidates) || 0} 个，都没过门槛或已在表里）`);
    renderAutoHotwords(r);
    loadHotwords();
  });
  $('#ah-clear').addEventListener('click', async () => {
    const r = await api.autoHotwords('clear');
    renderAutoHotwords(r);
    loadHotwords();
    flash('已移除全部自动添加的热词');
  });
}

function wireHotwords() {
  wireAutoHotwords();
  $('#hotwords-text').addEventListener('input', renderHotwordCount);
  $('#hotwords-save').addEventListener('click', async () => {
    const text = $('#hotwords-text').value;
    const r = await api.setHotwords(text);
    if (r && r.ok) {
      say('#hotwords-msg', '已保存，立刻生效（不用重启）');
      flash('热词已保存');
    } else {
      say('#hotwords-msg', r && r.reason === 'too-long' ? `太长了，上限 ${HOTWORDS_MAX_CHARS} 字符` : '保存失败', true);
    }
  });
  $('#mine-run').addEventListener('click', async () => {
    say('#mine-msg', '统计中…');
    const r = await api.mineHotwords();
    const list = (r && r.candidates) || [];
    renderCandidates(list);
    say('#mine-msg', list.length ? `挖出 ${list.length} 个候选，默认一个都没勾` : '没挖出候选（历史太少或都已经在表里了）');
  });
  $('#mine-merge').addEventListener('click', async () => {
    const picked = [...$('#mine-list').querySelectorAll('input:checked')].map((i) => i.value);
    if (picked.length === 0) { say('#mine-msg', '一个都没勾', true); return; }
    const r = await api.mergeHotwords(picked);
    say('#mine-msg', `已并入 ${(r && r.added && r.added.length) || picked.length} 个词`);
    flash('已并入热词表');
    renderCandidates([]);
    loadHotwords();
  });
}

// ───────────────────────── 热键 ─────────────────────────

const KEY_MAP = {
  Space: 'Space', Enter: 'Return', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
  Escape: 'Escape', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
};

/** KeyboardEvent → Electron accelerator 的主键部分。认不出返回 null。 */
function mainKeyOf(e) {
  const c = e.code || '';
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (/^F\d{1,2}$/.test(c)) return c;
  return KEY_MAP[c] || null;
}

function accelFrom(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.metaKey) mods.push('Command');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  const key = mainKeyOf(e);
  if (!key) return null;
  if (mods.length === 0) return null; // 至少一个修饰键
  return [...mods, key].join('+');
}

/** 实际生效的模式。lastState 是 main 推的活状态，cfg._hotkeys 是开窗那一刻的快照。 */
const effectiveMode = () => (lastState.mode || (cfg._hotkeys || {}).mode) === 'single' ? 'single' : 'combo';

function renderHotkeyModeLine() {
  const hk = cfg._hotkeys || {};
  const single = effectiveMode() === 'single';
  const reason = lastState.reason || hk.reason;
  // 两个事实源：用户在上面选的（cfg.热键.模式）与实际跑起来的（可能被四层降级改掉）。
  // 不说清「哪一组此刻不起作用」，用户就会去调一组根本没生效的键。
  const head = reason
    ? `当前生效：${single ? '单键' : '组合键'}模式（降级原因：${reason}）`
    : `当前生效：${single ? '单键' : '组合键'}模式`;
  const tail = single
    ? '——下面「组合键」那一组此刻不起作用'
    : '——下面「单键键位」那一组此刻不起作用';
  $('#hk-mode-line').textContent = `${head}${tail}`;
}

function renderHotkeys() {
  const keys = (cfg.热键 || {});
  const hk = cfg._hotkeys || {};
  const labels = hk.singleLabels || {};
  $('#hk-single-short').textContent = labels.short || '（默认）';
  $('#hk-single-long').textContent = labels.long || '（默认）';
  $('#hk-short').value = keys.短输入 || '';
  $('#hk-long').value = keys.长录音 || '';
  // radio 勾的是「用户想要的模式」，与上面那行「实际生效的」分开显示——这正是
  // ③ 要解决的歧义：降级时两者不一致，各自都得摆出来。
  const mode = keys.模式 || 'combo';
  for (const r of $$('input[name="hk-mode"]')) r.checked = r.value === mode;
  const single = effectiveMode() === 'single';
  $('#hk-single-badge').textContent = single ? '当前生效' : '当前未生效';
  $('#hk-combo-badge').textContent = single ? '当前未生效' : '当前生效';
  renderHotkeyModeLine();
}

function wireAccelInput(sel, which, msgSel) {
  const input = $(sel);
  input.addEventListener('keydown', async (e) => {
    e.preventDefault();
    const accel = accelFrom(e);
    if (!accel) { say(msgSel, '至少一个修饰键（⌃⌘⌥⇧）加恰好一个主键', true); return; }
    say(msgSel, '注册中…');
    // main 先 unregister 旧键再 register 新键；失败会回滚并回传原因
    const r = await api.registerHotkey(which, accel);
    if (r && r.ok) {
      input.value = accel;
      await saveConfig({ 热键: { [which === 'short' ? '短输入' : '长录音']: accel } });
      say(msgSel, '已生效');
    } else {
      const why = r && r.reason === 'occupied' ? '已被其他程序占用' : `不合法（${(r && r.reason) || '未知'}）`;
      say(msgSel, why, true);
      renderHotkeys();
    }
  });
}

// ── 单键键位录制 ──
// 录制期间 main 侧的 feed() 不判定，所以按下的键不会开录音；但它**会**照常传给
// 当前前台应用（uiohook 不支持吞事件），界面提示里已经说了「按一下就好」。

const REC = {
  short: { btn: '#hk-rec-short', msg: '#hk-rec-short-msg', field: '热键.单键短输入' },
  long: { btn: '#hk-rec-long', msg: '#hk-rec-long-msg', field: '热键.单键长录音' },
};
let capturing = null; // 正在录哪一个：'short' | 'long' | null

function setRecBusy(which, busy) {
  for (const w of ['short', 'long']) {
    const b = $(REC[w].btn);
    if (!b) continue;
    // 录制中只有当前那个按钮可点（点它=取消），另一个禁掉，免得两个录制态打架
    b.disabled = busy && w !== which;
    if (w === which) b.textContent = busy ? '取消' : '录制';
    else if (!busy) b.textContent = '录制';
  }
}

async function stopCapture(which) {
  capturing = null;
  setRecBusy(which, false);
  await api.captureHotkey('cancel', which);
}

async function startCapture(which) {
  const { msg } = REC[which];
  if (capturing) await stopCapture(capturing);
  capturing = which;
  setRecBusy(which, true);
  say(msg, '请按下你想用的键…');
  const r = await api.captureHotkey('start', which);
  if (!r || r.ok === false) {
    capturing = null;
    setRecBusy(which, false);
    // main 把原因原样回来（如「无辅助功能权限」），不翻译成「失败了」那种废话
    say(msg, (r && (r.reason || r.message)) || '录制启动失败', true);
  }
}

/** 存一个录到的键位。main 侧还会再校验一遍（renderer 不可信）。 */
async function saveSingleKey(which, keycode, msgSel) {
  const field = which === 'short' ? '单键短输入' : '单键长录音';
  const saved = await saveConfig({ 热键: { [field]: keycode } }, msgSel);
  if (!saved) return;
  renderHotkeys(); // saveConfig 已经重新拉过 config，这里渲染的是落盘后的真实值
  say(msgSel, '已生效');
}

function onHotkeyCaptured(p) {
  const which = p && p.which;
  if (!which || !REC[which]) return;
  const { msg } = REC[which];
  capturing = null;
  setRecBusy(which, false);
  const label = p.label || `键码 ${p.keycode}`;
  if (p.verdict === 'ok') { saveSingleKey(which, p.keycode, msg); return; }
  if (p.verdict === 'blocked') { say(msg, p.message || `${label} 不能用`, true); return; }
  if (p.verdict === 'timeout') { say(msg, p.message || '没收到按键，已取消录制', true); return; }
  // warn：警告但允许强行设置（规则 c）。哪些键真被占用只有用户自己知道，
  // 我们没资格替他拒——所以给一个「仍然使用」按钮，点了才存。
  const node = $(msg);
  if (!node) return;
  node.textContent = '';
  node.style.color = 'var(--bad)';
  const btn = el('button', { type: 'button', class: 'link', text: '仍然使用' });
  btn.addEventListener('click', () => saveSingleKey(which, p.keycode, msg));
  node.append(document.createTextNode(`${label}：${p.message || '可能会误触发'} `), btn);
}

function wireHotkeys() {
  wireAccelInput('#hk-short', 'short', '#hk-short-msg');
  wireAccelInput('#hk-long', 'long', '#hk-long-msg');
  for (const r of $$('input[name="hk-mode"]')) {
    r.addEventListener('change', async () => {
      if (!r.checked) return;
      await saveConfig({ 热键: { 模式: r.value } });
      renderHotkeys();
    });
  }
  for (const which of ['short', 'long']) {
    $(REC[which].btn).addEventListener('click', () => {
      if (capturing === which) stopCapture(which);
      else startCapture(which);
    });
  }
  // 切走或关窗时要收尾：录制态留在 main 侧会把下一次真按键吞掉
  window.addEventListener('hashchange', () => { if (capturing) stopCapture(capturing); });
  window.addEventListener('beforeunload', () => { if (capturing) api.captureHotkey('cancel', capturing); });
  api.onHotkeyCaptured(onHotkeyCaptured);
}

// @@HOTKEYS@@

// ───────────────────── 行为与历史 ─────────────────────

function renderBehavior() {
  $('#b-history').checked = cfg.记录历史 !== false;
  $('#b-keepdays').value = Number.isFinite(cfg.历史保留天数) ? cfg.历史保留天数 : 90;
  $('#b-dir').value = cfg.转录目录 || cfg._defaultTranscriptDir || '';
  $('#b-autostart').checked = !!cfg.开机自启;
  $('#b-polish').checked = !!cfg.口语清理;
  $('#sp-never').checked = !!cfg.已提示赞助;
}

/** 历史列表：每条可选中文本 + 复制按钮 + 时长 + 模式 + 用的哪个后端。 */
function historyItem(row) {
  const copy = el('button', { class: 'link', text: '复制' });
  copy.addEventListener('click', async () => {
    await api.copyText(row.text || '');
    copy.textContent = '已复制';
    setTimeout(() => { copy.textContent = '复制'; }, 1500);
  });
  return el('div', { class: 'list-item' }, [
    el('div', { class: 'list-meta' }, [
      el('span', { text: row.t || '' }),
      el('span', { text: row.mode || '—' }),
      // dur 为 null（旧行或没记时长）显示 —，不显示 NaN 也不白屏
      el('span', { text: typeof row.dur === 'number' ? `${row.dur.toFixed(1)}s` : '—' }),
      // provider 缺失的旧行（6 字段）显示「未知」
      el('span', { text: `后端：${row.provider || '未知'}` }),
      el('span', { class: 'spacer' }),
      copy,
    ]),
    el('div', { class: 'list-text', text: String(row.text ?? '') }),
  ]);
}

async function loadHistory() {
  const rows = await api.listHistory(200);
  const box = $('#history-list');
  if (!Array.isArray(rows) || rows.length === 0) {
    fill(box, [el('p', { class: 'hint', text: '还没有历史记录。' })]);
    return;
  }
  fill(box, rows.map(historyItem));
}

function wireBehavior() {
  $('#b-dir-pick').addEventListener('click', async () => {
    const r = await api.pickTranscriptDir('transcript');
    if (!r || r.canceled) return;
    if (r.ok === false) { say('#b-msg', r.reason || '这个目录不能用', true); return; }
    $('#b-dir').value = r.path;
    say('#b-msg', '选好了，记得点保存');
  });
  $('#b-dir-open').addEventListener('click', () => api.openPath($('#b-dir').value));
  $('#b-open-data').addEventListener('click', () => api.openDataDir());
  $('#b-save').addEventListener('click', async () => {
    const days = parseInt($('#b-keepdays').value, 10);
    const saved = await saveConfig({
      记录历史: $('#b-history').checked,
      历史保留天数: Number.isFinite(days) ? days : 90,
      转录目录: $('#b-dir').value.trim(),
      开机自启: $('#b-autostart').checked,
      口语清理: $('#b-polish').checked,
    }, '#b-msg');
    if (saved) renderBehavior();
  });
}

// ───────────────────────── 导入 ─────────────────────────

const Q_LABEL = { queued: '排队', decoding: '解码中', transcribing: '转写中', done: '完成', failed: '失败' };

function queueItem(job) {
  const meta = [
    el('span', { class: `q-status ${job.status}`, text: Q_LABEL[job.status] || job.status }),
    el('span', { text: job.detail || '' }),
  ];
  if (job.note) meta.push(el('span', { text: job.note }));
  if (job.status === 'done' && job.mdPath) {
    const open = el('button', { class: 'link', text: '打开 Markdown' });
    open.addEventListener('click', () => api.openPath(job.mdPath));
    meta.push(el('span', { class: 'spacer' }), open);
  }
  return el('div', { class: 'list-item' }, [
    el('div', { text: job.name }),
    el('div', { class: 'list-meta' }, meta),
  ]);
}

function renderQueue(list) {
  const box = $('#imp-queue');
  if (!list || list.length === 0) {
    fill(box, [el('p', { class: 'hint', text: '队列是空的。' })]);
    return;
  }
  fill(box, [...list].reverse().map(queueItem));
}

function renderWatch() {
  const w = cfg.watch || {};
  $('#w-enabled').checked = !!w.enabled;
  $('#w-dir').value = w.dir || '';
  $('#w-interval').value = Number.isFinite(w.intervalSec) ? w.intervalSec : 5;
}

function wireImport() {
  $('#imp-pick').addEventListener('click', async () => {
    // 空数组 = 「让 main 弹文件选择器」。文件对话框与 fs 都归 main，
    // renderer 碰不到路径以外的任何东西（§3.2）。
    const r = await api.importFiles([]);
    if (r && r.canceled) { say('#imp-msg', ''); return; }
    say('#imp-msg', r && r.ok ? `已加入 ${r.added} 个文件` : '加入队列失败', !(r && r.ok));
  });

  // 窗口整体接受拖拽。renderer 只取**路径**回传 main，不读文件内容。
  const zone = $('#drop-zone');
  window.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragging'); });
  window.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('dragging');
    // pathForFile 走 webUtils.getPathForFile；filter(Boolean) 是兜底——
    // 宁可少导一个文件，也不要把 undefined 传进 main 的 fs 调用
    const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length === 0) { say('#imp-msg', '没取到文件路径', true); return; }
    location.hash = '#import';
    const r = await api.importFiles(paths);
    say('#imp-msg', r && r.ok ? `已加入 ${r.added} 个文件` : '加入队列失败');
  });

  $('#w-dir-pick').addEventListener('click', async () => {
    const r = await api.pickTranscriptDir('watch');
    if (!r || r.canceled) return;
    if (r.ok === false) { say('#w-msg', r.reason || '这个目录不能用', true); return; }
    $('#w-dir').value = r.path;
    say('#w-msg', '选好了，记得点保存');
  });
  $('#w-save').addEventListener('click', async () => {
    const sec = parseInt($('#w-interval').value, 10);
    const saved = await saveConfig({
      watch: {
        enabled: $('#w-enabled').checked,
        dir: $('#w-dir').value.trim(),
        intervalSec: Number.isFinite(sec) ? sec : 5,
      },
    }, '#w-msg');
    if (saved) renderWatch();
  });
}

// @@IMPORT@@

// ───────────────────────── 赞助 ─────────────────────────

/** 缺图时显示降级文案 + 仓库外链，**不报错、不留白**（§25.2）。 */
async function loadSponsor() {
  const s = await api.getSponsor();
  $('#sp-text').textContent = (s && s.text) || '';
  const img = $('#sp-img');
  if (s && s.has && s.dataUrl) {
    img.src = s.dataUrl;
    img.hidden = false;
  } else {
    img.removeAttribute('src');
    img.hidden = true;
  }
  const link = $('#sp-repo');
  if (s && s.repo) {
    link.href = s.repo;
    link.hidden = false;
  } else {
    link.hidden = true;
  }
}

function wireSponsor() {
  $('#sp-never').addEventListener('change', async () => {
    // 「不再提示」和「已经提示过」是同一个标志：置上就永不再提（§25.1）
    await saveConfig({ 已提示赞助: $('#sp-never').checked });
  });
}

// ───────────────────────── 启动 ─────────────────────────

/** 外链一律交给系统浏览器开，不在这个窗口里导航（CSP 也挡着）。 */
function wireExternalLinks() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a.ext');
    if (!a) return;
    e.preventDefault();
    // 这些链接全是 HTML 里写死的常量，不是外部数据
    window.open(a.getAttribute('href'), '_blank');
  });
}

async function boot() {
  cfg = await api.getConfig();
  if (cfg._platform !== 'darwin') for (const n of $$('.mac-only')) n.hidden = true;
  $('#imp-exts').textContent = 'wav / mp3 / m4a / mp4 / webm / ogg / opus / flac / aac / amr';

  wireTabs();
  wireExternalLinks();
  wireBackends();
  wireHotwords();
  wireHotkeys();
  wireBehavior();
  wireImport();
  wireSponsor();

  renderPolish();
  renderBehavior();
  renderWatch();
  renderHotkeys();
  api.onState(renderStatus);
  applyHash();
}

boot().catch((e) => {
  // 这个窗口有 devtools 可看，但启动就挂的话界面是全白的，必须在页面上说一句
  document.body.prepend(el('p', { class: 'warn', text: `设置界面初始化失败：${(e && e.message) || e}` }));
});
