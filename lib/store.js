'use strict';

/* =========================================================================
 * 数据持久化（JSON 文件 + 原子写入）
 *  - data/applications.json  申请记录
 *  - data/admins.json        管理员账号
 * 服务重启 / 页面刷新数据均不丢失
 * ========================================================================= */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  DATA_DIR, UPLOAD_DIR, THUMB_DIR, APP_DB_FILE, ADMIN_DB_FILE,
  STATUS, ROLES, DEFAULT_SUPER_USER, DEFAULT_SUPER_PASS, MAX_RESUBMITS,
  PERM_LIST, defaultPerms,
  URGE_COOLDOWN_MS, URGE_ALLOWED_STATUS, URGE_LOG_MAX
} = require('./config');
const { cnTime, cnDate, tsToDateStr } = require('./util');
const { hashPassword } = require('./auth');

for (const d of [DATA_DIR, UPLOAD_DIR, THUMB_DIR]) fs.mkdirSync(d, { recursive: true });

/* ---------------- 读写 ---------------- */
function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (e) { return fallback; }
}

function writeJsonAtomic(file, obj) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/* ---------------- 旧数据迁移 ---------------- */
const LEGACY_STATUS = {
  '待审核': STATUS.SUBMITTED,
  '已提交申请': STATUS.SUBMITTED,
  '审核员查看中': STATUS.VIEWING,
  '审核通过': STATUS.APPROVED,
  '审核不通过': STATUS.REJECTED,
  '审核拒绝': STATUS.REJECTED
};

function normalizeApplication(rec) {
  const a = Object.assign({}, rec);
  a.status = LEGACY_STATUS[a.status] || (Object.values(STATUS).includes(a.status) ? a.status : STATUS.SUBMITTED);
  a.workImages = Array.isArray(a.workImages) ? a.workImages.filter(u => typeof u === 'string') : [];
  a.workAudio = typeof a.workAudio === 'string' ? a.workAudio : '';
  a.referralCode = a.referralCode || '';
  a.inviterCn = a.inviterCn || '';
  a.experienceDesc = a.experienceDesc || '';
  a.otherClubName = a.otherClubName || '';
  a.qq = a.qq ? String(a.qq) : '';   // 旧数据无此字段，补空串
  a.createdAtText = a.createdAtText || '';
  // 审核相关字段
  a.reviewedAt = a.reviewedAt || null;
  a.reviewedAtText = a.reviewedAtText || '';
  a.reviewedBy = a.reviewedBy || '';
  a.recommendedDepartment = a.recommendedDepartment || '';
  a.rejectReason = a.rejectReason || '';
  a.rejectReasonCode = a.rejectReasonCode || '';
  a.viewedAt = a.viewedAt || null;
  a.viewedAtText = a.viewedAtText || '';
  a.viewedBy = a.viewedBy || '';
  /* 复审 / 退回 / 移交主审核官 */
  /* 旧数据只有 resubmitUsed 布尔标记（当时只允许 1 次复审）→ 迁移成次数 1 */
  const usedFlag = a.resubmitUsed === true;
  a.resubmitCount = typeof a.resubmitCount === 'number' && a.resubmitCount >= 0
    ? a.resubmitCount
    : (usedFlag ? 1 : 0);
  a.resubmitUsed = a.resubmitCount > 0;          // 「是否提交过复审」的展示标记
  a.resubmittedAt = a.resubmittedAt || null;
  a.resubmittedAtText = a.resubmittedAtText || '';
  a.returnReason = a.returnReason || '';
  a.returnedAt = a.returnedAt || null;
  a.returnedAtText = a.returnedAtText || '';
  a.returnedBy = a.returnedBy || '';
  a.escalatedAt = a.escalatedAt || null;
  a.escalatedAtText = a.escalatedAtText || '';
  a.escalatedBy = a.escalatedBy || '';
  /* 主审核官介入（锁定）：状态与布尔标记保持同步 */
  a.intervened = a.status === STATUS.INTERVENED;
  a.intervenedAt = a.intervenedAt || null;
  a.intervenedAtText = a.intervenedAtText || '';
  a.intervenedBy = a.intervenedBy || '';
  /* 介入前的结论（仅后台可见，用于追溯；查询页不展示） */
  a.intervenedFromStatus = a.intervenedFromStatus || '';
  a.intervenedFromText = a.intervenedFromText || '';
  a.intervenedResolvedAt = a.intervenedResolvedAt || null;
  a.intervenedResolvedAtText = a.intervenedResolvedAtText || '';
  /* 当前这份结论是不是「主审核官介入后」给出的（查询页据此把第④节点写成"主审核官同意/拒绝/退回你的申请"） */
  a.reviewedViaIntervene = a.reviewedViaIntervene === true;
  a.reviewedViaInterveneBy = a.reviewedViaInterveneBy || '';
  a.reviewedViaInterveneAtText = a.reviewedViaInterveneAtText || '';
  /* 催促审核：urge_count（次数）/ last_urge_time（最后一次催促时间）+ 催促操作日志 */
  a.urgeCount = Math.max(0, Math.floor(Number(a.urgeCount) || 0));
  a.lastUrgeAt = a.lastUrgeAt || null;
  a.lastUrgeAtText = a.lastUrgeAtText || '';
  a.urgeLog = Array.isArray(a.urgeLog) ? a.urgeLog.slice(0, URGE_LOG_MAX) : [];
  return a;
}

