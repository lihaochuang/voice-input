'use strict';
// 所有运行期路径只在这里拼。
//
// 不变量（评审 M8）：本文件在**模块加载期绝不触碰 electron**。
// 单测跑在裸 Node 里（不是 Electron），加载期一调 electron 就全红。
// 所以 require('electron') 一律写在函数体内，并且先看 VI_DATA_DIR 环境变量。

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 懒加载 electron 的 app；裸 Node 下返回 null 而不是抛错。 */
function electronApp() {
  try {
    // eslint-disable-next-line global-require
    const { app } = require('electron');
    return app && typeof app.getPath === 'function' ? app : null;
  } catch {
    return null;
  }
}

/**
 * 运行期数据根目录。
 * 优先 VI_DATA_DIR（单测用它指向临时目录），否则 app.getPath('userData')。
 */
function dataDir() {
  if (process.env.VI_DATA_DIR) return process.env.VI_DATA_DIR;
  const app = electronApp();
  if (app) return app.getPath('userData');
  throw new Error('dataDir() 不可用：既没有 VI_DATA_DIR，也不在 Electron 里');
}

/**
 * 文档目录，长录音转录产物的默认落点父目录。
 * 转录产物是用户要用的文档，不能藏在 userData 里（§10）。
 */
function documentsDir() {
  if (process.env.VI_DOCUMENTS_DIR) return process.env.VI_DOCUMENTS_DIR;
  const app = electronApp();
  if (app) return app.getPath('documents');
  return path.join(os.homedir(), 'Documents');
}

/** 默认转录目录：<文档>/语音输入转录 */
const defaultTranscriptDir = () => path.join(documentsDir(), '语音输入转录');

const configPath = () => path.join(dataDir(), '配置.json');
const configBakPath = () => path.join(dataDir(), '配置.json.bak');
const credsDir = () => path.join(dataDir(), 'creds');
const credPath = (id) => path.join(credsDir(), `${id}.enc`);
const polishKeyPath = () => path.join(dataDir(), 'polish-key.enc');
const hotwordsPath = () => path.join(dataDir(), '热词.txt');
const correctionsPath = () => path.join(dataDir(), '纠错表.txt');
const pendingHotwordsPath = () => path.join(dataDir(), '待确认热词.txt');
const historyDir = () => path.join(dataDir(), '历史');
const pendingDir = () => path.join(dataDir(), '待处理');
const tmpDir = () => path.join(dataDir(), 'tmp');
const logDir = () => path.join(dataDir(), '日志');
const sentinelPath = () => path.join(dataDir(), 'hook.sentinel');
const importDonePath = () => path.join(dataDir(), '导入已完成.jsonl');

/** 历史按月分文件：历史/YYYY-MM.jsonl。d 默认当前时间（本地时区）。 */
function historyPath(d = new Date()) {
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return path.join(historyDir(), `${ym}.jsonl`);
}

/** 仓库根（示例文件 热词.示例.txt / 纠错表.示例.txt 所在处）。 */
const appRoot = () => path.resolve(__dirname, '..', '..');
const sampleHotwordsPath = () => path.join(appRoot(), '热词.示例.txt');
const sampleCorrectionsPath = () => path.join(appRoot(), '纠错表.示例.txt');

/** 建齐所有要写入的目录。幂等。 */
function ensureDirs() {
  for (const dir of [dataDir(), credsDir(), historyDir(), pendingDir(), tmpDir(), logDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dataDir();
}

module.exports = {
  dataDir,
  documentsDir,
  defaultTranscriptDir,
  configPath,
  configBakPath,
  credsDir,
  credPath,
  polishKeyPath,
  hotwordsPath,
  correctionsPath,
  pendingHotwordsPath,
  historyDir,
  historyPath,
  pendingDir,
  tmpDir,
  logDir,
  sentinelPath,
  importDonePath,
  appRoot,
  sampleHotwordsPath,
  sampleCorrectionsPath,
  ensureDirs,
};
