'use strict';
// 托盘与状态呈现（design.md §14）。
//
// 七个状态，一个不少：
//   🎤 待机 / 🔴 m:ss 录音中（每秒刷新）/ ⏳ 转写中 / ✅ 已存文件 /
//   📋 已复制（pasted:false，tooltip「已复制，请手动粘贴」）/ ⚠ 失败或缺权限 /
//   🚫 麦克风不可用（持续显示直到恢复）
// 📋 与 ✅ 必须区分：短输入的成功标志是「进了剪贴板/光标」，长录音是「落了文件」。
// 🚫 与 ⚠ 必须区分：麦克风不可用是持续状态，其他错误是瞬时的。
//
// **Tray.setTitle() 是 macOS 专属**，Windows 托盘没有文字位，只能靠 7 个图标
// 切换 + setToolTip（图标由 FEAT-005 生成，缺图时降级到默认图标 + 记 warn）。
//
// 提示统一走 Notification + 托盘，**不弹模态框**——语音输入插在别的工作流中间
// 用，模态框会抢焦点、把光标位置搞丢。只有缺权限/缺 key 才打开设置窗。
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const paths = require('./paths');

const MOD = 'tray';

const TRANSIENT_MS = 3000; // ✅ / 📋 显示多久回待机
const LAST_PREVIEW_CHARS = 46;
const RECENT_COUNT = 6;

/** 状态 → macOS 标题 / Windows 图标名 / tooltip。 */
const STATES = {
  idle: { title: '🎤', icon: 'tray-idle', tip: '语音输入 · 待机' },
  recording: { title: '🔴', icon: 'tray-rec', tip: '录音中' },
  busy: { title: '⏳', icon: 'tray-busy', tip: '转写中' },
  ok: { title: '✅', icon: 'tray-ok', tip: '已存文件' },
  copied: { title: '📋', icon: 'tray-copied', tip: '已复制，请手动粘贴' },
  warn: { title: '⚠', icon: 'tray-warn', tip: '出错了' },
  nomic: { title: '🚫', icon: 'tray-nomic', tip: '麦克风不可用' },
};