/* ---------------- 载入 ---------------- */
const appDb = readJson(APP_DB_FILE, { seq: 0, applications: [] });
if (!Array.isArray(appDb.applications)) appDb.applications = [];
if (typeof appDb.seq !== 'number') appDb.seq = 0;
appDb.applications = appDb.applications.map(normalizeApplication);
// 修正序号（兼容旧数据缺失 seq）
let maxSeq = appDb.seq;
for (const a of appDb.applications) {
  if (typeof a.seq !== 'number' || !a.seq) a.seq = ++maxSeq;
  else maxSeq = Math.max(maxSeq, a.seq);
}
appDb.seq = maxSeq;

const adminDb = readJson(ADMIN_DB_FILE, { admins: [] });
if (!Array.isArray(adminDb.admins)) adminDb.admins = [];

/* ---------------- 首次初始化最高权限管理员 ---------------- */
function ensureSeedAdmin() {
  const hasSuper = adminDb.admins.some(a => a.role === ROLES.SUPER);
  if (hasSuper) return null;
  const { salt, hash } = hashPassword(DEFAULT_SUPER_PASS);
  const admin = {
    id: 'ADM-' + crypto.randomBytes(6).toString('hex'),
    username: DEFAULT_SUPER_USER,
    role: ROLES.SUPER,
    salt, hash,
    note: '系统初始最高权限管理员',
    createdAt: Date.now(),
    createdAtText: cnTime(),
    createdBy: 'system',
    lastLoginAt: null,
    lastLoginAtText: ''
  };
  adminDb.admins.push(admin);
  saveAdmins();
  return admin;
}

/* ---------------- 保存 ---------------- */
function saveApps() { writeJsonAtomic(APP_DB_FILE, appDb); }
function saveAdmins() { writeJsonAtomic(ADMIN_DB_FILE, adminDb); }

/* =========================================================================
 * 复审机会规则（2026-10-01 修改版）
 *
 *   · 初审【审核拒绝】      → 1 次机会（第 1 次）
 *   · 初审【退回】          → 1 次机会（第 1 次）
 *   · 复审后【被退回】      → 额外再给 1 次机会（第 2 次）
 *   · 复审后【被拒绝】      → 直接结束，不再提供机会
 *   · 上限 2 次；用尽后按钮永久隐藏
 *
 * 只有「审核拒绝」「退回」两种状态才可能有机会；其余状态（待审核/查看中/
 * 已提交复审/已通过/已移交）一律不显示按钮。
 * ========================================================================= */
