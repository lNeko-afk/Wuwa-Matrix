#!/usr/bin/env node
/**
 * 从**本机的真实账号数据**生成离线预览数据 src/renderer/mock.local.js。
 *
 * 用途：在浏览器里直接打开 src/renderer/index.html 就能看到自己的真实角色池与配队，
 *      便于调 UI；也可用来给 README 之外的内部截图。
 *
 * 这个产物含你的角色池，**已在 .gitignore 中**，不会被提交。
 * 它加载在合成的 mock.js 之后，会覆盖后者。
 *
 * 用法: npm run mock
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.WUWA_DATA_DIR || path.join(ROOT, '.data');
const SRC = path.join(DATA_DIR, 'wuwa-matrix.json');
const OUT = path.join(ROOT, 'src', 'renderer', 'mock.local.js');

if (!existsSync(SRC)) {
  console.error(`找不到 ${SRC}`);
  console.error('请先运行应用并登录一次库街区账号（角色池会随配置一起存下来）。');
  process.exit(1);
}

const cfg = JSON.parse(readFileSync(SRC, 'utf8'));
const roster = Array.isArray(cfg.roster) ? cfg.roster : [];
if (!roster.length) {
  console.error('配置里还没有角色池。请在应用里点一次「刷新角色池」。');
  process.exit(1);
}

// 刻意剥掉凭据 —— 预览数据里不出现账号凭据
const config = {
  credentials: null,
  periods: cfg.periods || [],
  plans: cfg.plans || {},
  settings: cfg.settings || {},
  roster,
  rosterFetchedAt: cfg.rosterFetchedAt || 0,
};

const banner = `/**
 * 由本机真实账号数据生成的预览数据 —— 请勿提交（已在 .gitignore 里）。
 * 生成命令: npm run mock
 */
`;

writeFileSync(OUT, `${banner}window.__MOCK_ROSTER__ = ${JSON.stringify(roster)};\nwindow.__MOCK_CONFIG__ = ${JSON.stringify(config)};\n`, 'utf8');
console.log(`已生成 ${path.relative(ROOT, OUT)}：${roster.length} 名角色，${Object.keys(config.plans).length} 期方案`);
