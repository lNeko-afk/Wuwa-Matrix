#!/usr/bin/env node
/**
 * 重新生成治疗位名单 src/renderer/healers.js
 *
 * 判据：库街区 Wiki「共鸣者」词条的**突破属性表**里，「治疗效果加成」是否带固有加成值
 *      （形如 `0%（12%）`）。这是角色固有突破属性，与玩家装了什么声骸无关，
 *      因此比扫技能文本干净得多（扫文本会把自带回血的输出角色大量误判）。
 *
 * Wiki 接口**不需要登录**，任何人都能跑。本文件是 ESM（.mjs）。
 *
 * 用法：
 *   node scripts/classify-healers.mjs          仅打印结果
 *   node scripts/classify-healers.mjs --write  直接更新 src/renderer/healers.js
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://api.kurobbs.com';
const PAGE = '/wiki/core/catalogue/item/getPage';
const DETAIL = '/wiki/core/catalogue/item/getEntryDetail';
const CATALOGUE_ROLE = '1105'; // 共鸣者

/** 主角可自由切换属性、体力固定 1 点，不参与判定。 */
const EXCLUDE_NAMES = ['漂泊者'];

async function wiki(apiPath, body) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body || {})) form.append(k, String(v));
  const res = await fetch(BASE + apiPath, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', wiki_type: '9' },
    body: form.toString(),
  });
  return res.json();
}

const strip = (html) =>
  String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' | ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s*\|\s*(\|\s*)+/g, ' | ')
    .replace(/\s+/g, ' ')
    .trim();

const HEAL_ASCENSION = /治疗效果加成\s*\|\s*[\d.]+%\s*[（(]/;

function renderModule(names) {
  return `/**
 * 治疗位名单（数据，不是逻辑）。
 *
 * 判据：库街区 Wiki「共鸣者」词条的**突破属性表**里，「治疗效果加成」是否带固有加成值
 *      （形如 \`0%（12%）\`）。这是角色固有突破属性，与玩家装了什么声骸无关。
 *
 * 重新生成：node scripts/classify-healers.mjs --write
 *
 * 注意：新版本出新角色后重跑一次即可。个别判错不用改这里 ——
 *      在工具里点头像 →「改为治疗位 / 改为非治疗位」会写入本期的手动覆盖。
 */
window.__HEALERS__ = {
  source: '库街区 Wiki 共鸣者词条 · 突破属性含固有「治疗效果加成」',
  names: ${JSON.stringify(names, null, 2).replace(/\n/g, '\n  ')},
  // 特例：漂泊者（主角）可以在多个属性之间自由切换，体力固定 1 点，
  // 所以不参与治疗位判定（否则「气动版算、其它版不算」会随切属性乱跳）。
  excludeNames: ${JSON.stringify(EXCLUDE_NAMES)},
};
`;
}

const page = await wiki(PAGE, { catalogueId: CATALOGUE_ROLE, limit: 1000 });
const records = page?.data?.results?.records || [];
const names = [];

for (const record of records) {
  const linkId = record.content?.linkId;
  if (!linkId) continue;
  try {
    const detail = await wiki(DETAIL, { id: linkId });
    const text = (detail?.data?.content?.modules?.[0]?.components || [])
      .flatMap((c) => c.tabs || [])
      .map((t) => strip(t.content))
      .join(' ');
    // 用前缀匹配：wiki 里主角是多条词条（漂泊者-男/女-各属性），名字并不是「漂泊者」本身
    const isExcluded = EXCLUDE_NAMES.some((ex) => record.name.startsWith(ex));
    if (HEAL_ASCENSION.test(text) && !isExcluded) names.push(record.name);
  } catch {
    /* 单个词条失败不影响整体 */
  }
}

console.log(`共鸣者词条 ${records.length} 条 → 治疗位 ${names.length} 个`);
console.log(names.join('、'));

if (process.argv.includes('--write')) {
  const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'healers.js');
  writeFileSync(out, renderModule(names), 'utf8');
  console.log(`\n已写入 ${path.relative(process.cwd(), out)}`);
} else {
  console.log('\n（加 --write 可直接更新 src/renderer/healers.js）');
}