function resubmitState(rec) {
  const max = MAX_RESUBMITS;
  const count = Math.max(0, Math.floor(Number(rec && rec.resubmitCount) || 0));
  const status = rec && rec.status;
  let can = false;
  if (count < max) {
    if (status === STATUS.REJECTED) can = (count === 0);   // 复审后被拒绝 → 没有机会了
    else if (status === STATUS.RETURNED) can = true;       // 初审被退回 / 复审被退回
  }
  return {
    count,
    max,
    canResubmit: can,
    nextNo: count + 1,                                     // 下一次提交是第几次
    isLast: count + 1 >= max,                              // 下一次是不是最后一次
    /* 是否已经"永远没有机会了"（用于给用户明确交代） */
    ended: !can && (count >= max || (status === STATUS.REJECTED && count >= 1)),
    /* 用尽原因，便于前端给出准确文案 */
    reason: can ? ''
      : count >= max ? `已用完 ${max} 次复审机会`
        : (status === STATUS.REJECTED && count >= 1) ? '复审申请已被审核拒绝'
          : '当前状态不支持提交复审'
  };
}

/* =========================================================================
 * 催促审核
 *   · 只有「等待审核」状态（已提交申请 / 已提交复审申请）可以催促
 *   · 同一申请 1 小时内最多成功催促 1 次（冷却）
 *   · 一旦出了终审结果（通过 / 不通过）就永久不再接收催促
 * ========================================================================= */
/**
 * @param {object} rec 申请记录
 * @param {number} [now] 当前时间戳（测试可注入）
 */
function urgeState(rec, now) {
  const t = Number(now) || Date.now();
  const count = Math.max(0, Math.floor(Number(rec && rec.urgeCount) || 0));
  const lastAt = (rec && rec.lastUrgeAt) || null;
  const left = lastAt ? Math.max(0, (lastAt + URGE_COOLDOWN_MS) - t) : 0;
  const statusOk = !!rec && URGE_ALLOWED_STATUS.includes(rec.status);
  const terminal = !!rec && [STATUS.APPROVED, STATUS.REJECTED].includes(rec.status);
  return {
    count,
    lastAt,
    lastAtText: (rec && rec.lastUrgeAtText) || '',
    cooldownLeftMs: left,
    /* 状态允许 & 不在冷却中 → 现在可以催促 */
    allowed: statusOk && left === 0,
    statusOk,
    terminal,
    reason: statusOk ? (left > 0 ? 'cooldown' : '') : (terminal ? 'terminal' : 'status')
  };
}

/** 记录一次成功催促（调用方负责 saveApps 与日志） */
function applyUrge(rec, { ip, now } = {}) {
  const t = Number(now) || Date.now();
  rec.urgeCount = Math.max(0, Math.floor(Number(rec.urgeCount) || 0)) + 1;
  rec.lastUrgeAt = t;
  rec.lastUrgeAtText = cnTime(t);
  if (!Array.isArray(rec.urgeLog)) rec.urgeLog = [];
  rec.urgeLog.unshift({ at: t, atText: rec.lastUrgeAtText, ip: ip || '' });
  if (rec.urgeLog.length > URGE_LOG_MAX) rec.urgeLog.length = URGE_LOG_MAX;
  return rec;
}

/* =========================================================================
 * 账号停用（封禁）+ 子管理员权限
 *   字段：banned 停用状态 / bannedAt 停用开始 / banUntil 解封截止 / banReason 封禁理由
 *         perms 权限开关 { review, system, ban, intervene }
 *   到达解封日期后自动失效，无需人工操作
 * ========================================================================= */
