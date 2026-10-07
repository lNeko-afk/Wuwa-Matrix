'use strict';
/**
 * 端到端校验: 存储凭据 -> 库街区接口 -> 角色池。
 *
 * 默认只做**与账号无关**的通用校验（凭据可用、接口通、字段完整、数据自洽）。
 *
 * 如果你想额外核对「这份凭据确实是我本人的账号」，用环境变量传入期望值即可，
 * 这样账号标识不会写进仓库：
 *
 *   WUWA_EXPECT_ROLE_ID=<你的特征码> WUWA_EXPECT_ROLE_NAME=<角色名> WUWA_EXPECT_ROLE_COUNT=34 npm run verify
 *
 * 用法: node scripts/verify.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { KuroClient } = require('../src/main/kurobbs.cjs');

const DATA_DIR = process.env.WUWA_DATA_DIR || path.join(__dirname, '..', '.data');
const DATA_FILE = path.join(DATA_DIR, 'wuwa-matrix.json');

const EXPECT = {
  roleId: process.env.WUWA_EXPECT_ROLE_ID || '',
  roleName: process.env.WUWA_EXPECT_ROLE_NAME || '',
  roleCount: process.env.WUWA_EXPECT_ROLE_COUNT ? Number(process.env.WUWA_EXPECT_ROLE_COUNT) : null,
};

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });
const skip = (name, detail) => results.push({ name, ok: true, skipped: true, detail });

/**
 * 找出「整体就是一个手机号」的字段值。
 * 注意不能对整份 JSON 做 /1[3-9]\d{9}/ 子串匹配 —— token 是长 base64 串，
 * 里面很容易恰好连着 11 位数字，那样会误报。
 */
function findPhoneValue(node, at = '$') {
  if (typeof node === 'string') {
    return /^1[3-9]\d{9}$/.test(node.trim()) ? `${at} = "${node}"` : null;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const hit = findPhoneValue(node[i], `${at}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const hit = findPhoneValue(value, `${at}.${key}`);
      if (hit) return hit;
    }
  }
  return null;
}

(async () => {
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`找不到凭据文件: ${DATA_FILE}`);
    console.error('请先在工具里登录一次库街区账号，或用 WUWA_DATA_DIR 指定数据目录。');
    process.exitCode = 1;
    return;
  }

  const cfg = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const creds = cfg.credentials;

  check('凭据文件存在且已登录', Boolean(creds?.token), creds ? `token ${String(creds.token).length} 字符, did ${String(creds.did).length} 字符` : '缺失');
  check('凭据含 serverId / roleId', Boolean(creds?.serverId && creds?.roleId), `serverId=${creds?.serverId ? '有' : '缺'}, roleId=${creds?.roleId || '缺'}`);

  const phoneHit = findPhoneValue(cfg);
  check('存储文件不含手机号(无 PII)', phoneHit === null, phoneHit ? `命中 ${phoneHit}` : '没有任何「整体等于 11 位手机号」的字段值');

  if (EXPECT.roleId) check('roleId 与期望一致', String(creds.roleId) === EXPECT.roleId, `实际=${creds.roleId}`);
  else skip('roleId 与期望一致', '未设置 WUWA_EXPECT_ROLE_ID，跳过');
  if (EXPECT.roleName) check('角色名与期望一致', creds.roleName === EXPECT.roleName, `实际=${creds.roleName}`);
  else skip('角色名与期望一致', '未设置 WUWA_EXPECT_ROLE_NAME，跳过');

  const client = new KuroClient(creds);
  const bat = await client.requestAccessToken();
  check('换取 b-at 成功', Boolean(bat), `${String(bat).slice(0, 8)}… (${String(bat).length} 字符)`);

  const data = await client.getRoleData();
  const roles = Array.isArray(data?.roleList) ? data.roleList : [];
  check('拉取角色列表成功', roles.length > 0, `${roles.length} 名角色`);

  if (EXPECT.roleCount !== null) {
    check('角色数与期望一致', roles.length === EXPECT.roleCount, `${roles.length} vs ${EXPECT.roleCount}`);
  } else {
    skip('角色数与期望一致', '未设置 WUWA_EXPECT_ROLE_COUNT，跳过');
  }

  check(
    'UI 需要的字段齐全',
    roles.every((r) => r.roleName && r.attributeName && r.weaponTypeName && r.roleIconUrl),
    'roleName / attributeName / weaponTypeName / roleIconUrl 全部存在',
  );

  const sample = roles[0];
  check('抽样角色字段可读', Boolean(sample), sample ? `${sample.roleName} Lv.${sample.level} ${sample.attributeName} ${sample.weaponTypeName} ${sample.chainUnlockNum}链` : '角色列表为空');

  const chains = [...new Set(roles.map((r) => r.chainUnlockNum))].sort((a, b) => a - b);
  check('共鸣链取值非恒定(字段未被误映射)', chains.length > 1, `实际取值集合 [${chains.join(', ')}]`);

  const ids = roles.map((r) => String(r.roleId));
  check('roleId 无重复', new Set(ids).size === ids.length, `${roles.length} 条 / ${new Set(ids).size} 个唯一 id`);

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    const tag = r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL';
    console.log(`${tag}  ${r.name}  —  ${r.detail}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((err) => {
  console.error(`FAIL  验证中断: ${err.message}`);
  if (err.rsp) console.error('原始响应:', JSON.stringify(err.rsp).slice(0, 400));
  process.exitCode = 1;
});
