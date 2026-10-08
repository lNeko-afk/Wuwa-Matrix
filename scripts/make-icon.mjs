#!/usr/bin/env node
/**
 * 生成应用图标：build/icon.png（512）与 build/icon.ico（16~256 多尺寸）。
 *
 * 为什么自己画而不是塞一张美术图：
 *  1. 零依赖 —— 只用 node 内置 zlib，PNG/ICO 都是手写封装，不需要 sharp/canvas；
 *  2. 零版权风险 —— 图标是纯几何图形（深色圆角底 + 3x3 矩阵格），不含游戏素材；
 *  3. 可复现 —— 想换配色改下面 THEME 即可，`npm run icon` 重生成。
 *
 * 图案含义：3x3 的格子 = 矩阵挑战；对角亮青色 = 已排好的队伍格。
 *
 * 用法: node scripts/make-icon.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build');

/* ------------------------------------------------------------------ *
 *  配置
 * ------------------------------------------------------------------ */
const MASTER = 512; // 主尺寸（icon.png）
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const THEME = {
  bgTop: '#20365a',
  bgBottom: '#0a1020',
  accent: '#46c8de', // 普通亮格
  accentHot: '#9feefb', // 对角高亮格
  cell: '#22384f', // 暗格填充
  cellEdge: '#3a6285', // 暗格描边
};

/** '#rrggbb' -> [r,g,b] */
const rgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/* ------------------------------------------------------------------ *
 *  PNG 封装（手写，无依赖）
 * ------------------------------------------------------------------ */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** RGBA8 像素缓冲 -> PNG 文件内容 */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO 封装：每帧直接内嵌 PNG（Vista+ 支持），比 BMP 帧简单且更小 */
function encodeIco(frames) {
  const dir = Buffer.alloc(6 + frames.length * 16);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(frames.length, 4);
  let offset = dir.length;
  frames.forEach((frame, i) => {
    const e = 6 + i * 16;
    dir[e] = frame.size >= 256 ? 0 : frame.size; // 0 表示 256
    dir[e + 1] = frame.size >= 256 ? 0 : frame.size;
    dir[e + 2] = 0; // 调色板数
    dir[e + 3] = 0; // reserved
    dir.writeUInt16LE(1, e + 4); // color planes
    dir.writeUInt16LE(32, e + 6); // bits per pixel
    dir.writeUInt32LE(frame.png.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += frame.png.length;
  });
  return Buffer.concat([dir, ...frames.map((f) => f.png)]);
}

/* ------------------------------------------------------------------ *
 *  极简光栅化：超采样 + source-over 合成（预乘 alpha）
 * ------------------------------------------------------------------ */
function makeSurface(size, ss) {
  const w = size * ss;
  const h = size * ss;
  const buf = new Float32Array(w * h * 4); // 预乘: r*a, g*a, b*a, a
  return { w, h, buf };
}

/** 在超采样缓冲上按形状填充（paint 返回 [r,g,b,a]，a 为 0~1） */
function paint(surface, inside, paintFn) {
  const { w, h, buf } = surface;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x + 0.5, y + 0.5)) continue;
      const [sr, sg, sb, sa] = paintFn(x + 0.5, y + 0.5);
      if (sa <= 0) continue;
      const i = (y * w + x) * 4;
      const inv = 1 - sa;
      buf[i] = sr * sa + buf[i] * inv;
      buf[i + 1] = sg * sa + buf[i + 1] * inv;
      buf[i + 2] = sb * sa + buf[i + 2] * inv;
      buf[i + 3] = sa + buf[i + 3] * inv;
    }
  }
}

/** 点是否落在圆角矩形内（最近点法，四角自动成圆） */
function roundRectHit(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  return (px, py) => {
    if (px < x || px > x + w || py < y || py > y + h) return false;
    const cx = Math.min(Math.max(px, x + rr), x + w - rr);
    const cy = Math.min(Math.max(py, y + rr), y + h - rr);
    const dx = px - cx;
    const dy = py - cy;
    return dx * dx + dy * dy <= rr * rr;
  };
}

const lerp = (a, b, t) => a + (b - a) * t;