function normalizeAdmin(a) {
  if (!a || typeof a !== 'object') return a;
  a.note = a.note || '';
  a.banned = a.banned === true;
  a.bannedAt = a.bannedAt || null;
  a.bannedAtText = a.bannedAtText || '';
  a.banUntil = a.banUntil || null;
  a.banUntilText = a.banUntilText || '';
  a.banReason = a.banReason || '';
  a.bannedBy = a.bannedBy || '';
  /* 老账号没有 perms 字段 → 补默认值（审核权限开，其余关）；超管的 perms 也存但实际不起作用 */
  a.perms = normalizePerms(a.perms);
  return a;
}
adminDb.admins.forEach(normalizeAdmin);

/** 该账号当前是否处于停用中（到期自动视为未停用） */
function banActive(a) {
  return !!(a && a.banned === true && a.banUntil && Date.now() < a.banUntil);
}

/**
 * 清理已到期的停用（到解封日期后自动解除）
 * @returns {boolean} 是否有记录被清理
 */
function clearExpiredBans() {
  let changed = false;
  for (const a of adminDb.admins) {
    if (a.banned && !(a.banUntil && Date.now() < a.banUntil)) {
      a.banned = false;
      a.bannedAt = null;
      a.bannedAtText = '';
      a.banUntil = null;
      a.banUntilText = '';
      a.banReason = '';
      a.bannedBy = '';
      changed = true;
    }
  }
  if (changed) saveAdmins();
  return changed;
}

/** 记录一次停用 */
function applyBan(a, untilTs, reason, operator) {
  a.banned = true;
  a.bannedAt = Date.now();
  a.bannedAtText = cnDate(a.bannedAt);
  a.banUntil = untilTs;
  a.banUntilText = cnDate(untilTs);
  a.banReason = reason;
  a.bannedBy = operator || '';
  return a;
}

/** 解除停用 */
function liftBan(a) {
  a.banned = false;
  a.bannedAt = null;
  a.bannedAtText = '';
  a.banUntil = null;
  a.banUntilText = '';
  a.banReason = '';
  a.bannedBy = '';
  return a;
}

/* ---------------- 子管理员权限 ---------------- */
/** 归一化权限对象：缺省用默认值（审核权限默认开），显式给出则按显式值 */
function normalizePerms(p) {
  const d = defaultPerms();
  const src = (p && typeof p === 'object') ? p : {};
  const out = {};
  for (const key of Object.keys(d)) {
    out[key] = (src[key] === undefined) ? d[key] : src[key] === true;
  }
  return out;
}

/**
 * 账号的**实际生效**权限：
 *  · 超管恒定拥有全部权限（不受 perms 字段影响，也改不掉）
 *  · 分管理员按 perms 字段，缺省走默认值
 */
function permsOf(admin) {
  const all = {};
  for (const p of PERM_LIST) all[p.key] = true;
  if (!admin) return all;                       // 未登录：由调用方决定拒绝
  if (admin.role === ROLES.SUPER) return all;
  return normalizePerms(admin.perms);
}

/** 是否具备某项权限 */
function hasPerm(admin, key) {
  return permsOf(admin)[key] === true;
}

/* ---------------- 查询辅助 ---------------- */
function findApp(id) { return appDb.applications.find(a => a.id === id) || null; }
/**
 * 按 CN 精确查找申请（大小写不敏感、忽略首尾空格）。
 *
 * ⚠️ 安全要点：这里**故意不做模糊匹配**。
 * 曾经支持模糊查询，导致任何人都能用单个常用汉字批量枚举出
 * 「谁提交了、哪个部门、通过还是被拒、拒绝理由是什么」。
 * 现在必须输入完整 CN 才能查到，配合限流可有效阻止批量探测。
 */
function findAppsByCn(cn) {
  const key = String(cn || '').trim().toLowerCase();
  if (!key) return [];
  return appDb.applications.filter(a => String(a.cn).trim().toLowerCase() === key);
}
function findAdminByUsername(username) {
  const key = String(username || '').trim().toLowerCase();
  return adminDb.admins.find(a => String(a.username).toLowerCase() === key) || null;
}
function findAdminById(id) { return adminDb.admins.find(a => a.id === id) || null; }

