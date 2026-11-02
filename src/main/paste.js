'use strict';
// 剪贴板 + 模拟粘贴（design.md §8）。对外只有 deliver(text)。
//
// 不变量 3：**剪贴板写入先于、且独立于粘贴，且一定执行**。粘贴是 best-effort。
// 故意**不恢复用户原来的剪贴板**——这是用户明确提过的硬需求：光标没点对时
// 能手动再粘一次。代价是覆盖了之前复制的内容，README 写明。
//
// macOS 失败判据按**错误号**分流，不匹配 stderr 的英文子串（评审 M4）：
// 实际消息是 `… is not allowed to send keystrokes. (-1719)`，不含 assistive
// 这个词，而且随系统语言本地化——目标用户正是中文系统，英文匹配直接失效。
//   -1743 → 自动化（Apple Event 的 TCC 类别），面板 Privacy_Automation
//   -1719 / 辅助功能查询 false → 辅助功能，面板 Privacy_Accessibility
// 两者是**不同 TCC 类别、不同面板**：在「自动化」里点过拒绝后系统不再弹窗，
// 送错面板用户无法自行恢复。-25211 查不到 keystroke 权限语义，不要。
//
// Windows 侧的四条（评审 H2）见下面的常量与 ensureHost()。
// 加载期不碰 electron。
const logger = require('./logger');
const hotkeysMod = require('./hotkeys');

const MOD = 'paste';

// H2 ①：原 500ms 小于同节自述的冷启动 600ms~1.5s，会让 Windows 每次都降级成
// 只写剪贴板而托盘表面「能用」。取 5000ms，且判死还要求子进程已退出。
const READY_TIMEOUT_MS = 5000;
// H2 ②：每次粘贴的 OK 回执超时（原 300ms）。
const ACK_TIMEOUT_MS = 1000;
// H2 ④：启动超时连续几次才降级为只写剪贴板。
const MAX_HOST_FAILURES = 2;

const PANELS = {
  'permission-automation': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  'permission-accessibility': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};

/**
 * osascript 失败分类（纯函数，便于单测）。
 * 返回 null 表示没失败。
 */
function classifyOsascriptFailure({ code, stderr, trusted } = {}) {
  const text = typeof stderr === 'string' ? stderr : '';
  if (/-1743/.test(text)) return 'permission-automation';
  if (/-1719/.test(text)) return 'permission-accessibility';
  if (trusted === false) return 'permission-accessibility';
  if (code !== 0) return 'unknown';
  return null;
}

/** 分类 → 系统设置面板 URL。 */
const panelFor = (kind) => PANELS[kind] || null;

// ───────────────────────── Windows 常驻宿主 ─────────────────────────

const WIN_PRELUDE = 'Add-Type -AssemblyName System.Windows.Forms; [Console]::Out.Write("READY`n")\n';
const WIN_PASTE = "[System.Windows.Forms.SendKeys]::SendWait('^v'); [Console]::Out.Write(\"OK`n\")\n";

function createWinHost({ spawnImpl, now = Date.now } = {}) {
  let proc = null;
  let ready = null; // Promise<boolean>
  let failures = 0;
  let degraded = false;

  const spawn = () => {
    const impl = spawnImpl || require('child_process').spawn;
    return impl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  };

  /** 读一行以 token 开头的 stdout，超时返回 null。 */
  function waitFor(token, ms) {
    return new Promise((resolve) => {
      let buf = '';
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (proc && proc.stdout) proc.stdout.off('data', onData);
        resolve(v);
      };
      const onData = (d) => {
        buf += String(d);
        if (buf.includes(token)) finish(true);
      };
      const timer = setTimeout(() => finish(null), ms);
      if (!proc || !proc.stdout) return finish(null);
      proc.stdout.on('data', onData);
    });
  }

  /** H2 ③：由 main 在 app.whenReady() 之后异步调，不等第一次粘贴才拉起。 */
  async function ensureHost() {
    if (degraded) return false;
    if (proc && ready) return ready;
    try {
      proc = spawn();
    } catch (e) {
      logger.error(MOD, `PowerShell 宿主拉起抛错：${e && e.message}`);
      proc = null;
      return false;
    }
    let exited = false;
    proc.on('exit', (code) => {
      exited = true;
      logger.warn(MOD, `PowerShell 宿主退出（code=${code}），下次粘贴重新拉起`);
      proc = null;
      ready = null;
    });
    if (proc.stderr) proc.stderr.on('data', (d) => logger.warn(MOD, `宿主 stderr：${String(d).slice(0, 200)}`));

    ready = (async () => {
      const t0 = now();
      try {
        proc.stdin.write(WIN_PRELUDE);
      } catch (e) {
        logger.error(MOD, `写宿主 stdin 失败：${e && e.message}`);
        return false;
      }
      const got = await waitFor('READY', READY_TIMEOUT_MS);
      if (got) {
        failures = 0;
        logger.info(MOD, `PowerShell 宿主就绪（${now() - t0}ms）`);
        return true;
      }
      // H2 ①：只有「超时**且**子进程已退出」才判死。进程还活着就只是慢，
      // 不算宿主起不来——这正是原 500ms 让 Windows 每次都降级的原因。
      if (!exited) {
        logger.warn(MOD, `宿主握手超时 ${READY_TIMEOUT_MS}ms 但进程仍存活，继续按可用处理`);
        return true;
      }
      failures += 1;
      logger.error(MOD, `宿主启动失败（host-timeout，第 ${failures} 次）`);
      if (failures >= MAX_HOST_FAILURES) {
        degraded = true;
        logger.error(MOD, '连续 2 次启动失败，降级为只写剪贴板');
      }
      return false;
    })();
    return ready;
  }

  /** 发一次粘贴。返回 {pasted, reason?}。 */
  async function sendPaste() {
    const ok = await ensureHost();
    if (!ok) return { pasted: false, reason: 'host-timeout' };
    try {
      proc.stdin.write(WIN_PASTE);
    } catch (e) {
      logger.error(MOD, `宿主写入失败（exec-failed）：${e && e.message}`);
      return { pasted: false, reason: 'exec-failed' };
    }
    const acked = await waitFor('OK', ACK_TIMEOUT_MS);
    if (!acked) {
      // 宿主活着但命令没执行：-Command - 在部分版本下读到 EOF 才执行，
      // 受限语言模式下 Add-Type 也会失败而进程不退出。
      logger.warn(MOD, `${ACK_TIMEOUT_MS}ms 内没收到 OK 回执（no-ack）`);
      return { pasted: false, reason: 'no-ack' };
    }
    return { pasted: true };
  }

  const kill = () => {
    if (proc) {
      try { proc.kill(); } catch { /* 已经没了 */ }
      proc = null;
      ready = null;
    }
  };

  return { ensureHost, sendPaste, kill, get degraded() { return degraded; } };
}

