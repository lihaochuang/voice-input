'use strict';
// 导入已有音频（design.md §24.1 / §24.2，评审 H3 的落点）。
//
// 头号使用场景是**一场 1 小时的面试录音**，所以这里的每个上限都是按它定的，
// 不是随手写的保险数：
//   IMPORT_MAX_BYTES = 500MB  §16 原写 2GB。2GB 的 m4a 解码出来是十几 GB 的
//                             PCM，renderer 必死，而「死」的表现是任务静默消失。
//   DECODE_MAX_BYTES = 150MB  超过就不解码了，直接把原文件交给后端（独立文案）。
//                             decodeAudioData 没有流式接口，整份 AudioBuffer 要
//                             一次性放进 renderer 内存，这是唯一能设的闸。
//
// **本模块不碰 electron，也不自己做 IPC**：解码的传输（MessageChannelMain +
// 分块回传）由 main.js 注入成 deps.decodeFile，所以整个队列状态机能在裸 Node
// 里测（context.json 的 test_framework 约束）。
//
// 队列**串行、一次一个文件**：并发会把 provider 的 RPM 打满，而且进度无法向
// 用户表达。不持久化，关应用即丢——未完成的文件还在原处，重新拖一次即可。

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const paths = require('./paths');
const wav = require('./wav');
const archive = require('./archive');
const { fail } = require('./asr/types');

const MOD = 'importer';

const IMPORT_MAX_BYTES = 500 * 1024 * 1024;
const DECODE_MAX_BYTES = 150 * 1024 * 1024;

/** 白名单十种。比较前一律 toLowerCase()——手机导出的文件常见 .WAV / .M4A。 */
const EXTS = ['wav', 'mp3', 'm4a', 'mp4', 'webm', 'ogg', 'opus', 'flac', 'aac', 'amr'];

// 扩展名 → MIME。照抄 asr_shim.py:383 的 MIME_BY_EXT，**并补上原表漏掉的 amr**：
// 事实源的格式清单里有 amr，原表只有九项，漏的那项会落到默认 audio/wav 去。
// 那是现有实现的 bug，别照抄（design.md §24.1）。
const MIME_BY_EXT = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  amr: 'audio/amr',
};
const DEFAULT_MIME = 'audio/wav';

/** 任务状态。界面的队列列表直接显示这几个。 */
const STATUS = {
  queued: 'queued',
  decoding: 'decoding',
  transcribing: 'transcribing',
  done: 'done',
  failed: 'failed',
};

const STATUS_LABEL = {
  queued: '排队',
  decoding: '解码',
  transcribing: '转写',
  done: '完成',
  failed: '失败',
};

const MAX_JOBS_KEPT = 200; // 列表只留最近这么多条，老的挤掉

/** 小写扩展名，不含点。无扩展名返回空串。 */
function extOf(p) {
  const e = path.extname(String(p || ''));
  return e ? e.slice(1).toLowerCase() : '';
}

const isSupported = (p) => EXTS.includes(extOf(p));

/** 扩展名 → MIME。只在「解码失败、原样上传」的降级路径上用得到。 */
const mimeOf = (p) => MIME_BY_EXT[extOf(p)] || DEFAULT_MIME;

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;

/**
 * 决定这个文件怎么处理。纯函数，三条拒绝与两条路线全在这里（便于断言）。
 * @returns {{mode:'decode'|'raw', mime:string, skipSilence:boolean, note:string}}
 * @throws kind ∈ unsupported | empty-file | import-too-large
 */
function plan(filePath, size) {
  if (!isSupported(filePath)) {
    throw fail('unsupported', `格式不支持：${extOf(filePath) || '无扩展名'}`);
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw fail('empty-file', '文件是空的');
  }
  if (size > IMPORT_MAX_BYTES) {
    throw fail('import-too-large', `文件 ${mb(size)} 超过导入上限 ${mb(IMPORT_MAX_BYTES)}`);
  }
  if (size > DECODE_MAX_BYTES) {
    // 不解码就没法做静音拦截、也没法切片，代价明确、文案独立（§24.2）
    return { mode: 'raw', mime: mimeOf(filePath), skipSilence: true, note: '未解码，已直接上传' };
  }
  return { mode: 'decode', mime: DEFAULT_MIME, skipSilence: false, note: '' };
}

