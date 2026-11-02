'use strict';
// 文件夹监听（design.md §24.3）。
//
// **用轮询，不用 fs.watch**。三个具体理由，都踩过：
// ① fs.watch 在网络盘、SD 卡和部分 Windows 驱动上不触发或重复触发；
// ② 它在文件**开始写入**时就报事件，此时拿到的是半截文件；
// ③ 事实源的 Python 版（监听文件夹.py）就是轮询 + 大小稳定判定，照抄。
//
// 「写完了」的判据只有一条：**连续两轮 size 相同**。第一次见到的文件一律等下一轮。
//
// 指纹 = 文件名 + size + mtime 的 sha1，记在 <userData>/导入已完成.jsonl。
// 不用绝对路径做键，两个原因：转完文件会被挪进 已完成/，路径会变；而
// 「同一个文件又被拖回来」应当被识别成已处理过。
//
// 加载期不碰 electron（评审 M8）。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const paths = require('./paths');
const { isSupported, extOf } = require('./importer');

const MOD = 'watcher';

const DEFAULT_INTERVAL_SEC = 5;
const MIN_INTERVAL_SEC = 2;
const MAX_INTERVAL_SEC = 300;
const DONE_DIR = '已完成';

/** 指纹：文件名 + size + mtime（毫秒取整）的 sha1。 */
function fingerprint(name, size, mtimeMs) {
  return crypto.createHash('sha1').update(`${name}|${size}|${Math.round(mtimeMs || 0)}`).digest('hex');
}

/**
 * 监听目录校验（§16）。
 * **禁止等于或包含转录目录**：否则自己的归档音频会被当成新输入，转一遍又产一份，
 * 循环下去。保存时就拒绝，不要等运行时才发现。
 * @returns {{ok:boolean, reason?:string}}
 */
function validate({ dir, transcriptDir } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') return { ok: false, reason: '监听目录不能为空' };
  if (!path.isAbsolute(dir)) return { ok: false, reason: '监听目录必须是绝对路径' };
  if (transcriptDir) {
    const a = path.resolve(dir);
    const b = path.resolve(transcriptDir);
    if (a === b) return { ok: false, reason: '监听目录不能就是转录目录（自己的产物会被当新输入，无限循环）' };
    if (b.startsWith(a + path.sep)) {
      return { ok: false, reason: '监听目录不能包含转录目录（自己的产物会被当新输入，无限循环）' };
    }
  }
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    return { ok: false, reason: '监听目录不存在' };
  }
  if (!st.isDirectory()) return { ok: false, reason: '这不是一个目录' };
  try {
    fs.accessSync(dir, fs.constants.R_OK);
  } catch {
    return { ok: false, reason: '监听目录不可读' };
  }
  return { ok: true };
}

/** 轮询间隔收进 2–300 秒，非法值回退默认 5（§16）。 */
const clampInterval = (sec) =>
  Number.isInteger(sec) && sec >= MIN_INTERVAL_SEC && sec <= MAX_INTERVAL_SEC ? sec : DEFAULT_INTERVAL_SEC;

/**
 * 扫一轮目录。不递归、跳过 已完成/。
 * 目录消失 → {gone:true}（调用方据此停止监听并关掉开关，不静默空转，§15-40）。
 * 非音频文件**跳过且不移动**（别动用户的文件），只记一条 debug。
 */
function scan(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { gone: true, entries: [] };
    logger.warn(MOD, `读目录失败：${(e && e.code) || ''} ${(e && e.message) || e}`);
    return { gone: false, error: (e && e.message) || String(e), entries: [] };
  }
  const entries = [];
  for (const name of names) {
    if (name === DONE_DIR || name.startsWith('.')) continue;
    let st;
    try {
      st = fs.statSync(path.join(dir, name));
    } catch {
      continue; // 刚被挪走
    }
    if (!st.isFile()) continue;
    if (!isSupported(name)) {
      logger.debug(MOD, `跳过非音频文件 ${name}（${extOf(name) || '无扩展名'}）`);
      continue;
    }
    entries.push({ name, size: st.size, mtimeMs: st.mtimeMs });
  }
  return { gone: false, entries };
}

/** 轮询状态。done 是已处理指纹集合（从 jsonl 读回），queued 防同一轮内重复入队。 */
function createState(done = []) {
  return { sizes: new Map(), done: new Set(done), queued: new Set() };
}

/**
 * 喂一轮扫描结果，返回这一轮该入队的文件。纯函数（不碰 fs），这是本模块可测的核心。
 * 判据：上一轮见过**且 size 相同** → 写完了；size 变了 → 等下一轮；指纹已处理 → 跳过。
 * @returns {{name:string,size:number,mtimeMs:number,fingerprint:string}[]}
 */
