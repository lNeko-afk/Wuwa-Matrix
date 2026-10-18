#!/usr/bin/env node
/**
 * 打包后生成 dist/SHA256SUMS.txt，跟 Release 一起上传。
 *
 * 作用：让用户能核对「我下的这个安装包是不是官方发布的那一个」。
 * 被人改装后冒充发布时，这是最直接、也最经得起平台审核的举证材料。
 * （校验方法：certutil -hashfile <安装包> SHA256）
 *
 * 用法：npm run dist 会自动调用；也可单独跑 node scripts/make-checksums.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'SHA256SUMS.txt');
const WANT = /\.(exe|msi|zip|7z)$/i;

if (!existsSync(DIST)) {
  console.error('找不到 dist/ 目录，请先跑 npm run dist');
  process.exit(1);
}

const files = readdirSync(DIST)
  .filter((name) => WANT.test(name) && statSync(path.join(DIST, name)).isFile())
  .sort();

if (!files.length) {
  console.error('dist/ 里没有可校验的产物（.exe / .msi / .zip / .7z）');
  process.exit(1);
}

const lines = files.map((name) => {
  const hash = createHash('sha256').update(readFileSync(path.join(DIST, name))).digest('hex');
  return `${hash}  ${name}`;
});

writeFileSync(OUT, `${lines.join('\n')}\n`, 'utf8');
console.log(`已生成 ${path.relative(ROOT, OUT)}，共 ${files.length} 个产物：`);
for (const line of lines) console.log(`  ${line}`);
