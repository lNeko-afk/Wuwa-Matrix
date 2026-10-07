'use strict';
/**
 * 极简 JSON 持久化: 凭据 + 本期配置 + 配队方案, 全部落在一个文件里。
 *
 * 安全设计（这一层专门负责「凭据不泄露」）:
 *  - 库街区的 token 与 did **不以明文落盘**：用 Electron safeStorage 加密后再写。
 *    Windows 上底层是 DPAPI，密钥绑定当前操作系统账户 —— 文件被拷到别的机器
 *    或别的用户下解不开，会当作「未登录」处理。
 *  - 内存里始终是明文形态，所以上层（kurobbs.cjs）看到的字段名不变。
 *  - 渲染层永远拿不到凭据：main.cjs 的 config:load 会把它摘掉再发给页面。
 *  - 本文件所在目录（.data/）已在 .gitignore 里，连同运行时下载的头像一起排除。
 */
const fs = require('node:fs');
const path = require('node:path');
const { safeStorage } = require('electron');

const EMPTY = {
  credentials: null,
  periods: [],
  plans: {},
  settings: { activePeriodId: null },
};

/** 需要加密落盘的字段。手机号也是 PII，一并加密。 */
const SECRET_KEYS = ['token', 'did', 'phone'];

function sealSecret(plain) {
  if (plain === undefined || plain === null || plain === '') return null;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { enc: 'safeStorage', v: safeStorage.encryptString(String(plain)).toString('base64') };
    }
  } catch {
    /* 退化到明文, 由 enc 字段标识, 便于排查 */
  }
  return { enc: 'plain', v: String(plain) };
}

function unsealSecret(box) {
  if (!box) return '';
  if (typeof box === 'string') return box; // 兼容更早的明文格式
  if (box.enc === 'safeStorage') {
    try {
      return safeStorage.decryptString(Buffer.from(box.v, 'base64'));
    } catch {
      return ''; // 解不开（换机器 / 换用户 / DPAPI 失效）—— 当作未登录，让用户重登
    }
  }
  return box.v || '';
}

/** 内存形态 -> 落盘形态（把 token/did 换成密文盒子）。 */
function toDisk(creds) {
  if (!creds) return null;
  const out = { ...creds };
  for (const key of SECRET_KEYS) {
    if (key in out) {
      out[`${key}Sealed`] = sealSecret(out[key]);
      delete out[key];
    }
  }
  return out;
}

/** 落盘形态 -> 内存形态。 */
function fromDisk(creds) {
  if (!creds) return null;
  const out = { ...creds };
  for (const key of SECRET_KEYS) {
    if (`${key}Sealed` in out) {
      out[key] = unsealSecret(out[`${key}Sealed`]);
      delete out[`${key}Sealed`];
    }
  }
  return out;
}

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'wuwa-matrix.json');
    this._diskWasSealed = true;
    this.data = this._read();
    // 旧版本把 token 明文写在文件里 —— 启动时静默加密一次，不等用户操作
    if (this.data.credentials && !this._diskWasSealed) this._write();
  }

  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const merged = { ...structuredClone(EMPTY), ...parsed };
      this._diskWasSealed = Boolean(parsed.credentials?.tokenSealed);
      merged.credentials = fromDisk(merged.credentials);
      // 有凭据记录但 token 解不出来 -> 当作未登录，而不是拿半份凭据去请求
      if (merged.credentials && !merged.credentials.token) merged.credentials = null;
      return merged;
    } catch {
      return structuredClone(EMPTY);
    }
  }

  _write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const forDisk = { ...this.data, credentials: toDisk(this.data.credentials) };
    fs.writeFileSync(this.file, JSON.stringify(forDisk, null, 2), 'utf8');
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* Windows 上基本是空操作，忽略 */
    }
  }

  /** 内存形态（含明文凭据）—— 只给主进程用，不要整个发给渲染层。 */
  all() {
    return this.data;
  }

  replace(next) {
    this.data = { ...structuredClone(EMPTY), ...next };
    this._write();
    return this.data;
  }

  get credentials() {
    return this.data.credentials;
  }

  setCredentials(creds) {
    this.data.credentials = creds;
    this._write();
  }

  clearCredentials() {
    this.data.credentials = null;
    this._write();
  }
}

module.exports = { Store, toDisk, fromDisk };
