'use strict';
// afterPack 钩子：对 macOS 产物做本地 ad-hoc 签名（身份 "-"）。不是可选项。
//
// 为什么必须签：
//   macOS 的 TCC 权限绑定代码签名身份。完全未签名的 app 即使用户在「隐私与安全性」
//   里打了勾，实际仍被拒——表现为「已授权但录不到音」「已授权但粘不进去」，
//   而且授权状态看起来是正常的，极难查。ad-hoc 签名（codesign --sign -）就能让
//   TCC 授权真正生效，不需要苹果开发者证书、不做公证。
//
// 为什么挂 afterPack 而不是 afterSign：
//   package.json 里 mac.identity 是 null，此时 electron-builder 整体跳过签名流程，
//   afterSign 钩子不会触发。afterPack 在 app 打包完成、dmg 封装之前执行，必定跑到。
//
// 失败必须让构建失败（throw），不许降级成警告：没签名的包发到用户机器上，
// 症状是「权限勾了但功能不工作」，比构建红一次难查得多。
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // --force 覆盖任何已有签名，--deep 递归签内嵌 framework/helper，--sign - 为 ad-hoc。
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });

  // 校验必须：① 合并 stdout 与 stderr —— codesign -dv 的诊断输出走 stderr，stdout 是空的，
  // 只读 stdout 会让正则永远不匹配、macOS 侧 100% 构建红；
  // ② 同时判 r.status —— spawnSync 不因非零退出码抛错，只看正则会把「codesign 根本没跑起来」
  // （命令不存在、路径错）误读成「签名没生效」，报出来的原因指向错的地方。
  const r = spawnSync('codesign', ['-dv', app], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0 || !/Signature=adhoc/.test(out)) {
    throw new Error(`ad-hoc 签名未生效（status=${r.status}）：${out}`);
  }
  console.log(`[afterPack] ad-hoc signed: ${app}`);
};
