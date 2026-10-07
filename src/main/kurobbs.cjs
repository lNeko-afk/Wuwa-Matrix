'use strict';
/**
 * 库街区(鸣潮) API 薄客户端 —— 零第三方依赖, 只用 Node 内置 fetch。
 *
 * 事实来源: Kuro-API-Collection 接口文档 + npm 包 wuthering-waves-platform 的实测行为。
 * 自研而非依赖该包, 是为了避开其 AGPL-3.0 许可传染。
 *
 * 链路: sdkLogin(token + 40位随机 did) -> gamer/role/list(roleId+serverId)
 *       -> akiBox/requestToken(b-at) -> akiBox/refreshData(必须先刷) -> akiBox/roleData
 */

const BASE = 'https://api.kurobbs.com';
const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) KuroGameBox/2.9.1';
const VERSION = '2.9.1';

const PATHS = {
  smsCode: '/user/getSmsCode',
  login: '/user/sdkLogin',
  boundRoles: '/gamer/role/list',
  requestToken: '/aki/roleBox/requestToken',
  refreshData: '/aki/roleBox/akiBox/refreshData',
  baseData: '/aki/roleBox/akiBox/baseData',
  roleData: '/aki/roleBox/akiBox/roleData',
  roleDetail: '/aki/roleBox/akiBox/getRoleDetail',
  calabashData: '/aki/roleBox/akiBox/calabashData',
  challengeData: '/aki/roleBox/akiBox/challengeDetails',
  exploreData: '/aki/roleBox/akiBox/exploreIndex',
  towerData: '/aki/roleBox/akiBox/towerDataDetail',
  towerIndex: '/aki/roleBox/akiBox/towerIndex',
  dailyData: '/gamer/widget/game3/refresh',
};

const DEVICE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const randomDeviceCode = (n = 40) =>
  Array.from({ length: n }, () => DEVICE_CHARS[Math.floor(Math.random() * DEVICE_CHARS.length)]).join('');

let _ip = null;
async function getPublicIp() {
  if (_ip) return _ip;
  const sources = [
    async () => (await fetch('https://event.kurobbs.com/event/ip', { signal: AbortSignal.timeout(5000) })).text(),
    async () => (await (await fetch('https://api.ipify.org/?format=json', { signal: AbortSignal.timeout(5000) })).json()).ip,
  ];
  for (const src of sources) {
    try {
      const ip = String(await src()).trim();
      if (ip) return (_ip = ip);
    } catch {
      /* 换下一个来源 */
    }
  }
  return (_ip = '192.168.0.1');
}

/** 构造库街区请求头, 严格对齐社区实现。 */
async function buildHeaders(platform, { token = null, did = null, needToken = false, bat = null } = {}) {
  const h = {
    source: platform,
    'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    version: VERSION,
  };
  if (platform === 'ios') {
    h['User-Agent'] = IOS_UA;
    h.devCode = `${await getPublicIp()}, ${IOS_UA}`;
  } else {
    h['User-Agent'] = 'okhttp/3.11.0';
    h.osVersion = '35';
    h.model = 'V2243A';
    h.versionCode = '2500';
    h.channelId = '6';
    h.lang = 'zh-Hans';
    h.countryCode = 'CN';
    if (token) h.Cookie = `user_token=${token}`;
  }
  if (did) h.did = did;
  if (bat) h['b-at'] = bat;
  if (needToken && token) h.token = token;
  return h;
}