/**
 * 「原样上传」这条路上，一次请求最多能塞多少裸字节。
 * base64 内联的后端（百炼）比的是编码后的体积，可用裸字节只有 maxBytes 的 3/4。
 * @param {{id:string, limits:{maxBytes:number, inlineBase64?:boolean, needsWav?:boolean}}[]} chain
 */
function rawCapacity(chain = []) {
  let best = 0;
  for (const c of chain) {
    const lim = (c && c.limits) || {};
    if (lim.needsWav) continue; // 只能吃 WAV 的后端接不了原文件
    if (!Number.isFinite(lim.maxBytes)) return Infinity;
    const usable = lim.inlineBase64 ? Math.floor((lim.maxBytes * 3) / 4) : lim.maxBytes;
    if (usable > best) best = usable;
  }
  return best;
}

/**
 * 未解码的文件超过后端体积上限 → **抛可识别错误**，不许静默「成功」。
 * 没解码就切不开，所以这是死路，只能让这个文件失败、队列继续跑下一个。
 * @throws kind = too-large-unsplittable
 */
function assertRawUploadable(size, capacityBytes) {
  if (!(size <= capacityBytes)) {
    throw fail('too-large-unsplittable', `文件过大且无法切分（${mb(size)}，当前后端上限约 ${Number.isFinite(capacityBytes) ? mb(capacityBytes) : '—'}）`);
  }
  return true;
}

/** 同名冲突加 -2 / -3，**不覆盖**（与 §10.2 同一套规则）。 */
function uniqueName(dir, base) {
  for (let i = 1; i < 1000; i += 1) {
    const name = i === 1 ? base : `${base}-${i}`;
    if (!fs.existsSync(path.join(dir, `${name}.md`))) return name;
  }
  throw new Error(`同名文件太多了，这不正常：${base}`);
}

/**
 * 写产物 Markdown。结构与 §10.2 的长录音归档**同一套**，两处不同：
 * 「原始音频」写的是源文件名，另补一行「识别后端」。
 * 文件名用源文件的主名（不是时间戳），因为用户是按录音找它的。
 */
