'use strict';
// 零依赖图标生成：纯 Node（zlib + 手写 PNG chunk），不引任何图像库。
//
// 产物（都要提交进仓库，.gitignore 只忽略 assets/*.psd 与 assets/sponsor-wechat.jpg）：
//   assets/icon.png                512×512 应用图标
//   assets/icon.ico                Windows 图标（Vista+ 支持 ICO 内嵌 PNG，所以容器里直接放 PNG）
//   assets/icon.icns               macOS 图标（由系统自带 iconutil 生成，非 macOS 上跳过）
//   assets/tray/tray-<state>@16.png 与 @32.png   7 状态 × 2 尺寸 = 14 个
//
// 托盘为什么要 7 张图：Windows 托盘没有文字位（macOS 走 tray.setTitle 的 emoji），
// 状态只能靠图标本身表达，状态名与 src/main/tray.js 的 STATES[].icon 必须逐字对应。
//
// 画法：所有图元按硬边绘制在 SS 倍超采样画布上，再做盒式降采样当抗锯齿，省掉一套 AA 代码。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ASSETS = path.resolve(__dirname, '..', 'assets');
const SS = 4; // 超采样倍数

// ---------- 画布 ----------
function canvas(size) {
  return { size, px: new Uint8Array(size * size * 4) };
}
function setPx(c, x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= c.size || y >= c.size) return;
  const i = (y * c.size + x) * 4;
  if (a === 255) {
    c.px[i] = r; c.px[i + 1] = g; c.px[i + 2] = b; c.px[i + 3] = 255;
    return;
  }
  // 简单 source-over（只在半透明色用到）
  const sa = a / 255, da = c.px[i + 3] / 255, oa = sa + da * (1 - sa);
  if (oa === 0) return;
  c.px[i] = Math.round((r * sa + c.px[i] * da * (1 - sa)) / oa);
  c.px[i + 1] = Math.round((g * sa + c.px[i + 1] * da * (1 - sa)) / oa);
  c.px[i + 2] = Math.round((b * sa + c.px[i + 2] * da * (1 - sa)) / oa);
  c.px[i + 3] = Math.round(oa * 255);
}
function fillRect(c, x0, y0, w, h, col) {
  for (let y = Math.round(y0); y < Math.round(y0 + h); y++) {
    for (let x = Math.round(x0); x < Math.round(x0 + w); x++) setPx(c, x, y, col);
  }
}
// col 可以是颜色数组，也可以是 (t) => 颜色（t 为 0..1 的纵向位置，用来画渐变）
function fillRoundRect(c, x0, y0, w, h, r, col) {
  const f = typeof col === 'function' ? col : () => col;
  for (let y = Math.round(y0); y < Math.round(y0 + h); y++) {
    const c1 = f((y - y0) / h);
    for (let x = Math.round(x0); x < Math.round(x0 + w); x++) {
      const cx = Math.min(Math.max(x, x0 + r), x0 + w - r);
      const cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) setPx(c, x, y, c1);
    }
  }
}
function fillCircle(c, cx, cy, r, col) {
  for (let y = Math.round(cy - r); y <= Math.round(cy + r); y++) {
    for (let x = Math.round(cx - r); x <= Math.round(cx + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) setPx(c, x, y, col);
    }
  }
}
// 圆环的一段（下半弧用来画麦克风托架）
function strokeArc(c, cx, cy, r, width, a0, a1, col) {
  const rin = r - width / 2, rout = r + width / 2;
  for (let y = Math.round(cy - rout); y <= Math.round(cy + rout); y++) {
    for (let x = Math.round(cx - rout); x <= Math.round(cx + rout); x++) {
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
      if (d < rin || d > rout) continue;
      let a = Math.atan2(dy, dx);
      if (a < 0) a += Math.PI * 2;
      if (a >= a0 && a <= a1) setPx(c, x, y, col);
    }
  }
}
// 盒式降采样：SS 倍画布 → 目标尺寸
function downsample(c, size) {
  const out = canvas(size), n = c.size / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const k = ((y * n + j) * c.size + (x * n + i)) * 4;
          const sa = c.px[k + 3] / 255;
          r += c.px[k] * sa; g += c.px[k + 1] * sa; b += c.px[k + 2] * sa; a += sa;
        }
      }
      const k = (y * size + x) * 4, cnt = n * n;
      if (a > 0) { out.px[k] = Math.round(r / a); out.px[k + 1] = Math.round(g / a); out.px[k + 2] = Math.round(b / a); }
      out.px[k + 3] = Math.round((a / cnt) * 255);
    }
  }
  return out;
}

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(c) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.size, 0);
  ihdr.writeUInt32BE(c.size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc((c.size * 4 + 1) * c.size);
  for (let y = 0; y < c.size; y++) {
    const off = y * (c.size * 4 + 1);
    raw[off] = 0; // filter: none
    Buffer.from(c.px.buffer, y * c.size * 4, c.size * 4).copy(raw, off + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- ICO 容器（内嵌 PNG，Vista+） ----------
function encodeIco(pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);          // reserved
  head.writeUInt16LE(1, 2);          // type: icon
  head.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = head.length + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size;     // 256 记作 0
    dir[o + 1] = size >= 256 ? 0 : size;
    dir[o + 2] = 0; dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);         // planes
    dir.writeUInt16LE(32, o + 6);        // bit count
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, dir, ...pngs.map((p) => p.data)]);
}

