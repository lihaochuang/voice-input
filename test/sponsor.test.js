'use strict';
// 赞助页资源（design.md §25.2）。
//
// 唯一要盯死的行为：**缺图时降级而不是报错或留白**。
// 官方发布版由 CI 从 secret 注入收款码，fork 构建拿不到 secret，出来的就是
// 不含收款码的版本——那是预期结果，不是故障（§25.3）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const sponsor = require('../src/main/sponsor');
const { FILE_NAME, DATA_URL_PREFIX, TEXT_MISSING, REPO_URL } = sponsor;

/** 造一个假的 appRoot；带不带 assets/sponsor-wechat.jpg 由参数定。 */
function fakeRoot(withImage) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-sp-'));
  if (withImage) {
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    // 真 JPEG 的头几个字节，内容不重要，只要 base64 得出来
    fs.writeFileSync(path.join(root, 'assets', FILE_NAME), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
  }
  return root;
}

test('缺图 → has()=false，get() 回降级文案而不是抛错', () => {
  const root = fakeRoot(false);
  assert.strictEqual(sponsor.has(root), false);
  const r = sponsor.get(root);
  assert.strictEqual(r.has, false);
  assert.strictEqual(r.dataUrl, undefined, '没有图就别给 dataUrl');
  assert.strictEqual(r.text, TEXT_MISSING);
  assert.match(r.text, /自行构建的版本都不含/);
  assert.match(r.text, /star/);
  assert.strictEqual(r.repo, REPO_URL, '缺图时必须给仓库外链');
});

test('有图 → has()=true，dataUrl 前缀正确且能解回原字节', () => {
  const root = fakeRoot(true);
  assert.strictEqual(sponsor.has(root), true);
  const r = sponsor.get(root);
  assert.strictEqual(r.has, true);
  assert.ok(r.dataUrl.startsWith(DATA_URL_PREFIX), `前缀应为 ${DATA_URL_PREFIX}`);
  assert.strictEqual(DATA_URL_PREFIX, 'data:image/jpeg;base64,');
  const b64 = r.dataUrl.slice(DATA_URL_PREFIX.length);
  assert.deepStrictEqual(Buffer.from(b64, 'base64'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
  assert.notStrictEqual(r.text, TEXT_MISSING, '有图就不该是降级文案');
  assert.strictEqual(r.repo, REPO_URL);
});

test('收款码的文件名与路径定死（CI 注入与 .gitignore 都按它来）', () => {
  assert.strictEqual(FILE_NAME, 'sponsor-wechat.jpg');
  const root = path.join(path.sep, 'app');
  assert.strictEqual(sponsor.filePath(root), path.join(root, 'assets', 'sponsor-wechat.jpg'));
});

test('图片走 main 读成 data URL，不让 renderer 用 file:// 指 asar 内的路径', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/sponsor.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.match(src, /readFileSync[\s\S]{0,60}base64/);
  assert.doesNotMatch(src, /file:\/\//);
});

test('加载期不碰 electron（裸 Node 可直接 require，评审 M8）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/sponsor.js'), 'utf8');
  // require('electron') 只许出现在函数体里
  const topLevel = src.split('\n').filter((l) => /^const .*require\(/.test(l));
  assert.deepStrictEqual(
    topLevel.filter((l) => /electron/.test(l)),
    [],
    'electron 不许在模块顶层 require'
  );
  // 不在 Electron 里时 appRoot() 退回仓库根，而不是抛错
  assert.strictEqual(sponsor.appRoot(), path.resolve(__dirname, '..'));
});

test('文件在但读不出来时，也按缺图降级，不把异常抛进 IPC', () => {
  const root = fakeRoot(false);
  // 把 jpg 做成目录：existsSync 为 true，readFileSync 会 EISDIR
  fs.mkdirSync(path.join(root, 'assets', FILE_NAME), { recursive: true });
  assert.strictEqual(sponsor.has(root), true);
  const r = sponsor.get(root);
  assert.strictEqual(r.has, false);
  assert.strictEqual(r.text, TEXT_MISSING);
});

test('收款码不被 git 跟踪，且被 .gitignore 排除（§25.3）', () => {
  const root = path.resolve(__dirname, '..');
  const rel = `assets/${FILE_NAME}`;
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /sponsor-wechat\.jpg/);

  // 要守的不变量是「绝不**进仓库**」=「不被 git 跟踪」，不是「本地磁盘上不存在」。
  // 这两者必须分开：本地放一张真收款码是正常且必要的工作状态
  //   —— 要验收 §25.2 的「有图」那条分支、以及本机打一个自带收款码的包，都得先有这个文件；
  // CI 也会在 Build 之前把 secret 解码写到同一个路径上。
  // 原来断言 existsSync === false，等于把「开发机上有这张图」判成违规，
  // npm test 会在一台完全合规的机器上变红（本轮实测踩到）。
  const r = spawnSync('git', ['ls-files', '--error-unmatch', rel], { cwd: root, encoding: 'utf8' });
  if (r.error) return; // 没装 git（或不是仓库）就没法判跟踪状态，上面那条 .gitignore 断言已是挡板
  assert.notStrictEqual(r.status, 0, `${rel} 被 git 跟踪了——收款码绝不能进仓库`);
});
