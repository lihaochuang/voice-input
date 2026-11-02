'use strict';
// 唯一接触 API Key 明文的模块（design.md §9、不变量 7、§15-2a/2b）。
//
// 三条硬约束：
// ① 一个后端一份密文文件 creds/<id>.enc；清理用的 key 单独 polish-key.enc。
// ② 明文只在当次请求头里存在：get() 的返回值不赋给任何模块级变量、不跨 IPC。
// ③ **「文件不存在」与「解密抛错」必须分开处置**：
//    - 不存在 → isConfigured()=false、静默跳过、warn（用户本来就没配过）；
//    - 解密抛错 → 删掉坏文件 + 抛 kind:'decrypt'，由调用方弹托盘 ⚠ 与明确提示
//      「密钥无法解密（可能因应用更新或系统变更），请重新填写」+ 记 error。
//    合并成一行的后果是「配置凭空消失」而用户完全看不出原因。
//
// 加载期不碰 electron：safeStorage 在函数体里 require。
const fs = require('fs');
const logger = require('./logger');
const paths = require('./paths');

const MOD = 'secret';

function safeStorage() {
  // eslint-disable-next-line global-require
  return require('electron').safeStorage;
}

/** 密文文件路径。id === 'polish' 走单独的 polish-key.enc。 */
function fileOf(id) {
  return id === 'polish' ? paths.polishKeyPath() : paths.credPath(id);
}

/** safeStorage 是否可用。必须在 app.whenReady() 之后调，ready 之前不可靠。 */
function available() {
  try {
    return safeStorage().isEncryptionAvailable();
  } catch (e) {
    logger.error(MOD, `isEncryptionAvailable 抛错：${e && e.message}`);
    return false;
  }
}

/** 密文文件是否存在。不解密，所以不会因为坏文件而报错。 */
function has(id) {
  try {
    return fs.existsSync(fileOf(id));
  } catch {
    return false;
  }
}

const isConfigured = (id) => has(id);

/** 解密失败专用错误，带 kind 供注册表按 kind 决策（不解析文案）。 */
function errDecrypt(id) {
  const e = new Error(`密钥无法解密：${id}`);
  e.kind = 'decrypt';
  e.providerId = id;
  return e;
}

/**
 * 取明文 key。
 * 文件不存在 → 返回 null（静默，warn 一条）。
 * 解密抛错   → 删掉坏文件并抛 kind:'decrypt'。
 */
function get(id) {
  const file = fileOf(id);
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      logger.warn(MOD, `${id} 未配置密钥（${file} 不存在）`);
      return null;
    }
    logger.error(MOD, `读取 ${id} 密钥失败：${e && e.code} ${e && e.message}`);
    return null;
  }
  try {
    return safeStorage().decryptString(buf);
  } catch (e) {
    logger.error(MOD, `解密 ${id} 密钥抛错，已删除坏文件：${e && e.name} ${e && e.message}`);
    try {
      fs.unlinkSync(file);
    } catch (e2) {
      logger.warn(MOD, `删除坏密钥文件失败：${e2 && e2.message}`);
    }
    throw errDecrypt(id);
  }
}

/** 写入。明文不落 配置.json、不进日志。 */
function set(id, key) {
  if (!available()) {
    const e = new Error('当前系统无法安全存储密钥');
    e.kind = 'unavailable';
    throw e;
  }
  fs.mkdirSync(paths.credsDir(), { recursive: true });
  fs.writeFileSync(fileOf(id), safeStorage().encryptString(key));
  logger.info(MOD, `已保存 ${id} 的密钥（掩码 ${maskOf(key)}）`);
  return true;
}

function del(id) {
  try {
    fs.unlinkSync(fileOf(id));
    logger.info(MOD, `已删除 ${id} 的密钥`);
    return true;
  } catch (e) {
    if (e && e.code !== 'ENOENT') logger.warn(MOD, `删除 ${id} 密钥失败：${e.message}`);
    return false;
  }
}

/** 掩码：sk-••••••••1234，取末 4 位。纯函数，便于测试。 */
function maskOf(key) {
  if (typeof key !== 'string' || key === '') return '';
  const tail = key.slice(-4);
  return `sk-••••••••${tail}`;
}

/**
 * 给设置页用的掩码。没配过 → null；解密失败 → 往上抛 kind:'decrypt'
 * （调用方负责提示，不能在这里吞掉变成「没配过」）。
 */
function mask(id) {
  const key = get(id);
  return key === null ? null : maskOf(key);
}

module.exports = { available, has, isConfigured, get, set, del, mask, maskOf, fileOf };
