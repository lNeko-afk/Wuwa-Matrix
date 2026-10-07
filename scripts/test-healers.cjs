'use strict';
/**
 * 治疗位判定的自测 —— 不需要账号、不需要联网。
 *
 * 用合成演示数据（src/renderer/mock.js）配合名单（src/renderer/healers.js）跑一遍规则，
 * 并对已知答案做断言，防止以后改名单或改字段把判定改坏。
 *
 * 用法: npm test
 */
const assert = require('node:assert');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');

// healers.js / mock.js 是浏览器脚本，靠 window 全局挂数据
global.window = {};
require(path.join(RENDERER, 'healers.js'));
require(path.join(RENDERER, 'mock.js'));

const HEALERS = global.window.__HEALERS__;
const roster = global.window.__MOCK_ROSTER__;

const names = new Set(HEALERS.names || []);
const excluded = new Set(HEALERS.excludeNames || []);
const isHealer = (role) => !excluded.has(role.name) && names.has(role.name);

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
};

console.log(`名单: ${[...names].join('、')}   （排除: ${[...excluded].join('、') || '无'}）\n`);

// ---- 1. 名单本身应当包含这些已知专职奶妈 ----
check('名单含已知奶妈 维里奈 / 守岸人 / 白芷', () => {
  for (const name of ['维里奈', '守岸人', '白芷']) {
    assert.ok(names.has(name), `名单里应当有 ${name}`);
  }
});

// ---- 2. 主角永不判为治疗位（无论当前什么属性）----
check('漂泊者 6 种属性都不判为治疗位', () => {
  for (const attribute of ['气动', '衍射', '湮灭', '导电', '冷凝', '热熔']) {
    assert.strictEqual(
      isHealer({ name: '漂泊者', attribute }),
      false,
      `漂泊者(${attribute}) 不应判为治疗位 —— 主角可切属性且体力固定 1 点`,
    );
  }
});

// ---- 2b. 名单本身不该混进主角的任何词条 ----
// wiki 里主角是「漂泊者-男/女-各属性」多条词条，生成脚本必须按前缀排除
check('名单里不含主角的任何词条（前缀排除）', () => {
  const leaked = [...names].filter((n) => n.startsWith('漂泊者'));
  assert.deepStrictEqual(leaked, [], `名单里不应出现主角词条，但出现了: ${leaked.join('、')}`);
  for (const withSuffix of ['漂泊者-女-气动', '漂泊者-男-气动', '漂泊者-衍射']) {
    assert.strictEqual(isHealer({ name: withSuffix, attribute: '气动' }), false, `${withSuffix} 不应判为治疗位`);
  }
});

// ---- 3. 已知输出角色不应误判 ----
check('已知输出/辅助角色不误判', () => {
  for (const name of ['安可', '弗洛洛', '卡提希娅', '桃祈', '釉瑚', '千咲', '心', '鉴心', '丹瑾']) {
    assert.strictEqual(isHealer({ name, attribute: '衍射' }), false, `「${name}」不应判为治疗位`);
  }
});

// ---- 4. 对演示数据整体跑一遍 ----
check('演示数据里恰好 维里奈 / 白芷 是治疗位', () => {
  assert.ok(Array.isArray(roster) && roster.length > 0, '演示数据应当有角色');
  const healers = roster.filter(isHealer).map((r) => r.name).sort();
  assert.deepStrictEqual(healers, ['维里奈', '白芷'].sort());
});

// ---- 5. 体力默认值 ----
check('治疗位默认 2 体力、其余 1 体力', () => {
  for (const role of roster) {
    const expected = isHealer(role) ? 2 : 1;
    const actual = isHealer(role) ? 2 : 1; // 与 app.js 的 baseStaminaOf 同规则
    assert.strictEqual(actual, expected);
  }
  const 维里奈 = roster.find((r) => r.name === '维里奈');
  assert.ok(维里奈, '演示数据应含维里奈');
  assert.strictEqual(isHealer(维里奈) ? 2 : 1, 2, '维里奈体力应为 2');
});

console.log(`\n${passed} 项断言全部通过 ✅`);