// ---------- 图形 ----------
const WHITE = [255, 255, 255, 255];
// 应用图标：蓝底圆角方 + 白麦克风
function appIcon(size) {
  const S = size * SS, c = canvas(S);
  // 纵向渐变：上浅蓝 → 下深蓝（逐行插值，不是两个叠加的矩形，否则中间会留一条硬边）
  fillRoundRect(c, 0, 0, S, S, S * 0.22, (t) => [
    Math.round(59 + (29 - 59) * t),
    Math.round(130 + (78 - 130) * t),
    Math.round(246 + (216 - 246) * t),
    255,
  ]);
  fillRoundRect(c, S * 0.41, S * 0.2, S * 0.18, S * 0.36, S * 0.09, WHITE); // 振膜
  strokeArc(c, S * 0.5, S * 0.5, S * 0.17, S * 0.045, 0, Math.PI, WHITE);    // 托架
  fillRect(c, S * 0.485, S * 0.67, S * 0.03, S * 0.1, WHITE);                // 支杆
  fillRoundRect(c, S * 0.4, S * 0.765, S * 0.2, S * 0.035, S * 0.017, WHITE); // 底座
  return downsample(c, size);
}
// 托盘：7 状态各一个辨识度靠「形状 + 颜色」双保险的小图（Windows 托盘没有文字位）
const TRAY_STATES = {
  'tray-idle':   { color: [100, 116, 139, 255], shape: 'mic' },
  'tray-rec':    { color: [220, 38, 38, 255],   shape: 'dot' },
  'tray-busy':   { color: [234, 179, 8, 255],   shape: 'ring' },
  'tray-ok':     { color: [22, 163, 74, 255],   shape: 'check' },
  'tray-copied': { color: [37, 99, 235, 255],   shape: 'square' },
  'tray-warn':   { color: [234, 88, 12, 255],   shape: 'tri' },
  'tray-nomic':  { color: [120, 113, 108, 255], shape: 'slash' },
};
function trayIcon(state, size) {
  const { color, shape } = TRAY_STATES[state];
  const S = size * SS, c = canvas(S), m = S * 0.12; // 留边，托盘不许顶满
  const w = S - m * 2;
  if (shape === 'mic') {
    fillRoundRect(c, S * 0.38, m, S * 0.24, w * 0.52, S * 0.12, color);
    strokeArc(c, S * 0.5, m + w * 0.42, w * 0.26, S * 0.08, 0, Math.PI, color);
    fillRect(c, S * 0.46, m + w * 0.68, S * 0.08, w * 0.2, color);
    fillRect(c, S * 0.34, m + w * 0.86, S * 0.32, S * 0.09, color);
  } else if (shape === 'dot') {
    fillCircle(c, S / 2, S / 2, w * 0.46, color);
  } else if (shape === 'ring') {
    strokeArc(c, S / 2, S / 2, w * 0.38, S * 0.14, 0, Math.PI * 1.45, color);
  } else if (shape === 'check') {
    for (let t = 0; t <= 1; t += 0.002) { // 对勾两段笔画
      fillCircle(c, m + w * (0.08 + 0.3 * t), m + w * (0.5 + 0.34 * t), S * 0.08, color);
      fillCircle(c, m + w * (0.38 + 0.56 * t), m + w * (0.84 - 0.68 * t), S * 0.08, color);
    }
  } else if (shape === 'square') {
    fillRoundRect(c, m + w * 0.06, m + w * 0.06, w * 0.88, w * 0.88, S * 0.1, color);
  } else if (shape === 'tri') {
    for (let y = 0; y < w; y++) { // 等腰三角（警告）
      const half = (w * 0.5) * (y / w);
      fillRect(c, S / 2 - half, m + y, half * 2, 1, color);
    }
  } else if (shape === 'slash') {
    fillCircle(c, S / 2, S / 2, w * 0.46, color);
    for (let t = 0; t <= 1; t += 0.002) { // 斜杠（麦克风不可用）
      fillCircle(c, m + w * (0.18 + 0.64 * t), m + w * (0.82 - 0.64 * t), S * 0.09, [255, 255, 255, 255]);
    }
  }
  return downsample(c, size);
}

// ---------- 产出 ----------
function write(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  console.log(`写出 ${path.relative(path.resolve(__dirname, '..'), file)}（${buf.length} 字节）`);
}
function main() {
  write(path.join(ASSETS, 'icon.png'), encodePng(appIcon(512)));

  for (const state of Object.keys(TRAY_STATES)) {
    for (const size of [16, 32]) {
      write(path.join(ASSETS, 'tray', `${state}@${size}.png`), encodePng(trayIcon(state, size)));
    }
  }

  const icoSizes = [16, 32, 48, 64, 128, 256];
  write(path.join(ASSETS, 'icon.ico'), encodeIco(icoSizes.map((size) => ({ size, data: encodePng(appIcon(size)) }))));

  // icns 只能在 macOS 上由系统自带 iconutil 生成（CI 不生成，产物提交进仓库）。
  if (process.platform !== 'darwin') {
    console.log('跳过 icon.icns：不是 macOS（仓库里已提交本机生成的那份）');
    return;
  }
  const setDir = path.join(ASSETS, 'icon.iconset');
  fs.rmSync(setDir, { recursive: true, force: true });
  fs.mkdirSync(setDir, { recursive: true });
  for (const [name, size] of [
    ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024],
  ]) {
    fs.writeFileSync(path.join(setDir, name), encodePng(appIcon(size)));
  }
  execFileSync('iconutil', ['-c', 'icns', setDir, '-o', path.join(ASSETS, 'icon.icns')], { stdio: 'inherit' });
  fs.rmSync(setDir, { recursive: true, force: true });
  console.log('写出 assets/icon.icns（iconutil）');
}
main();