/** 对外输出管理员信息（绝不含 salt/hash） */
function publicAdmin(a) {
  const banned = banActive(a);
  return {
    id: a.id, username: a.username, role: a.role, note: a.note || '',
    createdAtText: a.createdAtText || '', createdBy: a.createdBy || '',
    lastLoginAtText: a.lastLoginAtText || '',
    /* 权限开关（超管恒定全开；前端据此显隐菜单与按钮） */
    perms: permsOf(a),
    isSuper: a.role === ROLES.SUPER,
    /* 停用相关（列表页展示状态标签用） */
    banned,
    bannedAtText: banned ? (a.bannedAtText || '') : '',
    banUntilText: banned ? (a.banUntilText || '') : '',
    banUntilYmd: banned ? tsToDateStr(a.banUntil) : '',   // 给 <input type="date"> 回填用
    banReason: banned ? (a.banReason || '') : '',
    bannedBy: banned ? (a.bannedBy || '') : ''
  };
}

/** 列表用摘要（不含大文本字段，减小传输体积） */
function summaryOf(a) {
  return {
    id: a.id, seq: a.seq, cn: a.cn, qq: a.qq || '', department: a.department,
    province: a.province, city: a.city,
    createdAt: a.createdAt, createdAtText: a.createdAtText,
    status: a.status,
    imageCount: (a.workImages || []).length,
    hasAudio: !!a.workAudio,
    referralCode: a.referralCode || '',
    reviewedBy: a.reviewedBy || '',
    reviewedAtText: a.reviewedAtText || '',
    recommendedDepartment: a.recommendedDepartment || '',
    rejectReason: a.rejectReason || '',
    /* 复审 / 退回 / 移交主审核官（列表标签与筛选用） */
    resubmitUsed: a.resubmitCount > 0,
    resubmitCount: a.resubmitCount || 0,
    resubmitMax: MAX_RESUBMITS,
    resubmitCan: resubmitState(a).canResubmit,
    returnReason: a.returnReason || '',
    escalated: a.status === STATUS.ESCALATED,
    /* 主审核官介入（列表标签与筛选用） */
    intervened: a.status === STATUS.INTERVENED,
    intervenedBy: (a.status === STATUS.INTERVENED || a.reviewedViaIntervene) ? (a.intervenedBy || '') : '',
    intervenedAtText: (a.status === STATUS.INTERVENED || a.reviewedViaIntervene) ? (a.intervenedAtText || '') : '',
    /* 最终结论是否由主审核官介入后给出（列表里显示"主审核官最终审核：xxx"） */
    reviewedViaIntervene: a.reviewedViaIntervene === true,
    reviewedViaInterveneBy: a.reviewedViaIntervene ? (a.reviewedViaInterveneBy || a.intervenedBy || '') : '',
    reviewedViaInterveneAtText: a.reviewedViaIntervene ? (a.reviewedViaInterveneAtText || a.reviewedAtText || '') : '',
    /* 催促审核（列表红色标签 + 「仅显示被催促过的申请」筛选用） */
    urgeCount: a.urgeCount || 0,
    urged: (a.urgeCount || 0) > 0,
    lastUrgeAtText: a.lastUrgeAtText || '',
    urgeLogCount: (a.urgeLog || []).length
  };
}

module.exports = {
  appDb, adminDb,
  saveApps, saveAdmins, ensureSeedAdmin,
  normalizeApplication, normalizeAdmin,
  findApp, findAppsByCn, findAdminByUsername, findAdminById,
  publicAdmin, summaryOf, resubmitState,
  normalizePerms, permsOf, hasPerm,
  urgeState, applyUrge,
  banActive, clearExpiredBans, applyBan, liftBan
};