// ───────────────────────── macOS ─────────────────────────

const OSA_ARGS = ['-e', 'tell application "System Events" to keystroke "v" using command down'];

/** 每次粘贴单次 spawn。实测延迟量级 80~150ms，可接受。 */
function macPaste({ spawnImpl } = {}) {
  return new Promise((resolve) => {
    const impl = spawnImpl || require('child_process').spawn;
    let p;
    try {
      p = impl('osascript', OSA_ARGS);
    } catch (e) {
      resolve({ code: -1, stderr: String((e && e.message) || e) });
      return;
    }
    let stderr = '';
    if (p.stderr) p.stderr.on('data', (d) => { stderr += String(d); });
    p.on('error', (e) => resolve({ code: -1, stderr: String(e && e.message) }));
    p.on('exit', (code) => resolve({ code, stderr }));
  });
}

// ───────────────────────── 对外 ─────────────────────────

let winHost = null;
let firstPermFailure = true;

/** H2 ③：main 在 whenReady 之后调这个预热，不等第一次粘贴。 */
function prewarm() {
  if (process.platform !== 'win32') return Promise.resolve(true);
  if (!winHost) winHost = createWinHost();
  return winHost.ensureHost().catch((e) => {
    logger.warn(MOD, `预热宿主失败：${e && e.message}`);
    return false;
  });
}

/** app.on('will-quit') 里调。 */
function shutdown() {
  if (winHost) winHost.kill();
  winHost = null;
}

/**
 * 写剪贴板 + 尽力模拟粘贴。
 * 返回 {clipboard:true, pasted:boolean, reason?}。pasted:false 不算失败，
 * 只影响托盘提示语（📋 已复制，请手动粘贴）。
 */
async function deliver(text, { controller, onPermission, spawnImpl } = {}) {
  // eslint-disable-next-line global-require
  const { clipboard, BrowserWindow } = require('electron');

  // ① 剪贴板先写、且一定执行（不变量 3）
  clipboard.writeText(text);

  // 焦点在本应用窗口上时只写剪贴板，不然会粘到设置界面里（§8.4）
  let focusedOwn = false;
  try {
    focusedOwn = !!BrowserWindow.getFocusedWindow();
  } catch { /* 没有窗口 */ }
  if (focusedOwn) {
    logger.info(MOD, '焦点在本应用窗口上，只写剪贴板不发按键');
    return { clipboard: true, pasted: false, reason: 'own-window' };
  }

  // ② 发按键前抑制自己的键盘钩子，防自激（§5.1）
  if (controller && typeof controller.suppress === 'function') controller.suppress(hotkeysMod.SUPPRESS_MS);

  if (process.platform === 'darwin') {
    const { code, stderr } = await macPaste({ spawnImpl });
    const kind = classifyOsascriptFailure({
      code,
      stderr,
      trusted: hotkeysMod.accessibilityTrusted(),
    });
    if (!kind) return { clipboard: true, pasted: true };
    const level = firstPermFailure ? 'error' : 'warn';
    firstPermFailure = false;
    logger[level](MOD, `模拟粘贴失败：${kind}（code=${code}）`);
    if (onPermission && panelFor(kind)) onPermission(kind, panelFor(kind));
    return { clipboard: true, pasted: false, reason: kind };
  }

  if (process.platform === 'win32') {
    if (!winHost) winHost = createWinHost();
    const r = await winHost.sendPaste();
    if (!r.pasted) logger.warn(MOD, `模拟粘贴失败：${r.reason}`);
    return { clipboard: true, ...r };
  }

  logger.warn(MOD, `平台 ${process.platform} 不支持模拟粘贴，只写剪贴板`);
  return { clipboard: true, pasted: false, reason: 'unsupported-platform' };
}

module.exports = {
  READY_TIMEOUT_MS,
  ACK_TIMEOUT_MS,
  MAX_HOST_FAILURES,
  PANELS,
  OSA_ARGS,
  classifyOsascriptFailure,
  panelFor,
  createWinHost,
  macPaste,
  prewarm,
  shutdown,
  deliver,
};