/** 录音秒数 → m:ss。 */
function mmss(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 托盘图标文件路径；缺图返回 null（调用方降级到默认图标）。 */
function iconPath(name, size = 16) {
  const p = path.join(paths.appRoot(), 'assets', 'tray', `${name}@${size}.png`);
  return fs.existsSync(p) ? p : null;
}

/** 「上次」菜单项的文案。 */
const preview = (text) => {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (t === '') return '上次：（还没说过话）';
  return t.length <= LAST_PREVIEW_CHARS ? `上次：${t}` : `上次：${t.slice(0, LAST_PREVIEW_CHARS)}…`;
};

/**
 * 创建托盘。deps 全注入，便于以后替换。
 * deps: {hotkeys, asr, pending, history, config, onImport, onSettings,
 *        onOpenTranscriptDir, onOpenDataDir, onSponsor, onQuit, onResetProviders,
 *        onRetryPending, copyText, notify}
 */
function create(deps) {
  // eslint-disable-next-line global-require
  const { Tray, Menu, nativeImage } = require('electron');

  let tray = null;
  let state = 'idle';
  let micBlocked = false;
  let transientTimer = null;
  let secondTimer = null;
  let lastText = '';
  let switchNote = ''; // 「Groq（百炼 429，4 分钟后重试）」
  let notifiedSwitchThisSession = false;

  function makeImage(name) {
    const p16 = iconPath(name, 16);
    if (!p16) {
      logger.warn(MOD, `托盘图标缺失，降级到默认：assets/tray/${name}@16.png`);
      return nativeImage.createEmpty();
    }
    const img = nativeImage.createFromPath(p16);
    const p32 = iconPath(name, 32);
    if (p32) img.addRepresentation({ scaleFactor: 2, dataURL: undefined, buffer: fs.readFileSync(p32) });
    return img;
  }

  function paint(extraTitle) {
    if (!tray) return;
    const s = STATES[state] || STATES.idle;
    if (process.platform === 'darwin') {
      tray.setTitle(extraTitle ? `${s.title} ${extraTitle}` : s.title);
    } else {
      try {
        tray.setImage(makeImage(s.icon));
      } catch (e) {
        logger.warn(MOD, `setImage 失败：${e && e.message}`);
      }
    }
    tray.setToolTip(extraTitle ? `${s.tip} ${extraTitle}` : s.tip);
  }

  function set(next, { extraTitle, transient = false } = {}) {
    if (transientTimer) { clearTimeout(transientTimer); transientTimer = null; }
    // 麦克风不可用是持续状态，除非显式恢复，不被瞬时状态顶掉
    if (micBlocked && next !== 'nomic' && next !== 'recording') return;
    state = next;
    paint(extraTitle);
    if (transient) {
      transientTimer = setTimeout(() => {
        state = micBlocked ? 'nomic' : 'idle';
        paint();
      }, TRANSIENT_MS);
    }
  }

  function buildMenu() {
    const keys = deps.hotkeys ? deps.hotkeys.describe() : { short: '—', long: '—' };
    const mode = deps.hotkeys ? deps.hotkeys.mode : 'combo';
    const reason = deps.hotkeys ? deps.hotkeys.reason : '';
    const pendingCount = deps.pending ? deps.pending.count() : 0;
    const recent = deps.history ? deps.history.listRecent(RECENT_COUNT) : [];
    const cooling = deps.asr ? deps.asr.cooling() : [];

    const items = [
      { label: `短输入：${keys.short}`, enabled: false },
      { label: `长录音：${keys.long}`, enabled: false },
      {
        label: `热键模式：${mode === 'single' ? '单键' : '组合键'}${reason ? `（${reason}）` : ''}`,
        submenu: [
          { label: '单键', type: 'radio', checked: mode === 'single', click: () => deps.hotkeys.switchMode('single') },
          { label: '组合键', type: 'radio', checked: mode === 'combo', click: () => deps.hotkeys.switchMode('combo') },
        ],
      },
      { type: 'separator' },
      { label: `当前后端：${switchNote || (deps.asr ? deps.asr.currentLabel() : '—')}`, enabled: false },
    ];
    if (cooling.length > 0) {
      items.push({ label: '重置后端状态', click: () => deps.onResetProviders() });
    }
    items.push({ type: 'separator' });
    items.push({ label: preview(lastText), enabled: lastText !== '', click: () => deps.copyText(lastText) });
    items.push({
      label: '最近说过的（点击复制）',
      enabled: recent.length > 0,
      submenu: recent.map((r) => ({
        label: preview(r.text).replace(/^上次：/, ''),
        click: () => deps.copyText(r.text),
      })),
    });
    if (pendingCount > 0) {
      items.push({ label: `⏳ ${pendingCount} 条待补转（点击立即重试）`, click: () => deps.onRetryPending() });
    }
    items.push({ type: 'separator' });
    items.push({ label: '导入音频文件…', click: () => deps.onImport() });
    items.push({ label: '设置…', click: () => deps.onSettings() });
    items.push({ label: '打开转录文件夹', click: () => deps.onOpenTranscriptDir() });
    items.push({ label: '打开数据文件夹', click: () => deps.onOpenDataDir() });
    items.push({ type: 'separator' });
    items.push({ label: '赞助作者 ❤', click: () => deps.onSponsor() });
    items.push({ label: '退出', click: () => deps.onQuit() });
    return Menu.buildFromTemplate(items);
  }

  const refreshMenu = () => { if (tray) tray.setContextMenu(buildMenu()); };

  function init() {
    tray = new Tray(process.platform === 'darwin' ? nativeImage.createEmpty() : makeImage('tray-idle'));
    paint();
    refreshMenu();
    logger.info(MOD, '托盘已装载');
    return tray;
  }

  return {
    init,
    refreshMenu,
    get state() { return state; },
    /** 录音中：每秒刷新 🔴 m:ss。elapsed 由 session.elapsedSec() 提供。 */
    startRecording(elapsedSec) {
      micBlocked = false;
      set('recording', { extraTitle: mmss(elapsedSec()) });
      if (secondTimer) clearInterval(secondTimer);
      secondTimer = setInterval(() => {
        if (state === 'recording') paint(mmss(elapsedSec()));
      }, 1000);
    },
    stopRecording() {
      if (secondTimer) { clearInterval(secondTimer); secondTimer = null; }
    },
    busy: () => set('busy'),
    ok: () => { set('ok', { transient: true }); refreshMenu(); },
    copied: () => { set('copied', { transient: true }); refreshMenu(); },
    warn(msg) {
      set('warn', { transient: true });
      if (msg && deps.notify) deps.notify(msg);
    },
    silent: () => { if (deps.notify) deps.notify('没听到声音'); set('idle'); },
    idle: () => set('idle'),
    /** 麦克风不可用：持续显示直到 micOk()。 */
    noMic(msg) {
      micBlocked = true;
      state = 'nomic';
      paint();
      if (msg && deps.notify) deps.notify(msg);
    },
    micOk() {
      micBlocked = false;
      set('idle');
    },
    /** 记一次成功文本，供「上次」与「最近说过的」用。 */
    setLast(text) {
      lastText = text || '';
      refreshMenu();
    },
    /**
     * 后端切换对用户可见（不变量 14）：日志写 from/to/kind，托盘走 ⚠→✅ 两段，
     * 菜单显示原因，**本次会话第一次切换**才弹一条系统通知。
     */
    providerSwitched({ from, to, kind, note }) {
      logger.warn(MOD, `后端切换 ${from} → ${to}（${kind}）`);
      switchNote = note || `${to}（${from} ${kind}）`;
      set('warn');
      setTimeout(() => set('ok', { transient: true }), 600);
      refreshMenu();
      if (!notifiedSwitchThisSession && deps.notify) {
        notifiedSwitchThisSession = true;
        deps.notify(`已自动切换到 ${to}（${from} ${kind}）`);
      }
    },
    destroy() {
      if (secondTimer) clearInterval(secondTimer);
      if (transientTimer) clearTimeout(transientTimer);
      if (tray) tray.destroy();
      tray = null;
    },
  };
}

module.exports = { create, STATES, mmss, preview, iconPath, TRANSIENT_MS, LAST_PREVIEW_CHARS, RECENT_COUNT };
