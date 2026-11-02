'use strict';
// 赞助页的资源读取（design.md §25.2）。
//
// 只有两件事：收款码在不在、读成 data URL。
//
// **图片必须由 main 读成 data URL 再经 IPC 给 renderer**，不让 renderer 用
// file:// 指 asar 内的路径。两个边界都躲掉了：打包后资源在 app.asar 里面，
// 以及 sandbox:true 窗口的 CSP 不放行外部 file://。图片是一次性小文件，
// data URL 多一跳的开销无所谓。
//
// 缺图时**降级而不是报错或留白**（事实源明确要求）：官方发布版由 CI 从 secret
// 注入收款码，fork 构建与 PR 构建拿不到 secret，出来的就是不含收款码的版本，
// 这是预期结果，不是故障。
//
// 加载期不碰 electron（评审 M8）：app.getAppPath() 写在函数体里，裸 Node 下
// 退回仓库根，测试可以直接传 root 参数。

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'sponsor-wechat.jpg';
const DATA_URL_PREFIX = 'data:image/jpeg;base64,';

// TODO(FEAT-005)：Electron 版是新仓库还是现有仓库的新分支由用户定（plan 条目 35）。
// 这里先指现有仓库，推送前确认一次。
const REPO_URL = 'https://github.com/lihaochuang/voice-input-cn';

const TEXT_WITH_IMAGE = '开源免费。如果这个工具帮到你，可以扫码请作者喝杯咖啡——完全自愿，和功能无关。';
const TEXT_MISSING = '这个版本不含收款码（自行构建的版本都不含）。如果这个工具帮到你，去 GitHub 点个 star 就够了。';

/** 应用根目录。打包后是 app.asar 的路径，裸 Node 下是仓库根。 */
function appRoot() {
  try {
    // eslint-disable-next-line global-require
    const { app } = require('electron');
    if (app && typeof app.getAppPath === 'function') return app.getAppPath();
  } catch {
    /* 裸 Node */
  }
  return path.resolve(__dirname, '..', '..');
}

/** 收款码的完整路径。 */
const filePath = (root = appRoot()) => path.join(root, 'assets', FILE_NAME);

/** 收款码在不在。任何异常都按「不在」处理，赞助页永不因此报错。 */
function has(root = appRoot()) {
  try {
    return fs.existsSync(filePath(root));
  } catch {
    return false;
  }
}

/** 读成 data URL。文件不存在会抛（调用方应先问 has()）。 */
function dataUrl(root = appRoot()) {
  return DATA_URL_PREFIX + fs.readFileSync(filePath(root)).toString('base64');
}

/**
 * sponsor:get 的返回值（§25.2）。
 * @returns {{has:boolean, dataUrl?:string, text:string, repo:string}}
 */
function get(root = appRoot()) {
  if (!has(root)) return { has: false, text: TEXT_MISSING, repo: REPO_URL };
  try {
    return { has: true, dataUrl: dataUrl(root), text: TEXT_WITH_IMAGE, repo: REPO_URL };
  } catch {
    // 文件在但读不出来（权限、坏文件）：和缺图一样降级，不把异常抛进 IPC
    return { has: false, text: TEXT_MISSING, repo: REPO_URL };
  }
}

module.exports = {
  FILE_NAME,
  DATA_URL_PREFIX,
  REPO_URL,
  TEXT_WITH_IMAGE,
  TEXT_MISSING,
  appRoot,
  filePath,
  has,
  dataUrl,
  get,
};