function feed(state, entries = []) {
  const ready = [];
  const seen = new Set();
  for (const e of entries) {
    seen.add(e.name);
    const prev = state.sizes.get(e.name);
    state.sizes.set(e.name, e.size);
    if (prev === undefined) continue; // 第一次见，等下一轮确认写完
    if (prev !== e.size) continue; // 还在写
    const fp = fingerprint(e.name, e.size, e.mtimeMs);
    if (state.done.has(fp)) continue; // 处理过了（文件被拖回来也认得出）
    if (state.queued.has(fp)) continue;
    state.queued.add(fp);
    ready.push({ ...e, fingerprint: fp });
  }
  // 消失的文件忘掉，否则同名新文件会被当成「上一轮见过」而少等一轮
  for (const name of [...state.sizes.keys()]) if (!seen.has(name)) state.sizes.delete(name);
  return ready;
}

/** 读回已处理指纹。坏行跳过——一行坏 JSON 不该让监听整个失效。 */
function loadDone() {
  try {
    return fs
      .readFileSync(paths.importDonePath(), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l).fp;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendDone(fp, name) {
  try {
    fs.mkdirSync(paths.dataDir(), { recursive: true });
    fs.appendFileSync(paths.importDonePath(), `${JSON.stringify({ fp, name, t: new Date().toISOString() })}\n`, 'utf8');
    return true;
  } catch (e) {
    logger.warn(MOD, `写 导入已完成.jsonl 失败：${e && e.message}`);
    return false;
  }
}

/**
 * 转完挪进 <监听目录>/已完成/（原文件保留，移动在这里是去重手段）。
 * 同名加 -1 / -2，**不覆盖**。跨设备 rename 会 EXDEV，退回复制再删。
 * @returns {string|null} 新路径；失败返回 null（失败不影响已拿到的转录结果）
 */
function moveToDone(dir, name) {
  const doneDir = path.join(dir, DONE_DIR);
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  try {
    fs.mkdirSync(doneDir, { recursive: true });
    let dest = path.join(doneDir, name);
    for (let i = 1; fs.existsSync(dest) && i < 1000; i += 1) dest = path.join(doneDir, `${base}-${i}${ext}`);
    const src = path.join(dir, name);
    try {
      fs.renameSync(src, dest);
    } catch (e) {
      if (!e || e.code !== 'EXDEV') throw e;
      fs.copyFileSync(src, dest);
      fs.rmSync(src, { force: true });
    }
    return dest;
  } catch (e) {
    logger.warn(MOD, `挪进 ${DONE_DIR}/ 失败（${name}）：${e && e.message}`);
    return null;
  }
}

/**
 * 监听器。
 * deps：{ enqueue(paths, opts) → void, transcriptDir() → string, notify(msg), onStopped(reason), log }
 */
function create(deps) {
  const log = deps.log || logger;
  let timer = null;
  let dir = '';
  let intervalSec = DEFAULT_INTERVAL_SEC;
  let state = createState();

  function stop(reason) {
    if (timer) clearInterval(timer);
    timer = null;
    if (reason) {
      log.warn(MOD, `停止监听：${reason}`);
      if (deps.onStopped) deps.onStopped(reason);
    }
    return true;
  }

  function tick() {
    if (!dir) return { gone: false, enqueued: 0 };
    const r = scan(dir);
    if (r.gone) {
      stop('监听目录已消失');
      if (deps.notify) deps.notify('监听目录不见了，已自动关闭文件夹监听');
      return { gone: true, enqueued: 0 };
    }
    const ready = feed(state, r.entries);
    for (const f of ready) {
      log.info(MOD, `发现新音频 ${f.name}（${f.size} 字节），入队`);
      deps.enqueue([path.join(dir, f.name)], {
        onFinished: () => {
          appendDone(f.fingerprint, f.name);
          state.done.add(f.fingerprint);
          state.queued.delete(f.fingerprint);
          moveToDone(dir, f.name);
        },
      });
    }
    return { gone: false, enqueued: ready.length };
  }

  return {
    /** 按配置启动/重启。校验不过就不启动并回原因。 */
    start(cfg = {}) {
      stop();
      const watch = cfg.watch || {};
      if (!watch.enabled) return { ok: false, reason: 'disabled' };
      const v = validate({ dir: watch.dir, transcriptDir: deps.transcriptDir() });
      if (!v.ok) {
        log.warn(MOD, `不启动监听：${v.reason}`);
        return v;
      }
      dir = watch.dir;
      intervalSec = clampInterval(watch.intervalSec);
      state = createState(loadDone());
      timer = setInterval(() => {
        try {
          tick();
        } catch (e) {
          log.error(MOD, `轮询抛错：${e && e.message}`);
        }
      }, intervalSec * 1000);
      log.info(MOD, `开始监听 ${dir}，每 ${intervalSec} 秒一轮`);
      return { ok: true, dir, intervalSec };
    },
    stop: () => stop(),
    tick,
    get running() {
      return Boolean(timer);
    },
    get dir() {
      return dir;
    },
  };
}

module.exports = {
  DEFAULT_INTERVAL_SEC,
  MIN_INTERVAL_SEC,
  MAX_INTERVAL_SEC,
  DONE_DIR,
  fingerprint,
  validate,
  clampInterval,
  scan,
  createState,
  feed,
  loadDone,
  appendDone,
  moveToDone,
  create,
};
