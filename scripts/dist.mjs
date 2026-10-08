#!/usr/bin/env node
/**
 * 打包入口（`npm run dist` 实际调用的就是它，而不是直接调 electron-builder）。
 *
 * 这里多做的三件事，全是「在 Windows 上会把打包卡死」的坑：
 *
 *  1. **缓存放进工程内 `.eb-cache/`**
 *     默认缓存在 `%LOCALAPPDATA%\electron-builder\Cache`，也就是 C 盘 ——
 *     本机被 Storage Sense 清过一次，缓存没了就得重新下。
 *     放到工程里（F 盘）既稳定，又可以用环境变量覆盖。
 *
 *  2. **二进制默认走 npmmirror**
 *     electron-builder 要下 nsis / winCodeSign / 7zip，默认 URL 是 github.com，
 *     国内经常拉不动（实测 ECONNRESET）。镜像可用 ELECTRON_BUILDER_BINARIES_MIRROR 覆盖。
 *
 *  3. **预解压 winCodeSign，跳过 darwin / linux**
 *     这个包里带的是 macOS 用的符号链接，而 Windows 建符号链接需要管理员权限
 *     或开发者模式 —— 于是 7za 解压必然报「Cannot create symbolic link」。
 *     在 Windows 上我们只需要 windows-10 下的 signtool/rcedit，直接排除其它平台即可。
 *
 * 用法: node scripts/dist.mjs [electron-builder 的额外参数]
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const CACHE = process.env.ELECTRON_BUILDER_CACHE || path.join(ROOT, '.eb-cache');
const MIRROR =
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
  'https://npmmirror.com/mirrors/electron-builder-binaries/';

const WINCODESIGN = { name: 'winCodeSign', version: '2.6.0' };

process.env.ELECTRON_BUILDER_CACHE = CACHE;
process.env.ELECTRON_BUILDER_BINARIES_MIRROR = MIRROR;

/* ------------------------------------------------------------------ *
 *  winCodeSign 预解压
 * ------------------------------------------------------------------ */

/** 找到 7za：优先 electron-builder 自带的 7zip-bin，其次 PATH 里的 7z。 */
function find7za() {
  try {
    const pkg = path.dirname(require.resolve('7zip-bin/package.json'));
    const candidates =
      process.platform === 'win32'
        ? ['win/x64/7za.exe', 'win/ia32/7za.exe']
        : ['linux/x64/7za', 'mac/7za'];
    for (const rel of candidates) {
      const file = path.join(pkg, rel);
      if (fs.existsSync(file)) return file;
    }
  } catch {
    /* 没装 7zip-bin 就退到 PATH */
  }
  return '7z';
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向太多'));
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(download(new URL(res.headers.location, url).href, dest, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`下载失败 HTTP ${res.statusCode}: ${url}`));
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(dest)));
        out.on('error', reject);
      })
      .on('error', reject);
  });
}

async function stageWinCodeSign() {
  const dirName = `${WINCODESIGN.name}-${WINCODESIGN.version}`;
  const dir = path.join(CACHE, WINCODESIGN.name, dirName);
  const marker = path.join(dir, 'windows-10');

  // 非 Windows：不需要（也不会遇到符号链接问题）
  if (process.platform !== 'win32') return;

  if (fs.existsSync(marker)) {
    console.log(`winCodeSign: 已就绪（${dir}）`);
    return;
  }

  // 上一次失败的构建通常已经把 .7z 下到缓存里了，先捡现成的
  const bucket = path.join(CACHE, WINCODESIGN.name);
  let archive = null;
  if (fs.existsSync(bucket)) {
    const found = fs
      .readdirSync(bucket)
      .filter((f) => f.toLowerCase().endsWith('.7z'))
      .map((f) => path.join(bucket, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    archive = found[0] || null;
  }

  if (!archive) {
    archive = path.join(bucket, `${dirName}.7z`);
    const url = `${MIRROR}${dirName}/${dirName}.7z`;
    console.log(`winCodeSign: 下载 ${url}`);
    await download(url, archive);
  } else {
    console.log(`winCodeSign: 使用已下载的压缩包 ${path.basename(archive)}`);
  }

  fs.mkdirSync(dir, { recursive: true });
  const sevenZip = find7za();
  const args = ['x', archive, `-o${dir}`, '-x!darwin', '-x!linux', '-y'];
  console.log(`winCodeSign: 解压（排除 darwin/linux）-> ${dir}`);
  const result = spawnSync(sevenZip, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `解压 winCodeSign 失败（${sevenZip} 退出码 ${result.status}）:\n${String(result.stderr || '')}`,
    );
  }
  if (!fs.existsSync(marker)) {
    throw new Error(`解压后没有找到 ${marker}，请检查缓存目录 ${dir}`);
  }
  console.log('winCodeSign: 就绪');
}

/* ------------------------------------------------------------------ *
 *  跑 electron-builder
 * ------------------------------------------------------------------ */
function electronBuilderBin() {
  const pkgPath = require.resolve('electron-builder/package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['electron-builder'];
  return path.join(path.dirname(pkgPath), rel || 'out/cli/cli.js');
}

await stageWinCodeSign();

const child = spawn(process.execPath, [electronBuilderBin(), ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: ROOT,
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 1));