/** 画一张指定尺寸的图标，返回 RGBA8 Buffer */
function render(size) {
  const k = size / MASTER; // 以 512 为设计基准等比缩放
  const ss = size <= 64 ? 8 : 3; // 小尺寸多超采样，边缘才干净
  const surface = makeSurface(size, ss);
  const S = (v) => v * k * ss; // 设计值 -> 超采样像素

  const top = rgb(THEME.bgTop);
  const bottom = rgb(THEME.bgBottom);
  const accent = rgb(THEME.accent);
  const accentHot = rgb(THEME.accentHot);
  const cell = rgb(THEME.cell);
  const cellEdge = rgb(THEME.cellEdge);

  // 底：圆角方块 + 竖向渐变
  const pad = S(16);
  const bgH = size * ss - pad * 2;
  paint(
    surface,
    roundRectHit(pad, pad, bgH, bgH, S(104)),
    (_px, py) => {
      const t = Math.min(1, Math.max(0, (py - pad) / bgH));
      return [lerp(top[0], bottom[0], t), lerp(top[1], bottom[1], t), lerp(top[2], bottom[2], t), 1];
    },
  );

  // 3x3 矩阵格
  const inset = S(96);
  const gap = Math.max(ss, S(24)); // 小尺寸下保证至少 1 像素缝隙，不然糊成一团
  const area = size * ss - inset * 2;
  const cw = (area - gap * 2) / 3;
  const radius = cw * 0.3;
  const edge = cw * 0.085;

  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const x = inset + col * (cw + gap);
      const y = inset + row * (cw + gap);
      if ((row + col) % 2 === 0) {
        const c = row === col ? accentHot : accent;
        paint(surface, roundRectHit(x, y, cw, cw, radius), () => [c[0], c[1], c[2], 1]);
      } else {
        // 暗格：先铺描边色，再用填充色内缩一圈 -> 得到一圈细边
        paint(surface, roundRectHit(x, y, cw, cw, radius), () => [cellEdge[0], cellEdge[1], cellEdge[2], 1]);
        paint(
          surface,
          roundRectHit(x + edge, y + edge, cw - edge * 2, cw - edge * 2, Math.max(0, radius - edge)),
          () => [cell[0], cell[1], cell[2], 1],
        );
      }
    }
  }

  // 降采样：预乘空间求平均，再还原为直通 alpha
  const out = Buffer.alloc(size * size * 4);
  const n = ss * ss;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const i = ((y * ss + sy) * surface.w + (x * ss + sx)) * 4;
          r += surface.buf[i];
          g += surface.buf[i + 1];
          b += surface.buf[i + 2];
          a += surface.buf[i + 3];
        }
      }
      r /= n;
      g /= n;
      b /= n;
      a /= n;
      const o = (y * size + x) * 4;
      const inv = a > 0 ? 1 / a : 0;
      out[o] = Math.round(Math.min(255, r * inv));
      out[o + 1] = Math.round(Math.min(255, g * inv));
      out[o + 2] = Math.round(Math.min(255, b * inv));
      out[o + 3] = Math.round(Math.min(255, a) * 255);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  产出 + 自检
 * ------------------------------------------------------------------ */
mkdirSync(OUT, { recursive: true });

const masterPng = encodePng(MASTER, MASTER, render(MASTER));
writeFileSync(path.join(OUT, 'icon.png'), masterPng);

const frames = ICO_SIZES.map((size) => ({ size, png: encodePng(size, size, render(size)) }));
writeFileSync(path.join(OUT, 'icon.ico'), encodeIco(frames));

const kb = (p) => (statSync(p).size / 1024).toFixed(1);
console.log(`build/icon.png  ${MASTER}x${MASTER}  ${kb(path.join(OUT, 'icon.png'))} KB`);
console.log(`build/icon.ico  ${ICO_SIZES.join('/')}  ${kb(path.join(OUT, 'icon.ico'))} KB`);

// 自检：主图必须是 512 的 RGBA PNG，且四角透明、中心不透明（圆角与图案都画上了）
const sigOk = masterPng.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const w = masterPng.readUInt32BE(16);
const h = masterPng.readUInt32BE(20);
const master = render(MASTER);
const alphaAt = (x, y) => master[(y * MASTER + x) * 4 + 3];
const checks = [
  ['PNG 签名', sigOk],
  [`尺寸 ${w}x${h}`, w === MASTER && h === MASTER],
  ['左上角透明(圆角)', alphaAt(0, 0) === 0],
  ['中心不透明(图案)', alphaAt(256, 256) === 255],
];
let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`);
}
if (bad) process.exit(1);