async function post(apiPath, body, headers) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body ?? {})) form.append(k, String(v));
  const res = await fetch(BASE + apiPath, { method: 'POST', headers, body: form.toString() });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`非 JSON 响应 (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
}

/** 游戏数据接口的 data 常常是「字符串化的 JSON」, 需要二次解析。 */
const parseData = (v) => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

function assertCode(rsp, okCodes, label) {
  if (!okCodes.includes(rsp?.code)) {
    const err = new Error(`${label} 失败: code=${rsp?.code} msg=${rsp?.msg}`);
    err.rsp = rsp;
    throw err;
  }
  return rsp;
}

class KuroClient {
  /** @param {{token:string, did:string, serverId:string|number, roleId:string|number}} creds */
  constructor(creds) {
    this.creds = creds;
    this.bat = null;
  }

  /** 短信登录。返回 token + did + userId(还需补 serverId/roleId)。 */
  static async loginBySms(mobile, code) {
    const did = randomDeviceCode();
    const rsp = assertCode(
      await post(PATHS.login, { mobile, code, devCode: did }, await buildHeaders('ios')),
      [200],
      '验证码登录',
    );
    return { token: rsp.data?.token, did, userId: rsp.data?.userId, userName: rsp.data?.userName };
  }

  /** 取账号绑定的鸣潮角色(拿 serverId / roleId)。 */
  static async getBoundRoles(token, did) {
    const rsp = assertCode(
      await post(PATHS.boundRoles, { gameId: 3 }, await buildHeaders('android', { token, did, needToken: true })),
      [200],
      '获取绑定角色',
    );
    return Array.isArray(rsp.data) ? rsp.data : [];
  }

  /** 换游戏访问令牌 b-at。 */
  async requestAccessToken() {
    const { token, did, serverId, roleId } = this.creds;
    const rsp = await post(
      PATHS.requestToken,
      { serverId, roleId },
      await buildHeaders('ios', { token, did, needToken: true }),
    );
    if (rsp.code === 220) throw new Error('账号 Token 已失效, 请重新登录');
    assertCode(rsp, [200, 10902], '请求游戏访问令牌');
    const data = parseData(rsp.data);
    return (this.bat = data?.accessToken || data?.token || data);
  }

  /** 刷新账号资料(每个游戏数据接口前都必须先刷)。 */
  async refresh() {
    const { token, did, serverId, roleId } = this.creds;
    const rsp = await post(
      PATHS.refreshData,
      { gameId: 3, serverId, roleId },
      await buildHeaders('ios', { token, did, bat: this.bat }),
    );
    assertCode(rsp, [200, 10902], '刷新账号资料');
    return parseData(rsp.data);
  }

  /** 调用游戏数据接口: 自动确保 b-at、自动先 refresh。 */
  async call(apiPath, body = {}, { countryCode = null } = {}) {
    const { token, did, serverId, roleId } = this.creds;
    if (!this.bat) await this.requestAccessToken();
    const payload = { gameId: 3, serverId, roleId, ...body };
    if (countryCode !== null) payload.countryCode = countryCode;

    await this.refresh();
    const rsp = await post(apiPath, payload, await buildHeaders('ios', { token, did, bat: this.bat }));
    assertCode(rsp, [200, 10902], `调用 ${apiPath}`);
    return parseData(rsp.data);
  }

  // ---- 具体接口 ----
  getRoleData() {
    return this.call(PATHS.roleData);
  }
  getBaseData() {
    return this.call(PATHS.baseData);
  }
  getCalabashData() {
    return this.call(PATHS.calabashData);
  }
  getChallengeData() {
    return this.call(PATHS.challengeData, {}, { countryCode: 1 });
  }
  getExploreData() {
    return this.call(PATHS.exploreData, {}, { countryCode: 1 });
  }
  async getTowerData() {
    const data = await this.call(PATHS.towerData);
    if (data !== null) return data;
    return this.call(PATHS.towerIndex);
  }
  getRoleDetail(characterId) {
    const { serverId, roleId } = this.creds;
    return this.call(PATHS.roleDetail, { serverId, roleId, id: characterId });
  }

  /** 日常数据走另一套(不需要 refresh, 但需要 b-at)。 */
  async getDailyData() {
    const { token, did } = this.creds;
    if (!this.bat) await this.requestAccessToken();
    const rsp = assertCode(
      await post(PATHS.dailyData, { type: '2', sizeType: '1' }, await buildHeaders('ios', { token, did, bat: this.bat })),
      [200],
      '获取日常数据',
    );
    if (rsp.data === null) throw new Error('日常数据为空, 请检查库街区数据展示开关');
    return rsp.data;
  }
}

module.exports = { KuroClient, PATHS, buildHeaders, post, parseData, assertCode, randomDeviceCode, getPublicIp };
