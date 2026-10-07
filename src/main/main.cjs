'use strict';
/**
 * Electron 主进程 —— 库街区凭据只在这一层存在。
 *
 * 安全边界:
 *  - 渲染层（页面）**永远拿不到 token/did**：config:load 会摘掉 credentials，
 *    登录/拉角色池都走 IPC，返回值里不含凭据。
 *  - 凭据在磁盘上是加密的（见 store.cjs 的 safeStorage）。
 *  - 调试钩子（WUWA_CAPTURE / WUWA_CAPTURE_JS）只在未打包时可用，
 *    且注入任意 JS 需要额外打开 WUWA_ALLOW_JS_HOOK=1 —— 打包后的发行版里是死代码。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Store } = require('./store.cjs');
const { KuroClient } = require('./kurobbs.cjs');

let store = null;
let mainWindow = null;

/** 调试钩子只在未打包时可用（打包发行版里彻底失效）。 */
const devHooksEnabled = () => !app.isPackaged;

/** 数据目录: 默认放在工程内(便携 + 可检查), 可用 WUWA_DATA_DIR 覆盖。 */
function dataDir() {
  return process.env.WUWA_DATA_DIR || path.join(app.getAppPath(), '.data');
}

const iconDir = () => path.join(dataDir(), 'icons');

const iconExt = (url) => {
  try {
    return path.extname(new URL(url).pathname) || '.png';
  } catch {
    return '.png';
  }
};

const iconPath = (role) => path.join(iconDir(), `${role.roleId}${iconExt(role.icon)}`);

/** 已缓存的头像直接给本地 file:// 地址, 避免每次启动都重新联网下载。 */
function attachCachedIcon(role) {
  if (!role.icon) return role;
  try {
    const file = iconPath(role);
    if (fs.existsSync(file) && fs.statSync(file).size >= 512) {
      return { ...role, localIcon: pathToFileURL(file).href };
    }
  } catch {
    /* 忽略, 退化为远程地址 */
  }
  return role;
}

/** 把缺失的头像下载到本地缓存。并发 8, 单张失败不影响其它。 */
async function ensureIcons(roles) {
  fs.mkdirSync(iconDir(), { recursive: true });
  const map = {};
  const queue = roles.filter((r) => r.icon);
  const worker = async () => {
    while (queue.length) {
      const role = queue.shift();
      const file = iconPath(role);
      try {
        if (!fs.existsSync(file) || fs.statSync(file).size < 512) {
          const res = await fetch(role.icon);
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length < 512) continue;
          fs.writeFileSync(file, buf);
        }
        map[role.roleId] = pathToFileURL(file).href;
      } catch {
        /* 单张失败不影响其它 */
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return map;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1180,
    minHeight: 720,
    title: '鸣潮 · 终焉矩阵配队台',
    backgroundColor: '#0f1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow = win;

  // ---- 调试钩子（仅开发态）----
  if (devHooksEnabled() && process.env.WUWA_CAPTURE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          // 注入任意 JS 需要额外显式打开 WUWA_ALLOW_JS_HOOK=1，避免被单一环境变量诱导
          if (process.env.WUWA_CAPTURE_JS && process.env.WUWA_ALLOW_JS_HOOK === '1') {
            await win.webContents
              .executeJavaScript(process.env.WUWA_CAPTURE_JS)
              .catch((err) => console.error('captureJs failed:', err.message));
            await new Promise((resolve) => setTimeout(resolve, 1200));
          }
          // 计数放在注入之后读，才能反映注入后的最终状态
          const stats = await win.webContents
            .executeJavaScript('JSON.stringify(window.__avatarStats || null)')
            .catch(() => 'null');
          console.log(`avatarStats: ${stats}`);
          const image = await win.webContents.capturePage();
          fs.writeFileSync(process.env.WUWA_CAPTURE, image.toPNG());
          console.log(`captured -> ${process.env.WUWA_CAPTURE}`);
        } catch (err) {
          console.error('capture failed:', err.message);
        }
        app.quit();
      }, Number(process.env.WUWA_CAPTURE_DELAY || 5000));
    });
  }
  return win;
}

/** 把角色原始数据裁成 UI 需要的形状。 */
function simplifyRole(r) {
  return {
    roleId: String(r.roleId),
    name: r.roleName,
    acronym: r.acronym || '',
    attribute: r.attributeName || '',
    weapon: r.weaponTypeName || '',
    star: r.starLevel ?? 0,
    level: r.level ?? 0,
    chain: r.chainUnlockNum ?? 0,
    skillLevel: r.totalSkillLevel ?? 0,
    isMain: Boolean(r.isMainRole),
    icon: r.roleIconUrl || '',
    pic: r.rolePicUrl || '',
    skin: r.roleSkin?.skinName || '',
  };
}

/** 脱敏后的账号信息 —— 这是唯一会送到渲染层的账号相关内容。 */
function publicCredStatus() {
  const c = store.credentials;
  return c && c.token
    ? { loggedIn: true, roleName: c.roleName, userName: c.userName, roleId: c.roleId }
    : { loggedIn: false };
}

function registerIpc() {
  // 配置里绝不含凭据；落盘时再把主进程持有的凭据接回去，避免被渲染层覆盖掉。
  ipcMain.handle('config:load', () => {
    const { credentials, ...safe } = store.all();
    if (Array.isArray(safe.roster)) safe.roster = safe.roster.map(attachCachedIcon);
    return safe;
  });

  ipcMain.handle('config:save', (_event, data) => {
    store.replace({ ...data, credentials: store.credentials });
    return true;
  });

  ipcMain.handle('kuro:credStatus', () => publicCredStatus());

  ipcMain.handle('kuro:logout', () => {
    store.clearCredentials();
    return true;
  });

  // 短信登录。验证码需用户自行在库街区 App 点「获取验证码」拿到(服务端发码带极验)。
  // 返回值刻意不含 token。
  ipcMain.handle('kuro:login', async (_event, { mobile, code, label }) => {
    if (!mobile || !code) throw new Error('手机号和验证码都不能为空');
    const session = await KuroClient.loginBySms(String(mobile).trim(), String(code).trim());
    if (!session.token) throw new Error('登录接口没有返回 token');
    const bound = await KuroClient.getBoundRoles(session.token, session.did);
    const target = bound.find((r) => r.isDefault) ?? bound[0];
    if (!target) throw new Error('该账号没有绑定鸣潮角色');
    store.setCredentials({
      token: session.token,
      did: session.did,
      userId: session.userId,
      userName: session.userName,
      serverId: target.serverId,
      roleId: target.roleId,
      roleName: target.roleName,
      label: label || target.roleName,
      boundRoles: bound.map((r) => ({ roleId: r.roleId, serverId: r.serverId, roleName: r.roleName })),
    });
    return publicCredStatus();
  });

  ipcMain.handle('kuro:roster', async () => {
    const creds = store.credentials;
    if (!creds?.token) throw new Error('尚未登录库街区账号');
    const client = new KuroClient(creds);
    const data = await client.getRoleData();
    if (!data || data.showToGuest === false) {
      throw new Error('角色数据未开放展示: 请在库街区 App 的数据终端里打开「对外展示」开关');
    }
    const roles = Array.isArray(data.roleList) ? data.roleList : [];
    return { roles: roles.map(simplifyRole).map(attachCachedIcon), fetchedAt: Date.now() };
  });

  // 补齐本地头像缓存; 返回 roleId -> file:// 地址。首次会联网, 之后秒回。
  ipcMain.handle('kuro:icons', async () => ensureIcons(store.all().roster || []));
}

app.whenReady().then(() => {
  store = new Store(dataDir());
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