function writeMarkdown({ dir, base, text, durationSec, audioName, providerId, stamp }) {
  fs.mkdirSync(dir, { recursive: true });
  const name = uniqueName(dir, base);
  const mdPath = path.join(dir, `${name}.md`);
  fs.writeFileSync(
    mdPath,
    archive.renderMarkdown({ stamp, text, durationSec, audioName, provider: providerId }),
    'utf8'
  );
  return mdPath;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RECORDING_WAIT_MS = 2000; // 正在录音：隔这么久再看一眼，不抢带宽和额度

/**
 * 导入队列。串行、一次一个文件。
 *
 * deps（全部必给，除 notify / log）：
 *   decodeFile({jobId, filePath, size, wavPath}) → Promise<{ok, dataBytes?, reason?}>
 *        main.js 实现：MessageChannelMain 送字节、decode:chunk 分块回传、边收边落盘。
 *        **它不许抛**——解码失败要回 {ok:false}，走原样上传降级。
 *   transcribe(args) → Promise<{text, providerId, switched}>
 *   hotwords() → string[]        每次都重读（不变量 6）
 *   cfg() → object
 *   transcriptDir() → string
 *   chainCapacity() → number     当前可用后端里「原样上传」能吃下的最大裸字节
 *   corrections() → {rules}      纠错表（口语清理一律不做：导入都是长录音，不变量 17）
 *   applyCorrections(text, rules) → {text, hits}
 *   isRecording() → boolean
 *   onChange(list) → void        队列变化回调，推给设置页
 *   notify(msg), log
 */
function create(deps) {
  const log = deps.log || logger;
  const jobs = [];
  let seq = 0;
  let pumping = false;
  let activeJobId = null; // 正在解码的任务，decode:chunk 的路由键

  const snapshot = () =>
    jobs.map((j) => ({
      id: j.id,
      name: j.name,
      status: j.status,
      detail: j.detail,
      note: j.note,
      mdPath: j.mdPath,
      error: j.error,
      kind: j.kind, // 失败原因的机器可读形态；界面按 kind 取人话文案
    }));

  const emit = () => {
    if (deps.onChange) {
      try {
        deps.onChange(snapshot());
      } catch (e) {
        log.warn(MOD, `onChange 抛错：${e && e.message}`);
      }
    }
  };

  function setStatus(job, status, detail = '') {
    job.status = status;
    job.detail = detail;
    emit();
  }

  function markFailed(job, e) {
    job.status = STATUS.failed;
    job.error = (e && e.message) || String(e);
    job.kind = (e && e.kind) || 'error';
    job.detail = job.error;
    log.warn(MOD, `${job.name} 失败（${job.kind}）：${job.error}`);
    emit();
  }

  function sizeOf(filePath) {
    try {
      return fs.statSync(filePath).size;
    } catch (e) {
      throw fail('unreadable', `读不到文件：${(e && e.code) || e}`);
    }
  }

  /** 解码：失败不抛，返回 null 让调用方走原样上传降级。 */
  async function tryDecode(job) {
    setStatus(job, STATUS.decoding, '解码中');
    const wavPath = path.join(paths.tmpDir(), `import-${job.id}.wav`);
    fs.mkdirSync(paths.tmpDir(), { recursive: true });
    activeJobId = job.id;
    let r;
    try {
      r = await deps.decodeFile({ jobId: job.id, filePath: job.path, size: job.size, wavPath });
    } catch (e) {
      // decodeFile 约定不抛，但解码期间 render-process-gone 会让它 reject；
      // 那同样是「这个 job 解码失败」，走同一条降级，**不静默丢任务**（H3）。
      r = { ok: false, reason: `${(e && e.name) || ''} ${(e && e.message) || e}`.trim() };
    } finally {
      activeJobId = null;
    }
    if (r && r.ok) return wavPath;
    log.warn(MOD, `${job.name} 解码失败，改为原样上传：${(r && r.reason) || '未知原因'}`);
    try {
      fs.rmSync(wavPath, { force: true });
    } catch {
      /* 留着也只是占点空间 */
    }
    return null;
  }

  async function runOne(job) {
    let p;
    try {
      job.size = sizeOf(job.path);
      p = plan(job.path, job.size);
    } catch (e) {
      markFailed(job, e);
      return;
    }

    let wavPath = p.mode === 'decode' ? await tryDecode(job) : null;
    const decoded = Boolean(wavPath);
    if (!decoded) job.note = p.mode === 'raw' ? p.note : '未解码，已直接上传';

    let durationSec = null;
    if (decoded) {
      let pcm;
      try {
        pcm = wav.readPcm(wavPath);
      } catch (e) {
        markFailed(job, fail('decode', `解码产物读不回来：${e && e.message}`));
        cleanup(wavPath);
        return;
      }
      durationSec = pcm.length / 16000;
      // 静音拦截只在解码过的路径上做；原样上传那条拿不到 PCM（skipSilence）
      if (wav.isSilent(pcm)) {
        markFailed(job, fail('silent', '整段都是静音，没发请求'));
        cleanup(wavPath);
        return;
      }
    }

    setStatus(job, STATUS.transcribing, decoded ? '转写中' : '转写中（未解码，原样上传）');
    let r;
    try {
      if (decoded) {
        // 之后完全走既有链路：切片 → provider 链 都在 asr.transcribe 里
        r = await deps.transcribe({
          tracks: { opus: null, wavPath },
          durationSec,
          mode: '长录音',
          hotwords: deps.hotwords(),
          cfg: deps.cfg(),
        });
      } else {
        // 先按已知的 size 判，再读文件：否则一个 400MB 的文件会先被整个读进
        // 内存，然后才发现没有后端吃得下
        assertRawUploadable(job.size, deps.chainCapacity());
        const buf = fs.readFileSync(job.path);
        r = await deps.transcribe({
          tracks: { opus: buf, wavPath: null },
          mime: job.mime || mimeOf(job.path),
          durationSec: null, // 没解码就不知道时长，chain 按「不可切的短输入」组
          mode: '短输入',
          hotwords: deps.hotwords(),
          cfg: deps.cfg(),
        });
      }
    } catch (e) {
      markFailed(job, e);
      cleanup(wavPath);
      return;
    }

    const raw = String((r && r.text) || '').trim();
    if (raw === '') {
      markFailed(job, fail('empty', '后端没识别出内容'));
      cleanup(wavPath);
      return;
    }

    // 后处理：只做纠错。口语清理对长录音一律跳过、不看配置（不变量 17）
    let text = raw;
    try {
      const { rules } = deps.corrections();
      text = deps.applyCorrections(text, rules).text;
    } catch (e) {
      log.warn(MOD, `纠错失败，用原文：${e && e.message}`);
    }

    try {
      job.mdPath = writeMarkdown({
        dir: deps.transcriptDir(),
        base: path.basename(job.path, path.extname(job.path)),
        text,
        durationSec: durationSec || 0,
        audioName: path.basename(job.path), // 源文件名；手动导入的原文件保持原地不动
        providerId: (r && r.providerId) || '未知',
        stamp: archive.stampOf(new Date()),
      });
    } catch (e) {
      markFailed(job, fail('write', `写产物失败：${e && e.message}`));
      cleanup(wavPath);
      return;
    }

    cleanup(wavPath);
    job.chars = [...text].length;
    setStatus(job, STATUS.done, `完成，${job.chars} 字`);
    log.info(MOD, `${job.name} 完成：${job.chars} 字，后端 ${(r && r.providerId) || '未知'} → ${job.mdPath}`);
    if (job.onFinished) {
      try {
        await job.onFinished(job);
      } catch (e) {
        log.warn(MOD, `onFinished 抛错：${e && e.message}`);
      }
    }
  }

  function cleanup(wavPath) {
    if (!wavPath) return;
    try {
      fs.rmSync(wavPath, { force: true });
    } catch {
      /* 下次启动的残留扫描会收拾 */
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const job = jobs.find((j) => j.status === STATUS.queued);
        if (!job) break;
        // 正在录音时暂停处理队列，录完自动继续（§24.3）
        if (deps.isRecording && deps.isRecording()) {
          await sleep(RECORDING_WAIT_MS);
          continue;
        }
        await runOne(job);
      }
    } finally {
      pumping = false;
    }
  }

  return {
    /**
     * 入队。路径已由 §16 校验过是绝对路径；这里再过一遍白名单与可读性。
     * @param {string[]} list
     * @param {{onFinished?:(job)=>any}} [opts] 监听目录用它把转完的文件挪进 已完成/
     */
    add(list = [], opts = {}) {
      const added = [];
      for (const p of list) {
        if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
        seq += 1;
        const job = {
          id: `imp-${Date.now().toString(36)}-${seq}`,
          path: p,
          name: path.basename(p),
          status: STATUS.queued,
          detail: '排队中',
          note: '',
          mime: mimeOf(p),
          mdPath: null,
          error: null,
          onFinished: opts.onFinished || null,
        };
        if (!isSupported(p)) {
          // 不在白名单：跳过且**不移动用户的文件**，只在列表里标一行
          job.status = STATUS.failed;
          job.error = `格式不支持：${extOf(p) || '无扩展名'}`;
          job.detail = job.error;
          job.kind = 'unsupported';
          log.debug(MOD, `跳过非音频文件 ${job.name}`);
        }
        jobs.push(job);
        added.push(job.id);
      }
      while (jobs.length > MAX_JOBS_KEPT) jobs.shift();
      emit();
      pump().catch((e) => log.error(MOD, `队列异常：${e && e.message}`));
      return { ok: true, added: added.length, jobs: snapshot() };
    },
    list: snapshot,
    /** 还有多少个没跑完。托盘与状态条用。 */
    activeCount: () => jobs.filter((j) => j.status !== STATUS.done && j.status !== STATUS.failed).length,
    isActiveDecodeJob: (jobId) => Boolean(jobId) && jobId === activeJobId,
    /** 录完一次音后叫一下，接着跑被暂停的队列。 */
    kick: () => pump().catch((e) => log.error(MOD, `队列异常：${e && e.message}`)),
  };
}


module.exports = {
  IMPORT_MAX_BYTES,
  DECODE_MAX_BYTES,
  EXTS,
  MIME_BY_EXT,
  DEFAULT_MIME,
  STATUS,
  STATUS_LABEL,
  MAX_JOBS_KEPT,
  extOf,
  isSupported,
  mimeOf,
  plan,
  rawCapacity,
  assertRawUploadable,
  uniqueName,
  writeMarkdown,
  create,
};
