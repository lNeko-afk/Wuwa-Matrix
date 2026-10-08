'use strict';
/**
 * Electron 主进程 —— 库街区凭据只在这一层存在。
 *
 * 安全边界:
 *  - 渲染层（页面）**永远拿不到 token/did/完整手机号**：config:load 会摘掉 credentials，
 *    登录/拉角色池都走 IPC，返回值里不含凭据。手机号只回传打码值。
 *  - 凭据在磁盘上是加密的（见 store.cjs 的 safeStorage）。
 *  - 调试钩子（WUWA_CAPTURE / WUWA_CAPTURE_JS）只在未打包时可用，
 *    且注入任意 JS 需要额外打开 WUWA_ALLOW_JS_HOOK=1 —— 打包后的发行版里是死代码。
 *  - 人机校验（极验）跑在一个**隔离的空窗口**里，主界面保持 file:// 加载，不受影响。
 */
const { app, BrowserWindow, clipboard, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Store } = require('./store.cjs');
const { KuroClient } = require('./kurobbs.cjs');

/**
 * 极验 captcha_id：来自 Kuro-API-Collection 中库街区 getSmsCode 的请求示例，
 * 2026-10-07 实测仍有效（/load 能返回挑战数据）。若官方更换，改这一处即可
 * —— 校验小窗会通过 URL 参数拿到它，保证只有一处定义。
 */
const CAPTCHA_ID = '3f7e2d848ce0cb7e7d019d621e556ce2';

let store = null;
let mainWindow = null;

/** 调试钩子只在未打包时可用（打包发行版里彻底失效）。 */
const devHooksEnabled = () => !app.isPackaged;

/**
 * 数据目录（凭据、头像缓存、导出图都在这）。
 *  - 开发态：工程内 .data/（便携 + 可检查）
 *  - 打包态：系统的 userData（%APPDATA%\wuwa-matrix）—— 安装目录可能是
 *    Program Files，写不进去（非管理员没有权限），所以不能再用 getAppPath()。
 *  - WUWA_DATA_DIR 始终最优先，便携版/测试可以指到 U 盘或临时目录。
 */
function dataDir() {
  if (process.env.WUWA_DATA_DIR) return process.env.WUWA_DATA_DIR;
  return app.isPackaged
    ? path.join(app.getPath('userData'), 'data')
    : path.join(app.getAppPath(), '.data');
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

/* ------------------------------------------------------------------ *
 *  人机校验（极验）—— 隔离小窗 + 本地回环静态服务
 *
 *  为什么需要本地 http 服务：极验只认 http(s) 源，在 file:// 下
 *  initGeetest4 会静默不回调（实测）。为了让主界面继续用 file://
 *  （头像缓存、离线特性都依赖它），把校验页单独放在一个窗口里，
 *  由一个只绑 127.0.0.1、端口随机、仅服务 src/captcha 静态文件的服务提供。
 * ------------------------------------------------------------------ */

let captchaServer = null;
let captchaPort = 0;
let captchaWindow = null;
let captchaResolve = null;

async function ensureCaptchaServer() {
  if (captchaServer) return captchaPort;
  const dir = path.join(__dirname, '..', 'captcha');
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(String(req.url || '/').split('?')[0]);
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.join(dir, rel);
    // 只允许读 captcha 目录内的文件
    if (!path.resolve(file).startsWith(path.resolve(dir))) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve); // 端口 0 = 随机可用端口，且只绑回环
  });
  captchaServer = server;
  captchaPort = server.address().port;
  return captchaPort;
}

function closeCaptchaWindow(result) {
  const resolve = captchaResolve;
  captchaResolve = null;
  if (captchaWindow && !captchaWindow.isDestroyed()) captchaWindow.close();
  captchaWindow = null;
  if (resolve) resolve(result);
}

