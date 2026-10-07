'use strict';
/**
 * 终焉矩阵配队台 · 渲染层
 *
 * 体力模型:
 *   默认 1 点; 判定为「治疗位」的角色默认 2 点; 二者都可被本期的手动设置覆盖。
 *   每被编入一支队伍扣 1 点 —— 想要同一角色进多支队伍, 就把它的体力调高。
 *
 * 治疗位数据来自 healers.js（库街区 wiki 突破属性判定, 见该文件注释）。
 *
 * 队伍固定 3 人（鸣潮规则）, 队伍数量不限 —— 这两个都刻意不做成设置项。
 *
 * 当 window.wuwa (preload) 不存在时进入 MOCK 模式: 用内置样例数据渲染, 便于离线预览界面。
 */

const bridge = window.wuwa || null;
const MOCK = !bridge;

const DEFAULT_STAMINA = 1;
const HEALER_STAMINA = 2;
const TEAM_SIZE = 3;
const STAMINA_CHOICES = [1, 2, 3, 4, 5, 6];

const HEALER_DATA = window.__HEALERS__ || { names: [], excludeNames: [] };
const HEALER_NAMES = new Set(HEALER_DATA.names || []);

const ATTRIBUTE_COLORS = {
  冷凝: '#5aa9e6',
  热熔: '#e8603c',
  导电: '#a86fe0',
  气动: '#3fbfa0',
  衍射: '#e6c14a',
  湮灭: '#c8497e',
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const uid = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = {
  config: null,
  roster: [],
  activeTeamId: null,
  filter: { attribute: '', weapon: '', keyword: '', onlyAvailable: false },
  cred: { loggedIn: false },
  iconMap: {},
  picker: null,
  saveTimer: null,
};

/* ------------------------------------------------------------ 本期 / 方案 */

function newPeriod(name) {
  return { id: uid('p'), name, stamina: {}, healerOverride: {}, createdAt: Date.now() };
}

/** 兼容旧数据: 把早期字段折叠掉; 补上 healerOverride。 */
function migratePeriod(period) {
  if (!period.stamina || typeof period.stamina !== 'object') {
    const base = Number(period.baseStamina ?? DEFAULT_STAMINA);
    const stamina = {};
    for (const [id, n] of Object.entries(period.bonus || {})) stamina[id] = base + Number(n || 0);
    for (const [id, n] of Object.entries(period.overrides || {})) stamina[id] = Number(n);
    period.stamina = stamina;
  }
  if (!period.healerOverride || typeof period.healerOverride !== 'object') period.healerOverride = {};
  delete period.teamSize;
  delete period.baseStamina;
  delete period.bonus;
  delete period.overrides;
  return period;
}

function newTeam(index) {
  return { id: uid('t'), name: `第 ${index} 队`, slots: Array.from({ length: TEAM_SIZE }, () => null), note: '' };
}

const periods = () => state.config.periods;

function activePeriod() {
  return periods().find((p) => p.id === state.config.settings.activePeriodId) || periods()[0] || null;
}

function planFor(periodId) {
  if (!state.config.plans[periodId]) {
    state.config.plans[periodId] = { periodId, teams: [], updatedAt: Date.now() };
  }
  return state.config.plans[periodId];
}

const activePlan = () => {
  const period = activePeriod();
  return period ? planFor(period.id) : null;
};

function ensurePeriod() {
  state.config.periods = (state.config.periods || []).map(migratePeriod);
  if (!state.config.periods.length) {
    const period = newPeriod('本期');
    state.config.periods.push(period);
    state.config.settings.activePeriodId = period.id;
  }
  if (!activePeriod()) state.config.settings.activePeriodId = state.config.periods[0].id;
  normalizePlan();
}

function normalizePlan() {
  const plan = activePlan();
  if (!plan) return;
  for (const team of plan.teams) {
    if (!Array.isArray(team.slots)) team.slots = [];
    while (team.slots.length < TEAM_SIZE) team.slots.push(null);
    if (team.slots.length > TEAM_SIZE) team.slots.length = TEAM_SIZE;
  }
}

/* ------------------------------------------------------------ 体力与定位 */

const roleById = (roleId) => state.roster.find((r) => r.roleId === String(roleId)) || null;
const nameOf = (roleId) => roleById(roleId)?.name || `#${roleId}`;

/**
 * 治疗位判定: 本期手动覆盖 > 内置名单(库街区 wiki 突破属性) > 漂泊者·气动特例。
 * 返回 { healer, manual } —— manual 表示结论是手动指定的。
 */
function healerState(roleId) {
  const role = roleById(roleId);
  if (!role) return { healer: false, manual: false };
  const override = activePeriod()?.healerOverride?.[roleId];
  if (override !== undefined) return { healer: Boolean(override), manual: true };
  // 漂泊者（主角）可自由切换属性、体力固定 1 点, 不参与判定。
  // 用前缀匹配: wiki 里主角是多条词条(漂泊者-男/女-各属性), 名字可能带后缀。
  if ((HEALER_DATA.excludeNames || []).some((ex) => role.name.startsWith(ex))) {
    return { healer: false, manual: false };
  }
  return { healer: HEALER_NAMES.has(role.name), manual: false };
}

const isHealer = (roleId) => healerState(roleId).healer;

/** 角色在「没有被手动设置过」时的默认体力。 */
const baseStaminaOf = (roleId) => (isHealer(roleId) ? HEALER_STAMINA : DEFAULT_STAMINA);

const staminaOf = (roleId) => {
  const value = activePeriod()?.stamina?.[roleId];
  return value === undefined || value === null ? baseStaminaOf(roleId) : Number(value);
};

/** 是否被手动设过体力（用于卡片上的「自定义」标记）。 */
const isCustomStamina = (roleId) => {
  const value = activePeriod()?.stamina?.[roleId];
  return value !== undefined && value !== null && Number(value) !== baseStaminaOf(roleId);
};

function setStamina(roleId, value) {
  const period = activePeriod();
  if (!period) return;
  // 设成默认值就等于没设过, 这样角色的「默认」能跟着治疗位判定走
  if (value === null || value === baseStaminaOf(roleId)) delete period.stamina[roleId];
  else period.stamina[roleId] = value;
}

function toggleHealer(roleId) {
  const period = activePeriod();
  if (!period) return;
  period.healerOverride[roleId] = !isHealer(roleId);
}

function usageMap() {
  const map = {};
  const plan = activePlan();
  if (!plan) return map;
  for (const team of plan.teams) {
    for (const roleId of team.slots) if (roleId) map[roleId] = (map[roleId] || 0) + 1;
  }
  return map;
}

/* ------------------------------------------------------------ 持久化 */

function touch() {
  const plan = activePlan();
  if (plan) plan.updatedAt = Date.now();
  if (state.saveTimer) clearTimeout(state.saveTimer);
  setSaveState('保存中…');
  state.saveTimer = setTimeout(persist, 250);
}

async function persist() {
  if (MOCK) {
    try {
      localStorage.setItem('wuwa-matrix-config', JSON.stringify(state.config));
    } catch {
      /* 忽略 */
    }
    setSaveState('已保存(预览)');
    return;
  }
  try {
    await bridge.saveConfig(state.config);
    setSaveState(`已保存 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
  } catch (err) {
    setSaveState('保存失败');
    toast(err.message, true);
  }
}

const setSaveState = (text) => {
  $('#save-state').textContent = text;
};

/* ------------------------------------------------------------ 渲染 */

function renderAll() {
  normalizePlan();
  renderTopbar();
  renderRoster();
  renderTeams();
  scheduleIcons();
}

/** 补齐本地头像缓存(主进程下载, 一次之后离线可用), 到位后重绘一次用上本地文件。 */
function scheduleIcons() {
  if (MOCK || !state.roster.length) return;
  // 全都有本地缓存了就不必再走一趟, 免得白发一轮远程请求
  const missing = state.roster.some((r) => r.icon && !r.localIcon && !state.iconMap[r.roleId]);
  if (!missing) return;
  clearTimeout(scheduleIcons._timer);
  scheduleIcons._timer = setTimeout(async () => {
    try {
      state.iconMap = await bridge.fetchIcons();
      renderRoster();
      renderTeams();
    } catch {
      /* 头像缓存失败不影响主流程 */
    }
  }, 300);
}

function renderTopbar() {
  const select = $('#period-select');
  select.innerHTML = periods()
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
    .join('');
  select.value = activePeriod()?.id || '';
  if (document.activeElement !== $('#period-name')) {
    $('#period-name').value = activePeriod()?.name || '';
  }

  $('#roster-count').textContent = `角色池 ${state.roster.length}`;
  $('#account-btn').textContent = state.cred.loggedIn ? state.cred.roleName || '已登录' : '未登录';
}

function filteredRoster() {
  const { attribute, weapon, keyword, onlyAvailable } = state.filter;
  const usage = usageMap();
  const kw = keyword.trim().toLowerCase();
  return state.roster.filter((role) => {
    if (attribute && role.attribute !== attribute) return false;
    if (weapon && role.weapon !== weapon) return false;
    if (kw && !role.name.toLowerCase().includes(kw) && !role.acronym.toLowerCase().includes(kw)) return false;
    if (onlyAvailable && staminaOf(role.roleId) - (usage[role.roleId] || 0) <= 0) return false;
    return true;
  });
}

function renderFilterOptions() {
  const attrSet = [...new Set(state.roster.map((r) => r.attribute).filter(Boolean))];
  const weaponSet = [...new Set(state.roster.map((r) => r.weapon).filter(Boolean))];
  const attrSel = $('#filter-attribute');
  const weaponSel = $('#filter-weapon');
  attrSel.innerHTML = `<option value="">全部属性</option>${attrSet.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('')}`;
  weaponSel.innerHTML = `<option value="">全部武器</option>${weaponSet.map((w) => `<option value="${esc(w)}">${esc(w)}</option>`).join('')}`;
  attrSel.value = state.filter.attribute;
  weaponSel.value = state.filter.weapon;
}

function renderRoster() {
  renderFilterOptions();
  const container = $('#roster');
  const usage = usageMap();
  const roles = filteredRoster();

  if (!state.roster.length) {
    container.innerHTML = `<p class="empty-note">还没有角色数据。点右上角「未登录」登录库街区账号，或已登录时点「刷新角色池」。</p>`;
    return;
  }
  if (!roles.length) {
    container.innerHTML = `<p class="empty-note">没有符合筛选条件的角色。</p>`;
    return;
  }

  container.innerHTML = roles
    .map((role) => {
      const cap = staminaOf(role.roleId);
      const used = usage[role.roleId] || 0;
      const left = cap - used;
      const color = ATTRIBUTE_COLORS[role.attribute] || '#5f677b';
      const staminaClass = left <= 0 ? 'is-zero' : left === 1 ? 'is-low' : '';
      return `
      <div class="role-card ${left <= 0 ? 'is-empty' : ''} ${isCustomStamina(role.roleId) ? 'is-custom' : ''}" data-role="${esc(role.roleId)}">
        ${isHealer(role.roleId) ? '<div class="healer-badge">治疗</div>' : ''}
        <div class="stamina ${staminaClass}" data-edit-stamina="${esc(role.roleId)}" title="点这里改本期体力">${left}/${cap}</div>
        <div class="role-avatar" data-avatar="${esc(role.roleId)}" data-edit-stamina="${esc(role.roleId)}" title="点这里改本期体力">${esc(role.name.slice(0, 1))}</div>
        <div class="chain-badge">${role.chain ? `${role.chain}链` : '—'}</div>
        <div class="role-name" title="${esc(role.name)}">${esc(role.name)}</div>
        <div class="role-meta">
          <span><i class="attr-dot" style="background:${color}"></i>${esc(role.attribute || '—')}</span>
          <span>${esc(role.weapon || '')}</span>
        </div>
        <div class="role-meta"><span>Lv.${role.level}</span><span>${isCustomStamina(role.roleId) ? '体力自定义' : ''}</span></div>
      </div>`;
    })
    .join('');

  hydrateAvatars(container);
}

function renderTeams() {
  const plan = activePlan();
  const container = $('#teams');
  if (!plan) return;

  const usage = usageMap();
  const totalUsed = Object.values(usage).reduce((a, b) => a + b, 0);
  $('#usage-summary').textContent = `${plan.teams.length} 队 · 已编入 ${totalUsed} 人次`;

  if (!plan.teams.length) {
    container.innerHTML = `<p class="empty-note">还没有队伍。点右上角「+ 新增队伍」开始，队伍数量不限。</p>`;
    return;
  }

  container.innerHTML = plan.teams
    .map((team, index) => {
      const overRoles = new Set(team.slots.filter((rid) => rid && (usage[rid] || 0) > staminaOf(rid)));
      const slots = team.slots
        .map((roleId, slotIndex) => {
          if (!roleId) {
            return `<div class="slot" data-team="${esc(team.id)}" data-slot="${slotIndex}"><span class="slot-empty">+ 空位</span></div>`;
          }
          const role = roleById(roleId);
          const cap = staminaOf(roleId);
          const used = usage[roleId] || 0;
          const over = used > cap;
          return `
          <div class="slot is-filled ${over ? 'is-over' : ''}" data-team="${esc(team.id)}" data-slot="${slotIndex}">
            <div class="slot-avatar" data-avatar="${esc(roleId)}">${esc((role?.name || '?').slice(0, 1))}</div>
            <div class="slot-name" title="${esc(role?.name || roleId)}">${esc(role?.name || nameOf(roleId))}</div>
            <div class="slot-tag">已用 ${used}/${cap}${over ? ' 超支' : ''}</div>
          </div>`;
        })
        .join('');

      return `
      <div class="team ${team.id === state.activeTeamId ? 'is-active' : ''} ${overRoles.size ? 'is-broken' : ''}" data-team="${esc(team.id)}">
        <div class="team-head" data-team="${esc(team.id)}" data-action="activate">
          <span class="team-index">#${index + 1}</span>
          <span class="team-name">${esc(team.name)}</span>
          <span class="pill pill-muted">${team.slots.filter(Boolean).length}/${TEAM_SIZE}</span>
          <div class="team-actions">
            <button class="icon-btn" data-team="${esc(team.id)}" data-action="clear" title="清空该队">⨯</button>
            <button class="icon-btn" data-team="${esc(team.id)}" data-action="remove" title="删除该队">🗑</button>
          </div>
        </div>
        <div class="slots">${slots}</div>
        ${overRoles.size ? `<div class="team-issue">⚠ ${[...overRoles].map(nameOf).join('、')} 的体力不足以支撑当前编入次数</div>` : ''}
      </div>`;
    })
    .join('');

  hydrateAvatars(container);
}

/** 头像走 JS 加载, 避免 CSP 禁止内联 onerror; 加载失败就保留首字占位。 */
function hydrateAvatars(root) {
  const stats = (window.__avatarStats = window.__avatarStats || { total: 0, loaded: 0, failed: 0, lastError: '' });
  $$('[data-avatar]', root).forEach((el) => {
    const role = roleById(el.dataset.avatar);
    // 本地缓存优先: 命中就完全不走网络
    const local = state.iconMap[role?.roleId] || role?.localIcon;
    const src = local || role?.icon;
    if (!src || el.dataset.loaded) return;
    el.dataset.loaded = '1';
    stats.total += 1;
    if (local) stats.cached = (stats.cached || 0) + 1;
    const img = new Image();
    img.onload = () => {
      el.textContent = '';
      el.style.backgroundImage = `url("${src}")`;
      stats.loaded += 1;
    };
    img.onerror = () => {
      stats.failed += 1;
      stats.lastError = `${role?.name} ${src}`;
    };
    img.src = src;
    // 持有引用, 防止在加载完成前被 GC 掉导致 onload 永不触发
    avatarPending.push(img);
    setTimeout(() => {
      const i = avatarPending.indexOf(img);
      if (i >= 0) avatarPending.splice(i, 1);
    }, 60000);
  });
}

const avatarPending = [];

/* ------------------------------------------------------------ 交互 */

function addRoleToTeam(roleId, teamId) {
  const plan = activePlan();
  const team = plan.teams.find((t) => t.id === teamId);
  if (!team) return;
  const usage = usageMap();
  const left = staminaOf(roleId) - (usage[roleId] || 0);
  if (left <= 0) {
    toast(`「${nameOf(roleId)}」本期体力已用尽（点头像可调高）`, true);
    return;
  }
  const slot = team.slots.findIndex((s) => !s);
  if (slot === -1) {
    toast(`「${team.name}」已满（${TEAM_SIZE} 人）`, true);
    return;
  }
  team.slots[slot] = roleId;
  state.activeTeamId = teamId;
  touch();
  renderAll();
}

function setSlot(teamId, slotIndex, roleId) {
  const plan = activePlan();
  const team = plan.teams.find((t) => t.id === teamId);
  if (!team) return;
  if (roleId) {
    const usage = usageMap();
    const alreadyInThisSlot = team.slots[slotIndex] === roleId;
    const left = staminaOf(roleId) - (usage[roleId] || 0) + (alreadyInThisSlot ? 1 : 0);
    if (left <= 0 && !alreadyInThisSlot) {
      toast(`「${nameOf(roleId)}」本期体力已用尽（点头像可调高）`, true);
      return;
    }
  }
  team.slots[slotIndex] = roleId;
  touch();
  closeModal();
  renderAll();
}

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('is-error', isError);
  el.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.add('hidden'), 2600);
}

/* ------------------------------------------------------------ 浮层 */

function openPicker(context, title) {
  state.picker = context;
  $('#modal-title').textContent = title;
  $('#modal-search').value = '';
  $('#modal-search').hidden = context.kind === 'stamina';
  // 体力编辑内容窄, 换成小弹窗, 免得右边空一大片
  $('#modal .modal-box').classList.toggle('modal-box-sm', context.kind === 'stamina');
  renderPicker();
  $('#modal').classList.remove('hidden');
  if (context.kind !== 'stamina') $('#modal-search').focus();
}

function openStaminaEditor(roleId) {
  if (!roleById(roleId)) return;
  openPicker({ kind: 'stamina', roleId }, '设置本期体力');
}

function closeModal() {
  $('#modal').classList.add('hidden');
  state.picker = null;
}

function renderPicker() {
  const body = $('#modal-body');
  const context = state.picker;

  if (context?.kind === 'stamina') {
    const role = roleById(context.roleId);
    if (!role) return;
    const cap = staminaOf(context.roleId);
    const used = usageMap()[context.roleId] || 0;
    const left = cap - used;
    const heal = healerState(context.roleId);
    const base = baseStaminaOf(context.roleId);
    body.innerHTML = `
      <div class="stamina-editor">
        <div class="stamina-editor-head">
          <div class="role-avatar" data-avatar="${esc(role.roleId)}">${esc(role.name.slice(0, 1))}</div>
          <div>
            <div class="role-name">${esc(role.name)}</div>
            <div class="slot-tag">${esc(role.attribute)} · ${esc(role.weapon)} · Lv.${role.level} · ${role.chain ? `${role.chain}链` : '未解锁链'}</div>
          </div>
        </div>
        <div class="stamina-role">
          <span>定位：<strong class="${heal.healer ? 'text-heal' : ''}">${heal.healer ? '治疗位' : '输出 / 辅助'}</strong>
            <span class="hint-inline">（${heal.manual ? '手动指定' : '按突破属性自动判定'}，默认 ${base} 体力）</span></span>
          <button class="btn btn-ghost" data-toggle-healer="1">${heal.healer ? '改为非治疗位' : '改为治疗位'}</button>
        </div>
        <p class="hint">
          本期体力 <strong>${cap}</strong>　已编入 <strong>${used}</strong> 队　剩余
          <strong class="${left < 0 ? 'text-danger' : ''}">${left}</strong>
          ${left < 0 ? '（超支：队里的编入次数多于体力，需要调高或撤掉）' : ''}
        </p>
        <div class="stamina-choices">
          ${STAMINA_CHOICES.map(
            (n) => `<button class="stamina-choice ${n === cap ? 'is-active' : ''}" data-stamina="${n}">${n}</button>`,
          ).join('')}
        </div>
        <div class="stamina-editor-foot">
          <span class="hint">默认 ${DEFAULT_STAMINA} 点 = 只能进 1 支队伍；治疗位默认 ${HEALER_STAMINA} 点。</span>
          ${cap === base ? '' : `<button class="btn btn-ghost" data-stamina-reset="1">恢复默认（${base}）</button>`}
        </div>
      </div>`;
    hydrateAvatars(body);
    return;
  }

  const keyword = $('#modal-search').value.trim().toLowerCase();
  const usage = usageMap();
  const current = context?.kind === 'slot' ? activePlan().teams.find((t) => t.id === context.teamId)?.slots[context.slotIndex] : null;

  const available = state.roster
    .filter((r) => !keyword || r.name.toLowerCase().includes(keyword))
    .map((r) => {
      const cap = staminaOf(r.roleId);
      const left = cap - (usage[r.roleId] || 0) + (r.roleId === current ? 1 : 0);
      return { role: r, cap, left };
    })
    .sort((a, b) => b.left - a.left || a.role.name.localeCompare(b.role.name, 'zh'));

  body.innerHTML = `
    ${current ? `<p class="hint">当前：<strong>${esc(nameOf(current))}</strong>　<button class="btn btn-ghost" data-clear-slot="1">清空该位</button></p>` : ''}
    <div class="picker-grid">
      ${available
        .map(
          ({ role, cap, left }) => `
        <div class="picker-item ${left <= 0 ? 'is-disabled' : ''}" data-pick="${esc(role.roleId)}">
          <div class="role-avatar" data-avatar="${esc(role.roleId)}" style="width:100%;height:auto;aspect-ratio:1;border-radius:6px">${esc(role.name.slice(0, 1))}</div>
          <div class="role-name">${esc(role.name)}</div>
          <div class="slot-tag">余力 ${left}/${cap}</div>
        </div>`,
        )
        .join('')}
    </div>`;
  hydrateAvatars(body);
}

/* ------------------------------------------------------------ 事件绑定 */

function bindEvents() {
  $('#roster').addEventListener('click', (event) => {
    const card = event.target.closest('[data-role]');
    if (!card) return;
    // 点头像 / 体力数字 => 改体力, 其余区域 => 编入当前队
    const edit = event.target.closest('[data-edit-stamina]');
    if (edit) {
      openStaminaEditor(edit.dataset.editStamina);
      return;
    }
    const plan = activePlan();
    const teamId =
      state.activeTeamId && plan.teams.some((t) => t.id === state.activeTeamId) ? state.activeTeamId : plan.teams[0]?.id;
    if (!teamId) {
      toast('请先新增一支队伍', true);
      return;
    }
    addRoleToTeam(card.dataset.role, teamId);
  });

  $('#teams').addEventListener('click', (event) => {
    const actionBtn = event.target.closest('[data-action]');
    if (actionBtn) {
      const { team, action } = actionBtn.dataset;
      const plan = activePlan();
      if (action === 'activate') {
        state.activeTeamId = team;
        renderTeams();
        return;
      }
      if (action === 'remove') {
        plan.teams = plan.teams.filter((t) => t.id !== team);
        plan.teams.forEach((t, i) => (t.name = `第 ${i + 1} 队`));
        if (state.activeTeamId === team) state.activeTeamId = plan.teams[0]?.id || null;
        touch();
        renderAll();
        return;
      }
      if (action === 'clear') {
        const target = plan.teams.find((t) => t.id === team);
        if (target) target.slots = target.slots.map(() => null);
        touch();
        renderAll();
        return;
      }
    }
    const slot = event.target.closest('[data-slot]');
    if (slot) {
      openPicker({ kind: 'slot', teamId: slot.dataset.team, slotIndex: Number(slot.dataset.slot) }, '编入角色');
    }
  });

  $('#modal-body').addEventListener('click', (event) => {
    if (event.target.closest('[data-clear-slot]') && state.picker?.kind === 'slot') {
      setSlot(state.picker.teamId, state.picker.slotIndex, null);
      return;
    }
    if (event.target.closest('[data-toggle-healer]') && state.picker?.kind === 'stamina') {
      toggleHealer(state.picker.roleId);
      touch();
      renderPicker();
      renderAll();
      return;
    }
    if (event.target.closest('[data-stamina-reset]') && state.picker?.kind === 'stamina') {
      setStamina(state.picker.roleId, null);
      touch();
      renderPicker();
      renderAll();
      return;
    }
    const choice = event.target.closest('[data-stamina]');
    if (choice && state.picker?.kind === 'stamina') {
      setStamina(state.picker.roleId, Number(choice.dataset.stamina));
      touch();
      renderPicker();
      renderAll();
      return;
    }
    const pick = event.target.closest('[data-pick]');
    if (pick && state.picker?.kind === 'slot') {
      setSlot(state.picker.teamId, state.picker.slotIndex, pick.dataset.pick);
    }
  });

  $('#modal-search').addEventListener('input', renderPicker);
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (event) => {
    if (event.target.id === 'modal') closeModal();
  });

  $('#team-add').addEventListener('click', () => {
    const plan = activePlan();
    const team = newTeam(plan.teams.length + 1);
    plan.teams.push(team);
    state.activeTeamId = team.id;
    touch();
    renderAll();
  });

  $('#inherit-btn').addEventListener('click', () => {
    const period = activePeriod();
    const index = periods().findIndex((p) => p.id === period.id);
    const prev = periods()[index - 1];
    if (!prev) {
      toast('没有上一期可以继承', true);
      return;
    }
    const prevPlan = state.config.plans[prev.id];
    if (!prevPlan?.teams?.length) {
      toast(`「${prev.name}」还没有保存过配队`, true);
      return;
    }
    const plan = activePlan();
    if (plan.teams.length && !confirm(`将用「${prev.name}」的配队覆盖本期现有 ${plan.teams.length} 支队伍，继续？`)) return;
    plan.teams = prevPlan.teams.map((t, i) => ({
      id: uid('t'),
      name: `第 ${i + 1} 队`,
      slots: [...t.slots],
      note: t.note || '',
    }));
    state.activeTeamId = plan.teams[0]?.id || null;
    touch();
    renderAll();
    const over = countOverRoles();
    toast(
      over
        ? `已继承 ${prevPlan.teams.length} 支队伍 —— 有 ${over} 个角色体力不足，已标红`
        : `已继承 ${prevPlan.teams.length} 支队伍，体力都够`,
    );
  });

  $('#period-add').addEventListener('click', () => {
    const current = activePeriod();
    const period = newPeriod(`第 ${periods().length + 1} 期`);
    // 体力与定位覆盖沿用本期; 配队不沿用(用「继承上期配队」按需拉取)
    if (current) {
      period.stamina = { ...current.stamina };
      period.healerOverride = { ...current.healerOverride };
    }
    periods().push(period);
    state.config.settings.activePeriodId = period.id;
    state.activeTeamId = null;
    touch();
    renderAll();
  });

  $('#period-select').addEventListener('change', (event) => {
    state.config.settings.activePeriodId = event.target.value;
    state.activeTeamId = null;
    touch();
    renderAll();
  });

  $('#period-name').addEventListener('input', (event) => {
    activePeriod().name = event.target.value;
    touch();
    const select = $('#period-select');
    const option = Array.from(select.options).find((o) => o.value === activePeriod().id);
    if (option) option.textContent = event.target.value;
  });

  ['#filter-attribute', '#filter-weapon'].forEach((sel) =>
    $(sel).addEventListener('change', (event) => {
      state.filter[sel === '#filter-attribute' ? 'attribute' : 'weapon'] = event.target.value;
      renderRoster();
    }),
  );
  $('#filter-keyword').addEventListener('input', (event) => {
    state.filter.keyword = event.target.value;
    renderRoster();
  });
  $('#filter-available').addEventListener('change', (event) => {
    state.filter.onlyAvailable = event.target.checked;
    renderRoster();
  });

  $('#roster-refresh').addEventListener('click', () => refreshRoster(false));
  $('#account-btn').addEventListener('click', showLogin);

  $('#login-cancel').addEventListener('click', () => $('#login-overlay').classList.add('hidden'));
  $('#login-submit').addEventListener('click', submitLogin);
  $('#login-code').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitLogin();
  });
}

function countOverRoles() {
  const usage = usageMap();
  return Object.keys(usage).filter((id) => usage[id] > staminaOf(id)).length;
}

/* ------------------------------------------------------------ 登录与同步 */

function showLogin() {
  if (state.cred.loggedIn) {
    const again = confirm(`当前账号：${state.cred.roleName || ''}\n\n确定要重新登录吗？（会顶掉本账号在其他工具上的 token）`);
    if (!again) return;
  }
  $('#login-overlay').classList.remove('hidden');
  $('#login-mobile').focus();
}

async function submitLogin() {
  const mobile = $('#login-mobile').value.trim();
  const code = $('#login-code').value.trim();
  if (!mobile || !code) {
    toast('手机号和验证码都要填', true);
    return;
  }
  const btn = $('#login-submit');
  btn.disabled = true;
  btn.textContent = '登录中…';
  try {
    state.cred = await bridge.login({ mobile, code });
    $('#login-overlay').classList.add('hidden');
    $('#login-code').value = '';
    toast('登录成功，正在拉取角色池…');
    await refreshRoster(true);
  } catch (err) {
    toast(`登录失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '登录';
  }
}

async function refreshRoster(silent) {
  if (MOCK) {
    toast('预览模式：没有连接主进程');
    return;
  }
  const btn = $('#roster-refresh');
  btn.disabled = true;
  btn.textContent = '拉取中…';
  try {
    const { roles, fetchedAt } = await bridge.fetchRoster();
    state.roster = roles;
    state.config.roster = roles;
    state.config.rosterFetchedAt = fetchedAt;
    state.cred = await bridge.credStatus();
    state.iconMap = {};
    await persist();
    renderAll();
    if (!silent) toast(`已刷新：${roles.length} 名角色`);
  } catch (err) {
    if (!silent || !state.roster.length) toast(`拉取失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '刷新角色池';
  }
}

/* ------------------------------------------------------------ 启动 */

function loadMock() {
  if (window.__MOCK_CONFIG__) return JSON.parse(JSON.stringify(window.__MOCK_CONFIG__));
  try {
    const raw = localStorage.getItem('wuwa-matrix-config');
    if (raw) return JSON.parse(raw);
  } catch {
    /* 忽略 */
  }
  const period = newPeriod('本期');
  return { credentials: null, periods: [period], plans: {}, settings: { activePeriodId: period.id }, roster: [] };
}

async function init() {
  if (MOCK) {
    state.config = loadMock();
    state.roster = window.__MOCK_ROSTER__ || [];
    state.cred = { loggedIn: true, roleName: '预览账号' };
  } else {
    state.config = await bridge.loadConfig();
    state.cred = await bridge.credStatus();
    state.roster = state.config.roster || [];
  }
  ensurePeriod();
  bindEvents();
  renderAll();

  if (!MOCK && !state.cred.loggedIn) showLogin();
  else if (!MOCK && !state.roster.length) refreshRoster(true);
}

init().catch((err) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#ef5f6b">启动失败：${esc(err.message)}</pre>`;
});