/** 打开校验小窗，返回极验校验数据；用户取消/关窗则返回 null。 */
async function openCaptchaWindow() {
  if (captchaWindow && !captchaWindow.isDestroyed()) captchaWindow.focus();
  const port = await ensureCaptchaServer();

  return new Promise((resolve) => {
    captchaResolve = resolve;
    captchaWindow = new BrowserWindow({
      width: 420,
      height: 480,
      parent: mainWindow || undefined,
      modal: Boolean(mainWindow),
      resizable: false,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      title: '人机校验',
      backgroundColor: '#0f1117',
      webPreferences: {
        preload: path.join(__dirname, 'captcha-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    captchaWindow.on('closed', () => {
      captchaWindow = null;
      if (captchaResolve) {
        const r = captchaResolve;
        captchaResolve = null;
        r(null);
      }
    });
    captchaWindow.loadURL(`http://127.0.0.1:${port}/?captchaId=${encodeURIComponent(CAPTCHA_ID)}`);
  });
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
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 显式在 ready-to-show 时 show + focus。若不这样做，窗口可能以「未激活」的状态出现，
  // 这时页面里的 element.focus() 只会设上 DOM 焦点、光标不出现、打字无效 ——
  // 表现为「第一次点输入框没反应，第二次才行」。
  // 兜底：万一 ready-to-show 没触发，也必须把窗口显示出来，否则应用等于没启动。
  let revealed = false;
  const revealWindow = () => {
    if (revealed) return;
    revealed = true;
    win.show();
    win.focus();
  };
  win.once('ready-to-show', revealWindow);
  setTimeout(revealWindow, 3000);

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

/** 手机号脱敏：只保留前 3 后 4。渲染层只拿得到这个。 */
const maskPhone = (phone) =>
  typeof phone === 'string' && phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : '';

/** 脱敏后的账号信息 —— 这是唯一会送到渲染层的账号相关内容（含打码手机号）。 */
function publicCredStatus() {
  const c = store.credentials;
  return c && c.token
    ? {
        loggedIn: true,
        roleName: c.roleName,
        userName: c.userName,
        roleId: c.roleId,
        maskedPhone: maskPhone(c.phone),
      }
    : { loggedIn: false };
}

function registerIpc() {
  // 配置里绝不含凭据；落盘时再把主进程持有的凭据接回去，避免被渲染层覆盖掉。
  ipcMain.handle('config:load', () => {
    const data = store.all();
    const { credentials, ...safe } = data;
    // 缓存里的角色池先挂上本地头像地址, 这样热启动的第一帧渲染就无需联网。
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

  // 短信登录。
  //
  // 验证码可以由「发送验证码」按钮走极验发（见下），也可以由用户在库街区 App 里获取。
  // mobile 可以省略：界面在记住手机号后只显示打码号码、登录时只回传验证码，
  // 完整手机号由主进程补上 —— 这样手机号（PII）默认不进入渲染层。
  // 返回值也刻意不含 token 与完整手机号。
  ipcMain.handle('kuro:login', async (_event, { mobile, code } = {}) => {
    const typed = String(mobile ?? '').trim();
    const remembered = store.credentials?.phone || '';
    const useMobile = typed || remembered;
    const useCode = String(code ?? '').trim();
    if (!useMobile) throw new Error('请填写手机号');
    if (!useCode) throw new Error('验证码不能为空');

    const session = await KuroClient.loginBySms(useMobile, useCode);
    if (!session.token) throw new Error('登录接口没有返回 token');
    const bound = await KuroClient.getBoundRoles(session.token, session.did);
    const target = bound.find((r) => r.isDefault) ?? bound[0];
    if (!target) throw new Error('该账号没有绑定鸣潮角色');
    store.setCredentials({
      phone: useMobile, // 加密落盘，供下次登录自动带出
      token: session.token,
      did: session.did,
      userId: session.userId,
      userName: session.userName,
      serverId: target.serverId,
      roleId: target.roleId,
      roleName: target.roleName,
      label: target.roleName,
      boundRoles: bound.map((r) => ({ roleId: r.roleId, serverId: r.serverId, roleName: r.roleName })),
    });
    return publicCredStatus();
  });

  /**
   * 发送短信验证码：先弹极验小窗，通过后拿校验数据去调 getSmsCode。
   * mobile 可省略（沿用记住的号码）。完整手机号不出主进程。
   */
  ipcMain.handle('kuro:sendSmsCode', async (_event, { mobile } = {}) => {
    const typed = String(mobile ?? '').trim();
    const phone = typed || store.credentials?.phone || '';
    if (!phone) throw new Error('请先填手机号（第一次登录时无法自动发送）');

    const validate = await openCaptchaWindow();
    if (!validate) throw new Error('已取消人机校验');

    // 传对象即可 —— 编码由 kurobbs.cjs 里的 URLSearchParams 负责，这里再编一次会双重编码
    const rsp = await KuroClient.sendSmsCode(phone, {
      captcha_id: CAPTCHA_ID,
      lot_number: validate.lot_number,
      pass_token: validate.pass_token,
      gen_time: validate.gen_time,
      captcha_output: validate.captcha_output,
    });
    if (rsp?.data?.geeTest === true) throw new Error('人机校验没有通过，请重试');
    if (rsp?.code !== 200) throw new Error(`发送失败：code=${rsp?.code} ${rsp?.msg || ''}`.trim());
    return { ok: true, maskedPhone: maskPhone(phone) };
  });

  // 校验小窗回报
  ipcMain.handle('captcha:solved', (_event, data) => {
    closeCaptchaWindow(data || null);
    return true;
  });
  ipcMain.handle('captcha:cancel', () => {
    closeCaptchaWindow(null);
    return true;
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

  /**
   * 分享图：把渲染层里那块卡片按矩形截下来。
   * mode = 'clipboard' 复制到剪贴板；否则存成 PNG 到 <数据目录>/exports/。
   * 页面本身不滚动（body overflow: hidden），卡片又是 fixed 定位，
   * 所以 getBoundingClientRect 的视口坐标与 capturePage 的页面坐标一致。
   */
  ipcMain.handle('share:capture', async (_event, { rect, mode, suggestedName } = {}) => {
    if (!mainWindow) throw new Error('主窗口不存在');
    const area = {
      x: Math.round(Number(rect?.x) || 0),
      y: Math.round(Number(rect?.y) || 0),
      width: Math.round(Number(rect?.width) || 0),
      height: Math.round(Number(rect?.height) || 0),
    };
    if (area.width < 20 || area.height < 20) throw new Error('截图区域无效');

    const image = await mainWindow.webContents.capturePage(area);
    if (mode === 'clipboard') {
      clipboard.writeImage(image);
      return { mode: 'clipboard' };
    }

    const dir = path.join(dataDir(), 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const safe =
      String(suggestedName || 'wuwa-matrix')
        .replace(/[\\/:*?"<>|\s]+/g, '_')
        .slice(0, 60) || 'wuwa-matrix';
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const file = path.join(dir, `${safe}-${stamp}.png`);
    fs.writeFileSync(file, image.toPNG());
    return { mode: 'file', path: file, size: fs.statSync(file).size };
  });

  ipcMain.handle('share:reveal', (_event, filePath) => {
    if (typeof filePath === 'string' && filePath) shell.showItemInFolder(filePath);
    return true;
  });
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

app.on('will-quit', () => {
  if (captchaServer) {
    captchaServer.close();
    captchaServer = null;
  }
});
