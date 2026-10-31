'use strict';

/* =========================================================================
 * 示例动漫社 · 入社申请审核系统 —— 服务端入口
 *
 *   用户填写端   :  /
 *   审核状态查询 :  /status
 *   审核管理后台 :  /admin
 *
 * 启动：node server.js    （默认端口 3000，可用环境变量 PORT 覆盖）
 * 数据：data/applications.json、data/admins.json、data/uploads/
 * ========================================================================= */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cfg = require('./lib/config');
const { cnTime, cnDate, dateStrToTs, tsToDateStr, str, safeEqual, sendJson, httpError } = require('./lib/util');
const store = require('./lib/store');
const auth = require('./lib/auth');
const system = require('./lib/system');
const reviewState = require('./lib/review-state');
const formConfig = require('./lib/form-config');
const { validateApplication, validateReview } = require('./lib/validate');
const { probeDuration } = require('./lib/audio-duration');
const { buildExportBuffer } = require('./lib/export-xlsx');

const { STATUS, STATUS_LABEL_ADMIN, STATUS_LABEL_PUBLIC, ROLES, WORK_RULES, REJECT_REASONS } = cfg;

/* ---------------- 首次初始化默认最高权限管理员 ---------------- */
const seeded = store.ensureSeedAdmin();

/* ---------------- 启动时补记：上一次重启请求是否真的把机器重启了 ----------------
 * 判断依据：本次开机时间晚于（或几乎等于）该请求时间 → 说明重启确实发生了。
 * 这样「系统设置」页上的「上次实际重启」才不会永远空着。 */
(function noteActualReboot() {
  try {
    const log = system.readLog();
    const last = log.lastRequest;
    if (!last || last.dryRun) return;
    const bootAt = Date.now() - require('os').uptime() * 1000;
    if (bootAt >= last.at - 5000 && (!log.lastActualReboot || log.lastActualReboot.at !== last.at)) {
      system.recordActualReboot(last);
      console.log(`[系统] 检测到服务器已于 ${cnTime(bootAt)} 完成重启（来源：${last.mode === 'manual' ? '手动' : '定时'}）`);
    }
  } catch (e) { /* 审计失败不影响启动 */ }
})();

/* =========================================================================
 * 静态资源
 * ========================================================================= */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
};

const PAGES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/status': 'status.html',
  '/status.html': 'status.html',
  '/admin': 'admin.html',
  '/admin.html': 'admin.html'
};

const INDEX_FILE = path.join(cfg.PUBLIC_DIR, 'index.html');

/** 填写页模板 + config/form.json 渲染出的题目（每次请求读取，改配置后刷新即生效） */
function renderIndexHtml() {
  const tpl = fs.readFileSync(INDEX_FILE, 'utf8');
  const sections = formConfig.sectionsHtml();
  return tpl
    .replace(/^[ \t]*<!--FORM_FIELDS-->/m, () => sections)
    .replace(/\{\{FIELD_COUNT\}\}/g, String(formConfig.fieldCount()));
}

function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  return (p === base || p.startsWith(base + path.sep)) ? p : null;
}

function serveStatic(req, res, pathname, u) {
  let fp;
  if (PAGES[pathname]) fp = path.join(cfg.PUBLIC_DIR, PAGES[pathname]);
  else if (pathname.startsWith('/uploads/')) {
    /* 上传附件不再公开可读：必须携带有效且未过期的 HMAC 签名
       （即使链接外泄，也会在有效期内自动失效，无法被长期利用） */
    let name = '';
    try { name = path.basename(decodeURIComponent(pathname.slice('/uploads/'.length))); } catch (e) { name = ''; }
    if (!verifyAssetUrl(name, u.searchParams.get('e'), u.searchParams.get('s'))) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('403 · 附件链接无效或已过期');
    }
    fp = safeJoin(cfg.UPLOAD_DIR, name);
  } else {
    try { fp = safeJoin(cfg.PUBLIC_DIR, decodeURIComponent(pathname)); }
    catch (e) { fp = null; }
  }
  if (!fp) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Forbidden'); }

  let stat = null;
  try { stat = fs.statSync(fp); } catch (e) { /* 不存在 */ }
  if (stat && stat.isDirectory()) {
    fp = path.join(fp, 'index.html');
    try { stat = fs.statSync(fp); } catch (e) { stat = null; }
  }
  if (!stat || !stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<meta charset="utf-8"><h2>404 · 页面不存在</h2><p><a href="/">返回入社申请表</a></p>');
  }

  /* 填写页：把 <!--FORM_FIELDS--> 换成 config/form.json 渲染出的题目 */
  if (fp === INDEX_FILE) {
    let html;
    try {
      html = renderIndexHtml();
    } catch (e) {
      console.error('[表单配置] 渲染失败：', e.message);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('500 · 表单配置读取失败：' + e.message);
    }
    const buf = Buffer.from(html, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache'
    });
    return res.end(buf);
  }

  const type = MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      let start, end;
      if (!m[1]) { const n = parseInt(m[2], 10); start = Math.max(0, stat.size - n); end = stat.size - 1; }
      else { start = parseInt(m[1], 10); end = m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1; }
      if (start <= end && start < stat.size) {
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Cache-Control': 'no-cache'
        });
        return fs.createReadStream(fp, { start, end }).pipe(res);
      }
    }
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache'
  });
  return fs.createReadStream(fp).pipe(res);
}

/* =========================================================================
 * 请求辅助
 * ========================================================================= */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', c => {
      total += c.length;
      if (total > limit) {
        reject(httpError('请求体超出大小限制', 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const buf = await readBody(req, limit || cfg.MAX_JSON_SIZE);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch (e) { throw httpError('请求数据格式错误（应为 JSON）', 400); }
}

/**
 * 取客户端真实 IP（用于限流）。
 *
 * ⚠️ 安全要点：必须取 X-Forwarded-For 的「最右侧」值，不能取最左侧。
 * 因为最左侧是客户端可以随意伪造的；nginx 会把真实 $remote_addr 追加/写在最后。
 * 曾经取 [0] 导致「轮换伪造 XFF 即可完全绕过限流」，登录防爆破形同虚设。
 */
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) {
    const parts = String(xf).split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  const real = req.headers['x-real-ip'];
  if (real) return String(real).trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* 简单内存限流：防刷接口（状态查询 / 提交） */
const rateBuckets = new Map();
function pruneBuckets(now) {
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) if (now > v.reset) rateBuckets.delete(k);
  }
}
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; rateBuckets.set(key, b); }
  b.count++;
  pruneBuckets(now);
  return b.count <= max;
}
/* 只读检查 / 记账：用于“失败才计数”的场景（如登录），成功请求不消耗配额 */
function rateExceeded(key, max) {
  const b = rateBuckets.get(key);
  if (!b || Date.now() > b.reset) return false;
  return b.count >= max;
}
function rateHit(key, windowMs) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; rateBuckets.set(key, b); }
  b.count++;
  pruneBuckets(now);
  return b.count;
}

/* =========================================================================
 * 附件访问签名
 *  上传目录不再公开可读：链接必须带 HMAC 签名且未过期。
 *  这样即使链接外泄（浏览器历史 / 截图 / 日志），也会在有效期内自动失效。
 * ========================================================================= */
function signAssetUrl(url, ttlMs) {
  if (!url || typeof url !== 'string') return url;
  const i = url.indexOf('/uploads/');
  if (i < 0) return url;
  const name = path.basename(url.slice(i + '/uploads/'.length).split('?')[0]);
  if (!name) return url;
  const exp = Date.now() + (ttlMs || cfg.ADMIN_ASSET_TTL_MS);
  const sig = auth.hmacHex(`${name}|${exp}`, 32);
  return `/uploads/${name}?e=${exp}&s=${sig}`;
}

function verifyAssetUrl(name, e, s) {
  const exp = Number(e);
  if (!name || !exp || !s) return false;
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  return safeEqual(auth.hmacHex(`${name}|${exp}`, 32), String(s));
}

/** 批量给申请记录里的附件链接签名（返回浅拷贝，不改动库里的原始数据） */
function withSignedAssets(rec, ttlMs) {
  if (!rec) return rec;
  const ttl = ttlMs || cfg.ADMIN_ASSET_TTL_MS;
  const out = Object.assign({}, rec);
  if (Array.isArray(rec.workImages)) {
    out.workImages = rec.workImages.map(u => signAssetUrl(u, ttl));
  }
  if (rec.workAudio) out.workAudio = signAssetUrl(rec.workAudio, ttl);
  return out;
}

/** 复审身份校验：CN + QQ号 都必须与本条申请一致 */
function verifyOwner(rec, cn, qq) {
  if (!rec || !cn || !qq) return false;
  const okCn = safeEqual(String(rec.cn).trim().toLowerCase(), String(cn).trim().toLowerCase());
  const okQq = safeEqual(String(rec.qq || ''), String(qq).trim());
  return okCn && okQq;
}

/* =========================================================================
 * 上传滥用防护：磁盘余量 / 目录总量 / 图片像素上限
 * ========================================================================= */
let uploadSizeCache = { at: 0, bytes: 0 };

function uploadsBytes() {
  const now = Date.now();
  if (now - uploadSizeCache.at < 60 * 1000) return uploadSizeCache.bytes;
  let total = 0;
  try {
    for (const f of fs.readdirSync(cfg.UPLOAD_DIR)) {
      try { total += fs.statSync(path.join(cfg.UPLOAD_DIR, f)).size; } catch (e) { /* 忽略 */ }
    }
  } catch (e) { /* 忽略 */ }
  uploadSizeCache = { at: now, bytes: total };
  return total;
}

function freeDiskBytes() {
  try {
    if (typeof fs.statfsSync !== 'function') return Number.MAX_SAFE_INTEGER;
    const st = fs.statfsSync(cfg.DATA_DIR);
    return st.bavail * st.bsize;
  } catch (e) { return Number.MAX_SAFE_INTEGER; }
}

function humanSize(n) {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + 'GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(0) + 'MB';
  return Math.round(n / 1024) + 'KB';
}

/** 解析图片真实像素尺寸（防止"解压炸弹"图片撑爆内存） */
function imageDimensions(buf, ext) {
  try {
    if (ext === 'png') {
      if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (ext === 'jpg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
        if (marker === 0xFF) { i++; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) return null;
        // SOF0-3 / SOF5-7 / SOF9-11 / SOF13-15 携带尺寸
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch (e) { /* 解析失败按未知处理 */ }
  return null;
}

/* 文件魔数校验 */
function sniff(buf, ext) {  if (buf.length < 12) return false;
  if (ext === 'png') return buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG';
  if (ext === 'jpg' || ext === 'jpeg') return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  if (ext === 'wav') return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';
  if (ext === 'mp3') {
    if (buf.toString('ascii', 0, 3) === 'ID3') return true;
    return buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0;
  }
  return false;
}

/* =========================================================================
 * 鉴权
 * ========================================================================= */
function currentAdmin(req, u) {
  const h = req.headers['authorization'] || '';
  let token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) token = u.searchParams.get('token') || '';
  const payload = auth.verifyToken(token);
  if (!payload) return null;
  const admin = store.findAdminById(payload.sub);
  if (!admin) return null;                       // 账号已被删除
  if (String(admin.username).toLowerCase() !== String(payload.u).toLowerCase()) return null;
  if (store.banActive(admin)) return null;       // 账号已被停用：令牌立即失效，踢出登录态
  return admin;
}

/* =========================================================================
 * 业务逻辑
 * ========================================================================= */
function applicationSummary(a) {
  const s = store.summaryOf(a);
  s.statusLabel = STATUS_LABEL_ADMIN[a.status] || a.status;
  return s;
}

/** 列表筛选（部门 / 状态 / CN 模糊搜索 / 仅被催促过的） */
function filterApplications(list, { department, status, q, urged }) {
  let out = list;
  if (department) out = out.filter(a => a.department === department);
  if (status) out = out.filter(a => a.status === status);
  if (urged) out = out.filter(a => (a.urgeCount || 0) > 0);
  if (q) {
    const key = String(q).trim().toLowerCase();
    if (key) out = out.filter(a => String(a.cn).toLowerCase().includes(key));
  }
  return out;
}

function statsOf(list) {
  const s = {
    total: list.length, submitted: 0, viewing: 0, approved: 0,
    rejected: 0, returned: 0, resubmitted: 0, escalated: 0, intervened: 0
  };
  for (const a of list) {
    if (s[a.status] !== undefined) s[a.status]++;
  }
  return s;
}

/**
 * 该管理员是否能看到这条申请。
 *  · 已移交主审核官的：只有超管可见（分管理员连列表都看不到）
 *  · 主审核官介入中的：分管理员**可以查看内容**（需求要求"仅能查看内容"），
 *    但不能做任何审核操作（见 canReviewApp）
 */
function canView(admin, rec) {
  if (rec.status === STATUS.ESCALATED && admin.role !== ROLES.SUPER) return false;
  return true;
}

/** 该申请是否处于「主审核官介入」锁定中 */
function isIntervened(rec) {
  return !!rec && rec.status === STATUS.INTERVENED;
}

/**
 * 能否审核这条申请（后端唯一判定，前端只按返回的 canReview 渲染/置灰）：
 *  · 常规待处理状态（待审核 / 查看中 / 复审待审核） → 需要【审核权限】
 *  · 主审核官介入中 → 需要【主审核官介入权限】（其他人按钮置灰）
 *  · 已移交主审核官 → 仅超管
 */
function canReviewApp(admin, rec) {
  if (!admin || !rec) return false;
  const p = store.permsOf(admin);
  if (rec.status === STATUS.INTERVENED) return p.intervene === true;
  if (rec.status === STATUS.ESCALATED) return admin.role === ROLES.SUPER;
  if (cfg.REVIEWABLE.includes(rec.status)) return p.review === true;
  return false;
}

/** 能否【审核介入】：需要介入权限，且当前不是已介入状态 */
function canIntervene(admin, rec) {
  if (!admin || !rec) return false;
  return store.permsOf(admin).intervene === true && !isIntervened(rec);
}

/**
 * 应用「停用 / 解封」（/ban 与 /settings 共用同一套规则）
 * @returns {{error?:string, code?:number}} 无 error 表示成功
 */
function applyBanBody(actor, target, body, enabled) {
  if (!enabled) {
    store.liftBan(target);
    return {};
  }
  if (target.role === ROLES.SUPER) return { code: 403, error: '最高权限管理员账号不可停用' };
  const untilStr = str(body.until, 20);
  const untilTs = dateStrToTs(untilStr);
  if (!Number.isFinite(untilTs)) return { code: 400, error: '请选择解封日期' };
  const todayStart = dateStrToTs(tsToDateStr(Date.now()));
  const minUntil = todayStart + 24 * 60 * 60 * 1000;   // 至少从明天起（东八区，无夏令时）
  if (untilTs < minUntil) return { code: 400, error: '解封日期必须是未来的日期（至少为明天）' };
  const reason = str(body.reason, 200);
  if (!reason) return { code: 400, error: '请填写封禁理由' };
  store.applyBan(target, untilTs, reason, actor.username);
  return {};
}

/**
 * 公开状态文案。
 * 「退回」分两种说法（需求修改版）：
 *   · 初审被退回        → 该申请表被退回
 *   · 复审申请被退回    → 复审申请被退回（对应节点文案「复审申请被管理员退回」）
 */
function publicStatusLabel(a) {
  if (a.status === STATUS.RETURNED && (a.resubmitCount || 0) > 0) return '复审申请被退回';
  return STATUS_LABEL_PUBLIC[a.status] || a.status;
}

/** 复审被拒时给申请人的准确说明（区分"次数用尽"和"复审被拒绝"） */
function resubmitDenyText(rec, rs) {
  if (rs.count >= rs.max) {
    return `该申请已用完 ${rs.max} 次复审机会，无法再次提交复审`;
  }
  if (rec.status === STATUS.REJECTED && rs.count >= 1) {
    return '该申请提交复审后已被审核拒绝，不再提供复审机会';
  }
  return `当前状态（${publicStatusLabel(rec)}）不支持提交复审`;
}

/** 用户端状态查询结果（不泄露审核人身份等内部信息） */
function publicStatusView(a) {
  const rs = store.resubmitState(a);
  const v = {
    id: a.id,
    cn: a.cn,
    department: a.department,
    submittedAt: a.createdAtText || '',
    status: a.status,
    statusLabel: publicStatusLabel(a),
    /* 复审相关 */
    resubmitUsed: rs.count > 0,
    isResubmit: rs.count > 0,
    resubmitCount: rs.count,
    resubmitMax: rs.max,
    resubmitNextNo: rs.nextNo,
    resubmitIsLast: rs.isLast,
    resubmitEnded: rs.ended,
    resubmitReason: rs.reason,
    canResubmit: rs.canResubmit
  };
  if (rs.count > 0) v.resubmittedAt = a.resubmittedAtText || '';
  if (a.status === STATUS.APPROVED) {
    v.recommendedDepartment = a.recommendedDepartment || a.department;
    v.reviewedAt = a.reviewedAtText || '';
  }
  if (a.status === STATUS.REJECTED) {
    v.rejectReason = a.rejectReason || '';
    v.reviewedAt = a.reviewedAtText || '';
  }
  if (a.status === STATUS.RETURNED) {
    v.returnReason = a.returnReason || '';
    v.reviewedAt = a.reviewedAtText || '';
  }
  if (a.status === STATUS.VIEWING) v.viewedAt = a.viewedAtText || '';
  if (a.status === STATUS.ESCALATED) v.escalatedAt = a.escalatedAtText || '';
  if (a.status === STATUS.INTERVENED) v.intervenedAt = a.intervenedAtText || '';
  /* 这份最终结论是不是「主审核官介入后」给出的：
     查询页第 ④ 节点据此显示 主审核官同意 / 拒绝 / 退回你的申请 */
  v.finalByIntervene = a.reviewedViaIntervene === true;
  if (v.finalByIntervene) {
    v.intervenedAt = v.intervenedAt || a.intervenedAtText || '';
    v.finalAt = a.reviewedViaInterveneAtText || a.reviewedAtText || '';
  }
  /* 催促审核：次数 + 当前是否可催促（前端据此显示/置灰按钮） */
  const us = store.urgeState(a);
  v.urgeCount = us.count;
  v.lastUrgeAt = us.lastAtText;
  v.urgeAllowed = us.allowed;
  v.urgeCooldownLeftMs = us.cooldownLeftMs;
  v.urgeCooldownLeftText = us.cooldownLeftMs > 0
    ? `${Math.ceil(us.cooldownLeftMs / 60000)} 分钟`
    : '';
  if (us.terminal) v.urgeEnded = true;
  return v;
}

/* =========================================================================
 * API 路由
 * ========================================================================= */
async function handleApi(req, res, u, p) {
  const method = req.method;
  let m;   // 路径正则匹配结果（在函数内多处复用，统一在此声明）

  /* ---------------- 健康检查 ---------------- */
  if (p === '/api/health' && method === 'GET') {
    return sendJson(res, 200, {
      ok: true, time: cnTime(),
      total: store.appDb.applications.length,
      admins: store.adminDb.admins.length
    });
  }

  /* ---------------- 公开配置（前端可用选项） ---------------- */
  if (p === '/api/meta' && method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      departments: cfg.DEPARTMENTS,
      genders: cfg.GENDERS,
      workRules: WORK_RULES,
      rejectReasons: REJECT_REASONS,
      maxImages: cfg.MAX_IMAGES_PER_QUESTION,
      minAudioSeconds: cfg.MIN_AUDIO_SECONDS,
      statusLabelsAdmin: STATUS_LABEL_ADMIN,
      statusLabelsPublic: STATUS_LABEL_PUBLIC,
      workHours: '9:00-23:59',
      /* 题目字段表：前端据此收集 / 校验 / 回填配置里新增的字段 */
      form: formConfig.publicFields()
    });
  }

  /* ---------------- 文件上传（原始二进制，免 multipart 依赖） ---------------- */
  if (p === '/api/upload' && method === 'POST') {
    if (!rateLimit('up:' + clientIp(req), cfg.UPLOAD_RATE_PER_MIN, 60 * 1000)) {
      return sendJson(res, 429, { ok: false, error: '上传过于频繁，请稍后再试' });
    }
    /* 磁盘保护：目录总量上限 + 剩余空间下限，防止被刷满导致服务崩溃 */
    const used = uploadsBytes();
    if (used > cfg.MAX_UPLOAD_TOTAL_BYTES) {
      console.error(`[上传] 已拒绝：上传目录已达上限 ${humanSize(used)}`);
      return sendJson(res, 507, {
        ok: false,
        error: `服务器附件存储已达上限（${humanSize(cfg.MAX_UPLOAD_TOTAL_BYTES)}），请联系管理员清理后再试`
      });
    }
    const free = freeDiskBytes();
    if (free < cfg.MIN_FREE_DISK_BYTES) {
      console.error(`[上传] 已拒绝：磁盘剩余仅 ${humanSize(free)}`);
      return sendJson(res, 507, { ok: false, error: '服务器磁盘空间不足，暂时无法接收上传，请联系管理员' });
    }

    const kind = u.searchParams.get('kind');
    let ext = (u.searchParams.get('ext') || '').toLowerCase().replace(/^\./, '');
    if (ext === 'jpeg') ext = 'jpg';
    let limit;
    if (kind === 'image' && ['jpg', 'png'].includes(ext)) limit = cfg.MAX_IMAGE_SIZE;
    else if (kind === 'audio' && ['mp3', 'wav'].includes(ext)) limit = cfg.MAX_AUDIO_SIZE;
    else return sendJson(res, 400, { ok: false, error: '不支持的文件类型（图片仅支持 jpg/png，音频仅支持 mp3/wav）' });

    const buf = await readBody(req, limit + 1);
    if (buf.length > limit) {
      return sendJson(res, 413, { ok: false, error: `文件超出大小限制（最大 ${Math.round(limit / 1024 / 1024)}MB）` });
    }
    if (buf.length === 0) return sendJson(res, 400, { ok: false, error: '文件内容为空' });
    if (!sniff(buf, ext)) {
      return sendJson(res, 400, { ok: false, error: '文件内容与格式不符，请确认是真实的 jpg/png 图片或 mp3/wav 音频' });
    }

    /* 图片像素上限：防止"解压炸弹"图片在生成缩略图时撑爆内存 */
    if (kind === 'image') {
      const dim = imageDimensions(buf, ext);
      if (dim) {
        if (dim.w > cfg.MAX_IMAGE_EDGE || dim.h > cfg.MAX_IMAGE_EDGE || dim.w * dim.h > cfg.MAX_IMAGE_PIXELS) {
          return sendJson(res, 400, {
            ok: false,
            error: `图片尺寸过大（${dim.w}×${dim.h}），请压缩后再上传`
          });
        }
      }
    }

    /* 音频时长校验（CV 部要求 ≥15 秒） */
    let duration = null;
    if (kind === 'audio') {
      const probe = probeDuration(buf, ext);
      if (probe.ok) {
        duration = Math.round(probe.seconds * 10) / 10;
        if (probe.seconds < cfg.MIN_AUDIO_SECONDS) {
          return sendJson(res, 400, {
            ok: false,
            error: `录音时长不足：当前约 ${duration} 秒，要求不少于 ${cfg.MIN_AUDIO_SECONDS} 秒`
          });
        }
      } else {
        console.warn('[上传] 音频时长无法解析，交由前端校验：', probe.reason);
      }
    }

    const id = Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex');
    const name = `${id}.${ext}`;
    fs.writeFileSync(path.join(cfg.UPLOAD_DIR, name), buf);
    uploadSizeCache.at = 0;   // 失效缓存，让下一次上传重新统计
    /* 返回带签名的临时预览链接（未签名链接无法访问） */
    return sendJson(res, 200, {
      ok: true,
      url: signAssetUrl('/uploads/' + name, cfg.UPLOAD_URL_TTL_MS),
      name, size: buf.length, duration
    });
  }

  /* ---------------- 提交申请（公开） ---------------- */
  if (p === '/api/applications' && method === 'POST') {
    if (!rateLimit('sub:' + clientIp(req), 20, 60 * 1000)) {
      return sendJson(res, 429, { ok: false, error: '提交过于频繁，请稍后再试' });
    }
    /* 审核系统被「终止」= 停止新人入社申请，不再接收提交（暂停时仍可提交，前台会提示审核已暂停） */
    const rsNow = reviewState.publicView();
    if (rsNow.blockSubmit) {
      return sendJson(res, 403, {
        ok: false, reviewStopped: true,
        error: rsNow.notice || '社团暂时停止新人入社申请，请稍后再试'
      });
    }
    const body = await readJson(req);
    const { errors, data } = validateApplication(body);
    /* config/form.json 里新增的字段：通用校验（原有 26 题仍由 validateApplication 校验） */
    const extraErrors = formConfig.validateExtras(body);
    const allErrors = errors.concat(extraErrors.map(e => e.message));
    if (allErrors.length) {
      return sendJson(res, 400, {
        ok: false,
        error: extraErrors.length ? allErrors.join('；') : allErrors[0],
        errors: allErrors
      });
    }

    store.appDb.seq += 1;
    const now = new Date();
    const rec = Object.assign({}, data, formConfig.extrasData(body), {
      id: 'APP-' + now.getTime().toString(36) + '-' + crypto.randomBytes(4).toString('hex'),
      seq: store.appDb.seq,
      createdAt: now.toISOString(),
      createdAtText: cnTime(now),
      status: STATUS.SUBMITTED,
      viewedAt: null, viewedAtText: '', viewedBy: '',
      reviewedAt: null, reviewedAtText: '', reviewedBy: '',
      recommendedDepartment: '', rejectReason: '', rejectReasonCode: ''
    });
    store.appDb.applications.push(rec);
    store.saveApps();
    console.log(`[提交] #${rec.seq} ${rec.cn} → ${rec.department}（${rec.createdAtText}）`);
    return sendJson(res, 200, { ok: true, id: rec.id, seq: rec.seq, cn: rec.cn, status: rec.status });
  }

  /* ---------------- 审核状态查询（公开，按 CN 精确匹配） ---------------- */
  if (p === '/api/status-query' && method === 'POST') {
    if (!rateLimit('q:' + clientIp(req), 20, 60 * 1000)) {
      return sendJson(res, 429, { ok: false, error: '查询过于频繁，请稍后再试' });
    }
    const body = await readJson(req);
    const cn = str(body.cn, 100);
    if (!cn) return sendJson(res, 400, { ok: false, error: '请输入填写申请表时使用的 CN 或代称' });
    if (cn.length < 2) {
      return sendJson(res, 400, { ok: false, error: '请输入完整的 CN 或代称（至少 2 个字符）才能查询' });
    }
    const matched = store.findAppsByCn(cn);
    if (!matched.length) {
      return sendJson(res, 404, {
        ok: false,
        error: `未查询到 CN 为「${cn}」的入社申请。请确认代称与提交时**完全一致**（本查询为精确匹配，不支持模糊搜索）`
      });
    }
    const results = matched
      .slice()
      .sort((a, b) => b.seq - a.seq)
      .slice(0, 20)                      // 单次最多返回 20 条，避免被用来批量抓取
      .map(publicStatusView);
    return sendJson(res, 200, { ok: true, count: results.length, results });
  }

  /* ---------------- 复审：读取可编辑数据（公开，CN + QQ号 双重校验） ---------------- */
  m = p.match(/^\/api\/applications\/([^/]+)\/edit-data$/);
  if (m && method === 'GET') {
    if (!rateLimit('edit:' + clientIp(req), 20, 60 * 1000)) {
      return sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' });
    }
    const rec = store.findApp(decodeURIComponent(m[1]));
    const cn = str(u.searchParams.get('cn'), 100);
    const qq = str(u.searchParams.get('qq'), 20);
    /* 校验不过一律 404，避免被用来探测申请是否存在 */
    if (!verifyOwner(rec, cn, qq)) {
      return sendJson(res, 404, { ok: false, error: '未找到匹配的申请，请确认 CN 与 QQ号 与本条申请完全一致' });
    }
    const rs = store.resubmitState(rec);
    if (!rs.canResubmit) {
      return sendJson(res, 403, { ok: false, error: resubmitDenyText(rec, rs) });
    }
    return sendJson(res, 200, { ok: true, application: withSignedAssets(rec, cfg.UPLOAD_URL_TTL_MS) });
  }

  /* ---------------- 催促审核（公开；同一申请 1 小时最多成功 1 次） ----------------
   * 与查询页一致，用 CN 定位申请（申请人无需再填 QQ）；
   * 保护：每 IP 每分钟限流 + 单条申请 1 小时冷却 + 终审后不再接收 + 全程记录日志（含 IP）。 */
  m = p.match(/^\/api\/applications\/([^/]+)\/urge$/);
  if (m && method === 'POST') {
    const ip = clientIp(req);
    if (!rateLimit('urge:' + ip, cfg.URGE_RATE_PER_MIN, 60 * 1000)) {
      return sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' });
    }
    const rec = store.findApp(decodeURIComponent(m[1]));
    const body = await readJson(req);
    const cn = str(body.cn, 100);
    /* CN 对不上统一按 404 处理，避免被用来探测申请是否存在 */
    if (!rec || !cn || String(rec.cn).trim().toLowerCase() !== cn.trim().toLowerCase()) {
      return sendJson(res, 404, { ok: false, error: '未找到匹配的申请，请确认 CN 代称与本条申请完全一致' });
    }
    const us = store.urgeState(rec);
    if (!us.statusOk) {
      return sendJson(res, 409, {
        ok: false, urgeEnded: us.terminal,
        error: us.terminal
          ? `该申请已审核完成（${STATUS_LABEL_PUBLIC[rec.status] || rec.status}），不再接收催促`
          : `当前状态（${publicStatusLabel(rec)}）无需催促`
      });
    }
    if (us.cooldownLeftMs > 0) {
      return sendJson(res, 429, {
        ok: false, cooldownLeftMs: us.cooldownLeftMs,
        error: `1 小时内只能催促 1 次，请在 ${Math.ceil(us.cooldownLeftMs / 60000)} 分钟后再试`
      });
    }
    store.applyUrge(rec, { ip });
    store.saveApps();
    console.log(`[催促] #${rec.seq} ${rec.cn} 第 ${rec.urgeCount} 次催促（IP ${ip || '-'}，${rec.lastUrgeAtText}）`);
    return sendJson(res, 200, {
      ok: true,
      message: cfg.URGE_OK_MESSAGE,
      urgeCount: rec.urgeCount,
      lastUrgeAt: rec.lastUrgeAtText,
      cooldownMinutes: Math.round(cfg.URGE_COOLDOWN_MS / 60000)
    });
  }

  /* ---------------- 提交复审（公开，最多 2 次，CN + QQ号 双重校验） ---------------- */
  m = p.match(/^\/api\/applications\/([^/]+)\/resubmit$/);
  if (m && method === 'POST') {
    if (!rateLimit('resub:' + clientIp(req), 10, 60 * 1000)) {
      return sendJson(res, 429, { ok: false, error: '提交过于频繁，请稍后再试' });
    }
    const rec = store.findApp(decodeURIComponent(m[1]));
    const body = await readJson(req);
    const cn = str(body.cn, 100);
    const qq = str(body.qq, 20);
    if (!verifyOwner(rec, cn, qq)) {
      return sendJson(res, 404, { ok: false, error: '未找到匹配的申请，请确认 CN 与 QQ号 与本条申请完全一致' });
    }
    /* 先判「还有没有机会」，再判状态 —— 这样提示更贴合用户认知 */
    const rs = store.resubmitState(rec);
    if (!rs.canResubmit) {
      return sendJson(res, 409, { ok: false, error: resubmitDenyText(rec, rs) });
    }
    const { errors, data } = validateApplication(body);
    const extraErrors = formConfig.validateExtras(body);
    const allErrors = errors.concat(extraErrors.map(e => e.message));
    if (allErrors.length) {
      return sendJson(res, 400, {
        ok: false,
        error: extraErrors.length ? allErrors.join('；') : allErrors[0],
        errors: allErrors
      });
    }

    /* 原地更新：id / seq / 首次提交时间保持不变，保证是「同一份申请表」 */
    Object.assign(rec, data, formConfig.extrasData(body));
    rec.status = STATUS.RESUBMITTED;
    rec.resubmitCount = rs.count + 1;          // 消耗本次可用机会
    rec.resubmitUsed = true;
    rec.resubmittedAt = new Date().toISOString();
    rec.resubmittedAtText = cnTime();
    /* 开启新一轮审核：清掉上一轮的查看/结论痕迹；上次退回原因与拒绝理由保留作历史 */
    rec.viewedAt = null; rec.viewedAtText = ''; rec.viewedBy = '';
    rec.reviewedAt = null; rec.reviewedAtText = ''; rec.reviewedBy = '';
    rec.recommendedDepartment = '';
    /* 新一轮尚未产生结论，介入标记也清掉（历史介入时间保留在 intervenedAt 里） */
    rec.reviewedViaIntervene = false;
    rec.reviewedViaInterveneBy = '';
    rec.reviewedViaInterveneAtText = '';
    store.saveApps();
    const leftNote = rec.resubmitCount >= cfg.MAX_RESUBMITS
      ? `已用完 ${cfg.MAX_RESUBMITS} 次机会`
      : '若本次被退回，还可再修改 1 次';
    console.log(`[复审] #${rec.seq} ${rec.cn} 提交了第 ${rec.resubmitCount}/${cfg.MAX_RESUBMITS} 次复审申请（${leftNote}）`);
    return sendJson(res, 200, {
      ok: true, id: rec.id, seq: rec.seq, cn: rec.cn, status: rec.status,
      resubmitCount: rec.resubmitCount, resubmitMax: cfg.MAX_RESUBMITS, leftNote
    });
  }

  /* ---------------- 审核系统开关状态：公开读取 ----------------
   *  前台填表页据此弹窗 + 显示警戒线；写操作在下面「需登录」区里
   */
  if (p === '/api/review-state' && method === 'GET') {
    return sendJson(res, 200, { ok: true, review: reviewState.publicView() });
  }

  /* ---------------- 管理员登录 ---------------- */
  if (p === '/api/admin/login' && method === 'POST') {
    const ip = clientIp(req);
    /* 只对失败尝试计数：正常登录（含多次成功）不会耗尽配额 */
    if (rateExceeded('login:' + ip, 15)) {
      return sendJson(res, 429, { ok: false, error: '登录尝试过于频繁，请 5 分钟后再试' });
    }
    const body = await readJson(req);
    const username = str(body.username, 100);
    const password = String(body.password == null ? '' : body.password).slice(0, 200);
    store.clearExpiredBans();                     // 到解封日期的账号先自动恢复
    const admin = store.findAdminByUsername(username);
    const okUser = !!admin;
    const okPass = okUser && auth.verifyPassword(password, admin.salt, admin.hash);
    if (!okUser || !okPass) {
      rateHit('login:' + ip, 5 * 60 * 1000);
      console.log(`[登录失败] ${username || '(空)'} from ${ip}`);
      return sendJson(res, 401, { ok: false, error: '账号或密码错误' });
    }

    /* 先验证口令、再判断停用：
       否则任何人只要猜对用户名就能探知该账号是否存在、是否被封 */
    if (store.banActive(admin)) {
      console.log(`[登录被拒] ${admin.username} 账号已停用（解封日期 ${admin.banUntilText}）`);
      return sendJson(res, 403, {
        ok: false,
        banned: true,
        error: '您的账户已被示例动漫社停用',
        ban: {
          bannedAtText: admin.bannedAtText || '',
          banUntilText: admin.banUntilText || '',
          banReason: admin.banReason || ''
        }
      });
    }

    admin.lastLoginAt = Date.now();
    admin.lastLoginAtText = cnTime();
    store.saveAdmins();
    const token = auth.issueToken(admin);
    console.log(`[登录成功] ${admin.username}（${cfg.ROLE_LABEL[admin.role]}）`);
    return sendJson(res, 200, {
      ok: true, token,
      admin: Object.assign(store.publicAdmin(admin), { roleLabel: cfg.ROLE_LABEL[admin.role] })
    });
  }

  /* ---------------- 以下接口均需登录 ---------------- */
  const admin = currentAdmin(req, u);

  /* ---------------- 审核系统开关：读取记录 / 启动 / 暂停 / 终止（需【系统开启权限】） ----------------
   *  注意：必须放在 `const admin` 之后，否则会踩 TDZ（ReferenceError: Cannot access 'admin' before initialization） */
  if (p === '/api/review-state/history' && method === 'GET') {
    if (!admin) return sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });
    if (!store.permsOf(admin).openSystem) {
      return sendJson(res, 403, { ok: false, error: '当前账号没有【系统开启权限】' });
    }
    return sendJson(res, 200, { ok: true, history: reviewState.history(30), review: reviewState.publicView() });
  }

  if (p === '/api/review-state' && method === 'POST') {
    if (!admin) return sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });
    if (!store.permsOf(admin).openSystem) {
      console.log(`[审核设置] 拒绝：${admin.username} 没有系统开启权限`);
      return sendJson(res, 403, { ok: false, error: '当前账号没有【系统开启权限】，无法操作审核系统开关' });
    }
    if (!rateLimit('reviewstate:' + clientIp(req), 20, 60 * 1000)) {
      return sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' });
    }
    const body = await readJson(req);
    const r = reviewState.apply({
      action: body.action,
      reason: body.reason,
      pauseUntil: body.pauseUntil,
      notice: body.notice,
      by: admin.username,
      byName: (admin.note && String(admin.note).trim()) || admin.username
    });
    if (!r.ok) return sendJson(res, 400, { ok: false, error: r.error });
    const st = reviewState.publicView(r.state);
    console.log(`[审核设置] ${admin.username} 将审核系统设为「${st.statusLabel}」`
      + (st.reason ? `　原因：${st.reason}` : '')
      + (st.pauseUntilText ? `　预计恢复：${st.pauseUntilText}` : '')
      + (st.notice ? `　通告：${st.notice}` : '')
      + (r.changed ? '' : '（状态未变化，仅记录一次操作）'));
    return sendJson(res, 200, {
      ok: true,
      changed: r.changed,
      message: r.changed ? `已切换为「${st.statusLabel}」` : `当前已是「${st.statusLabel}」，已记录本次操作`,
      review: st
    });
  }

  if (p === '/api/admin/me' && method === 'GET') {
    if (!admin) return sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });
    return sendJson(res, 200, {
      ok: true,
      admin: Object.assign(store.publicAdmin(admin), { roleLabel: cfg.ROLE_LABEL[admin.role] })
    });
  }

  if (p === '/api/admin/password' && method === 'POST') {
    if (!admin) return sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });
    const body = await readJson(req);
    const oldPass = String(body.oldPassword == null ? '' : body.oldPassword);
    const newPass = String(body.newPassword == null ? '' : body.newPassword);
    if (!auth.verifyPassword(oldPass, admin.salt, admin.hash)) {
      return sendJson(res, 400, { ok: false, error: '原密码错误' });
    }
    if (newPass.length < 6) return sendJson(res, 400, { ok: false, error: '新密码至少 6 位' });
    const { salt, hash } = auth.hashPassword(newPass);
    admin.salt = salt; admin.hash = hash;
    store.saveAdmins();
    return sendJson(res, 200, { ok: true, message: '密码已修改，请重新登录' });
  }

  if (p === '/api/admin/logout' && method === 'POST') {
    return sendJson(res, 200, { ok: true });
  }

  /* ---------------- 申请列表（摘要） ---------------- */
  if (p === '/api/applications' && method === 'GET') {
    if (!admin) return sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });
    const all = store.appDb.applications.slice().reverse();   // 最新在前
    /* 移交主审核官的申请：普通审核员完全不可见 */
    const visible = admin.role === ROLES.SUPER ? all : all.filter(a => canView(admin, a));
    const filtered = filterApplications(visible, {
      department: u.searchParams.get('department') || '',
      status: u.searchParams.get('status') || '',
      q: u.searchParams.get('q') || '',
      urged: u.searchParams.get('urged') === '1'
    });
    return sendJson(res, 200, {
      ok: true,
      total: visible.length,
      filtered: filtered.length,
      hiddenEscalated: all.length - visible.length,
      stats: statsOf(visible),
      applications: filtered.map(applicationSummary)
    });
  }

  /* ---------------- 导出 Excel（内嵌图片） ---------------- */
  if (p === '/api/export' && method === 'GET') {
    if (!admin) return sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });
    let list = store.appDb.applications.slice();
    if (u.searchParams.get('filtered') === '1') {
      list = filterApplications(list, {
        department: u.searchParams.get('department') || '',
        status: u.searchParams.get('status') || '',
        q: u.searchParams.get('q') || '',
        urged: u.searchParams.get('urged') === '1'
      });
    }
    /* 按序号升序，内推码申请排前 */
    list.sort((a, b) => (a.seq || 0) - (b.seq || 0));
    console.log(`[导出] ${admin.username} 导出 ${list.length} 条申请`);
    const buf = await buildExportBuffer(list);
    const fname = `示例动漫社-入社申请导出_${cnTime().replace(/[-: ]/g, '').slice(0, 12)}.xlsx`;
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Length': buf.length,
      'Content-Disposition': `attachment; filename="club-applications.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`,
      'Cache-Control': 'no-store'
    });
    return res.end(buf);
  }

  /* ---------------- 管理员账号管理（超管；或具【封禁账号权限】的账号可查看列表） ---------------- */
  if (p === '/api/admins' && method === 'GET') {
    if (!admin) return sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });
    const perms = store.permsOf(admin);
    if (!perms.ban && admin.role !== ROLES.SUPER) {
      return sendJson(res, 403, { ok: false, error: '当前账号没有【封禁账号权限】，无法查看管理员账号' });
    }
    store.clearExpiredBans();                     // 到期的停用自动解除并落盘
    const isSuper = admin.role === ROLES.SUPER;
    const list = store.adminDb.admins
      .slice()
      .sort((a, b) => (a.role === b.role ? (a.createdAt || 0) - (b.createdAt || 0) : (a.role === ROLES.SUPER ? -1 : 1)))
      .map(a => Object.assign(store.publicAdmin(a), {
        roleLabel: cfg.ROLE_LABEL[a.role],
        deletable: a.role !== ROLES.SUPER,
        /* 只有超管能分配权限；有封禁权限的账号只能看到"停用/解封" */
        permEditable: isSuper
      }));
    return sendJson(res, 200, {
      ok: true, admins: list, roles: cfg.ROLE_LABEL,
      permList: cfg.PERM_LIST,
      canAssignPerms: isSuper,
      canCreate: isSuper
    });
  }

  if (p === '/api/admins' && method === 'POST') {
    if (!admin) return sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });
    if (admin.role !== ROLES.SUPER) return sendJson(res, 403, { ok: false, error: '仅最高权限管理员可新增管理员账号' });
    const body = await readJson(req);
    const username = str(body.username, 50);
    const password = String(body.password == null ? '' : body.password);
    const note = str(body.note, 100);
    if (!/^[A-Za-z0-9_\u4e00-\u9fa5-]{2,30}$/.test(username)) {
      return sendJson(res, 400, { ok: false, error: '账号名需为 2-30 位字母/数字/汉字/下划线/中划线' });
    }
    if (password.length < 6) return sendJson(res, 400, { ok: false, error: '密码至少 6 位' });
    if (store.findAdminByUsername(username)) return sendJson(res, 409, { ok: false, error: '该账号名已存在' });
    const { salt, hash } = auth.hashPassword(password);
    const rec = {
      id: 'ADM-' + crypto.randomBytes(6).toString('hex'),
      username,
      role: ROLES.SUB,                      // 按需求：仅可新增分管理员
      salt, hash, note,
      createdAt: Date.now(),
      createdAtText: cnTime(),
      createdBy: admin.username,
      lastLoginAt: null,
      lastLoginAtText: '',
      /* 新建子账号：审核权限默认开启，其余权限需超管在【设置权限】里分配 */
      perms: cfg.defaultPerms()
    };
    store.adminDb.admins.push(rec);
    store.saveAdmins();
    console.log(`[管理员] ${admin.username} 新增分管理员 ${username}`);
    return sendJson(res, 200, {
      ok: true,
      admin: Object.assign(store.publicAdmin(rec), { roleLabel: cfg.ROLE_LABEL[rec.role], deletable: true })
    });
  }

  m = p.match(/^\/api\/admins\/([^/]+)$/);
  if (m && method === 'DELETE') {
    if (!admin) return sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });
    if (admin.role !== ROLES.SUPER) return sendJson(res, 403, { ok: false, error: '仅最高权限管理员可删除管理员账号' });
    const target = store.findAdminById(decodeURIComponent(m[1]));
    if (!target) return sendJson(res, 404, { ok: false, error: '账号不存在' });
    if (target.role === ROLES.SUPER) return sendJson(res, 403, { ok: false, error: '最高权限管理员账号不可删除' });
    if (target.id === admin.id) return sendJson(res, 403, { ok: false, error: '不能删除当前登录的账号' });
    store.adminDb.admins = store.adminDb.admins.filter(a => a.id !== target.id);
    store.saveAdmins();
    console.log(`[管理员] ${admin.username} 删除分管理员 ${target.username}`);
    return sendJson(res, 200, { ok: true, message: `已删除分管理员「${target.username}」` });
  }

  /**
   * 账号设置（【设置权限】弹窗的保存接口）
   *   · 超管：可同时分配 4 项权限 + 停用/解封
   *   · 有【封禁账号权限】的分管理员：只能停用/解封，body 里带 perms 一律 403
   *   · 停用规则不变：日期必须未来 + 理由必填 + 超管账号不可停用/不可改权限
   */
  /* 只校验权限分配部分（返回 error 字符串 或 null） */
  function applyPermsBody(actor, target, body) {
    if (body.perms === undefined || body.perms === null) return null;
    if (target.role === ROLES.SUPER) return '最高权限管理员恒定拥有全部权限，无需分配';
    if (actor.role !== ROLES.SUPER) return '仅最高权限管理员可分配权限';
    if (typeof body.perms !== 'object') return '权限参数格式不正确';
    const clean = {};
    for (const p of cfg.PERM_LIST) {
      if (body.perms[p.key] !== undefined) clean[p.key] = body.perms[p.key] === true;
    }
    target.perms = store.normalizePerms(Object.assign({}, target.perms, clean));
    return null;
  }

  m = p.match(/^\/api\/admins\/([^/]+)\/settings$/);
  if (m && method === 'POST') {
    if (!admin) return sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });
    const perms = store.permsOf(admin);
    if (!perms.ban && admin.role !== ROLES.SUPER) {
      return sendJson(res, 403, { ok: false, error: '当前账号没有【封禁账号权限】' });
    }
    const target = store.findAdminById(decodeURIComponent(m[1]));
    if (!target) return sendJson(res, 404, { ok: false, error: '账号不存在' });
    const body = await readJson(req);

    /* 1) 权限分配 */
    const permErr = applyPermsBody(admin, target, body);
    if (permErr) return sendJson(res, 403, { ok: false, error: permErr });

    /* 2) 停用 / 解封（复用与 /ban 完全相同的规则） */
    const enabled = body.enabled === true || body.enabled === 'true';
    const r = applyBanBody(admin, target, body, enabled);
    if (r.error) return sendJson(res, r.code, { ok: false, error: r.error });

    store.saveAdmins();
    console.log(`[账号] ${admin.username} 保存「${target.username}」的账号设置：`
      + (enabled ? `停用至 ${target.banUntilText}（${target.banReason}）` : '未停用')
      + `　权限=${JSON.stringify(store.permsOf(target))}`);
    return sendJson(res, 200, {
      ok: true,
      message: enabled ? `已停用「${target.username}」，解封日期 ${target.banUntilText}` : `已保存「${target.username}」的账号设置`,
      admin: Object.assign(store.publicAdmin(target), { roleLabel: cfg.ROLE_LABEL[target.role], deletable: target.role !== ROLES.SUPER })
    });
  }

  m = p.match(/^\/api\/admins\/([^/]+)\/ban$/);
  if (m && method === 'POST') {
    if (!admin) return sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });
    const perms = store.permsOf(admin);
    if (!perms.ban && admin.role !== ROLES.SUPER) {
      return sendJson(res, 403, { ok: false, error: '当前账号没有【封禁账号权限】' });
    }
    const target = store.findAdminById(decodeURIComponent(m[1]));
    if (!target) return sendJson(res, 404, { ok: false, error: '账号不存在' });
    if (target.role === ROLES.SUPER) return sendJson(res, 403, { ok: false, error: '最高权限管理员账号不可停用' });

    const body = await readJson(req);
    const enabled = body.enabled === true || body.enabled === 'true';
    const r = applyBanBody(admin, target, body, enabled);
    if (r.error) return sendJson(res, r.code, { ok: false, error: r.error });

    store.saveAdmins();
    if (!enabled) {
      console.log(`[账号] ${admin.username} 解除了「${target.username}」的停用`);
      return sendJson(res, 200, {
        ok: true,
        message: `已解除「${target.username}」的停用`,
        admin: Object.assign(store.publicAdmin(target), { roleLabel: cfg.ROLE_LABEL[target.role], deletable: true })
      });
    }
    console.log(`[账号] ${admin.username} 停用了「${target.username}」，解封日期 ${target.banUntilText}，理由：${target.banReason}`);
    return sendJson(res, 200, {
      ok: true,
      message: `已停用「${target.username}」，解封日期 ${target.banUntilText}`,
      admin: Object.assign(store.publicAdmin(target), { roleLabel: cfg.ROLE_LABEL[target.role], deletable: true })
    });
  }

  /* 设置子账号备注（超管独有功能；仅改备注，不动账号与权限）
     注意：上面 ban 路由复用了 m，这里必须重新匹配，否则备注接口会 404 */
  m = p.match(/^\/api\/admins\/([^/]+)$/);
  if (m && method === 'PUT') {
    if (!admin) return sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });
    if (admin.role !== ROLES.SUPER) return sendJson(res, 403, { ok: false, error: '仅最高权限管理员可设置子账号备注' });
    const target = store.findAdminById(decodeURIComponent(m[1]));
    if (!target) return sendJson(res, 404, { ok: false, error: '账号不存在' });
    const body = await readJson(req);
    const note = str(body.note, 100);
    target.note = note;
    store.saveAdmins();
    console.log(`[管理员] ${admin.username} 设置「${target.username}」的备注为「${note || '(空)'}」`);
    return sendJson(res, 200, {
      ok: true,
      message: note ? `已保存备注「${note}」` : `已清空「${target.username}」的备注`,
      admin: Object.assign(store.publicAdmin(target), {
        roleLabel: cfg.ROLE_LABEL[target.role],
        deletable: target.role !== ROLES.SUPER
      })
    });
  }

  /* ---------------- 系统设置（需【系统设置权限】；超管恒定拥有） ----------------
   * 只提供两件事：查看服务器状态 / 重启服务器系统。
   * 重启只重启操作系统，不删除任何业务数据。 */
  if (p === '/api/system/info' && method === 'GET') {
    if (!admin) return sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });
    if (!store.permsOf(admin).system) {
      return sendJson(res, 403, { ok: false, error: '当前账号没有【系统设置权限】，无法访问系统设置' });
    }
    return sendJson(res, 200, { ok: true, system: system.systemInfo(req) });
  }

  if (p === '/api/system/reboot' && method === 'POST') {
    if (!admin) return sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });
    if (!store.permsOf(admin).system) {
      console.log(`[系统] 拒绝：${admin.username} 没有系统设置权限，试图重启服务器`);
      return sendJson(res, 403, { ok: false, error: '当前账号没有【系统设置权限】，无法重启服务器' });
    }
    /* 即使超管误点/被刷，也不允许短时间内反复重启 */
    if (!rateLimit('reboot:' + clientIp(req), 3, 10 * 60 * 1000)) {
      return sendJson(res, 429, { ok: false, error: '重启请求过于频繁，请稍后再试' });
    }
    const left = system.cooldownRemaining();
    if (left > 0) {
      return sendJson(res, 429, {
        ok: false,
        error: `刚刚已执行过重启，请等待 ${Math.ceil(left / 60000)} 分钟后再操作`,
        cooldownRemainingMs: left
      });
    }
    const blockReason = system.systemInfo(req).blockReason;
    if (blockReason && !cfg.REBOOT_DRY_RUN) {
      return sendJson(res, 503, { ok: false, error: blockReason });
    }
    const r = await system.executeReboot({ mode: cfg.REBOOT_MODE, by: admin.username, ip: clientIp(req) });
    if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error, detail: r.detail || '' });
    console.log(`[系统] 已下发重启指令（操作人 ${admin.username}，模式 ${cfg.REBOOT_MODE}）`);
    const selfTest = cfg.REBOOT_MODE === 'selftest';
    return sendJson(res, 200, {
      ok: true,
      dryRun: !!r.dryRun,
      mode: cfg.REBOOT_MODE,
      delaySeconds: cfg.REBOOT_DELAY_SECONDS,
      atText: r.entry && r.entry.atText,
      message: r.message,
      tip: selfTest
        ? '（自检模式）已跑通 sudo → 重启脚本链路，服务器不会被重启。'
        : '服务器正在重启，预计 1 分钟内恢复访问。重启不会删除任何申请数据、账号或附件。'
    });
  }

  /* ---------------- 申请详情（打开即置为「审核员查看中」） ---------------- */
  m = p.match(/^\/api\/applications\/([^/]+)$/);
  if (m && method === 'GET') {
    if (!admin) return sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });
    const rec = store.findApp(decodeURIComponent(m[1]));
    if (!rec) return sendJson(res, 404, { ok: false, error: '申请记录不存在' });
    if (!canView(admin, rec)) {
      return sendJson(res, 403, { ok: false, error: '该申请已移交主审核官，仅最高权限管理员可查看' });
    }

    let changed = false;
    if (rec.status === STATUS.SUBMITTED) {
      rec.status = STATUS.VIEWING;
      rec.viewedAt = new Date().toISOString();
      rec.viewedAtText = cnTime();
      rec.viewedBy = admin.username;
      store.saveApps();
      changed = true;
      console.log(`[查看] #${rec.seq} ${rec.cn} 由 ${admin.username} 打开 → 审核员查看中`);
    }
    const perms = store.permsOf(admin);
    return sendJson(res, 200, {
      ok: true,
      autoViewed: changed,
      statusLabel: STATUS_LABEL_ADMIN[rec.status],
      canReview: canReviewApp(admin, rec),
      canIntervene: canIntervene(admin, rec),
      locked: isIntervened(rec),
      perms,
      departments: cfg.DEPARTMENTS,
      rejectReasons: REJECT_REASONS,
      application: withSignedAssets(rec)
    });
  }

  /* ---------------- 审核介入（仅具【主审核官介入权限】的账号） ----------------
   * 语义：
   *   · 清空该申请已有的审核结论（通过 / 不通过 / 退回 全部清除）
   *   · 状态固定为「主审核官介入中」，此后只有具介入权限的账号能操作
   *   · 其他分管理员仍可打开查看内容，但所有审核按钮置灰
   *   · 介入权限账号完成一次正常审核（通过 / 不通过 / 退回）后自动解除锁定
   */
  m = p.match(/^\/api\/applications\/([^/]+)\/intervene$/);
  if (m && method === 'POST') {
    if (!admin) return sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });
    if (!store.permsOf(admin).intervene) {
      console.log(`[介入] 拒绝：${admin.username} 没有主审核官介入权限`);
      return sendJson(res, 403, { ok: false, error: '当前账号没有【主审核官介入权限】，无法执行审核介入' });
    }
    const rec = store.findApp(decodeURIComponent(m[1]));
    if (!rec) return sendJson(res, 404, { ok: false, error: '申请记录不存在' });
    if (!canView(admin, rec)) {
      return sendJson(res, 403, { ok: false, error: '该申请已移交主审核官，无权操作' });
    }
    if (isIntervened(rec)) {
      return sendJson(res, 409, { ok: false, error: '该申请表已处于「主审核官介入中」，无需重复介入' });
    }
    if (!rateLimit('intervene:' + clientIp(req), 20, 60 * 1000)) {
      return sendJson(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' });
    }

    const now = new Date();
    /* 记录介入前的结论，便于后台追溯（查询页不展示） */
    rec.intervenedFromStatus = rec.status;
    rec.intervenedFromText = rec.reviewedAtText || (rec.status === STATUS.SUBMITTED ? '' : '');
    /* 清空已有的审核结论（需求：不管之前是通过 / 拒绝 / 退回，全部清除） */
    rec.reviewedAt = null; rec.reviewedAtText = ''; rec.reviewedBy = '';
    rec.recommendedDepartment = '';
    rec.rejectReason = ''; rec.rejectReasonCode = '';
    rec.returnReason = ''; rec.returnedAt = null; rec.returnedAtText = ''; rec.returnedBy = '';
    rec.escalatedAt = null; rec.escalatedAtText = ''; rec.escalatedBy = '';
    rec.viewedAt = null; rec.viewedAtText = ''; rec.viewedBy = '';
    /* 进入介入锁定 */
    rec.status = STATUS.INTERVENED;
    rec.intervened = true;
    rec.intervenedAt = now.toISOString();
    rec.intervenedAtText = cnTime(now);
    rec.intervenedBy = admin.username;
    rec.intervenedResolvedAt = null;
    rec.intervenedResolvedAtText = '';
    /* 上一轮的结论已被清空，最终结果尚未产生 */
    rec.reviewedViaIntervene = false;
    rec.reviewedViaInterveneBy = '';
    rec.reviewedViaInterveneAtText = '';
    store.saveApps();
    console.log(`[介入] #${rec.seq} ${rec.cn} 由 ${admin.username} 介入（原状态：${rec.intervenedFromStatus}），已锁定为「主审核官介入中」`);
    return sendJson(res, 200, {
      ok: true,
      message: '已介入该申请表：原有审核状态已清空，此后仅主审核官可操作',
      statusLabel: STATUS_LABEL_ADMIN[rec.status],
      application: withSignedAssets(rec)
    });
  }

  /* ---------------- 审核操作（不可逆） ---------------- */
  m = p.match(/^\/api\/applications\/([^/]+)\/review$/);
  if (m && method === 'POST') {
    if (!admin) return sendJson(res, 401, { ok: false, error: '未登录或登录已过期' });
    const rec = store.findApp(decodeURIComponent(m[1]));
    if (!rec) return sendJson(res, 404, { ok: false, error: '申请记录不存在' });
    if (!canView(admin, rec)) {
      return sendJson(res, 403, { ok: false, error: '该申请已移交主审核官，仅最高权限管理员可审核' });
    }
    const perms = store.permsOf(admin);
    /* 介入锁定：非介入权限账号一律拒绝（前端按钮同时置灰） */
    if (isIntervened(rec) && !perms.intervene) {
      return sendJson(res, 403, {
        ok: false, locked: true,
        error: '该申请表已由主审核官介入，仅主审核官可操作'
      });
    }
    if (!perms.review && !(isIntervened(rec) && perms.intervene)) {
      return sendJson(res, 403, { ok: false, error: '当前账号没有审核权限，仅可查看申请表内容' });
    }
    /* 可审核状态：常规待处理状态；已移交主审核官的仅超管可审核；介入锁定的需介入权限（上面已校验） */
    const reviewable = cfg.REVIEWABLE
      .concat(admin.role === ROLES.SUPER ? [STATUS.ESCALATED] : [])
      .concat(perms.intervene ? [STATUS.INTERVENED] : []);
    if (!reviewable.includes(rec.status)) {
      return sendJson(res, 409, {
        ok: false,
        error: `该申请已审核（${STATUS_LABEL_ADMIN[rec.status] || rec.status}），审核操作不可逆，不能二次修改`
      });
    }
    const body = await readJson(req);
    const { error, value } = validateReview(body);
    if (error) return sendJson(res, 400, { ok: false, error });

    const now = new Date();
    /* 是否处于「主审核官介入」锁定中：必须在改状态之前判断 */
    const wasIntervened = isIntervened(rec) || rec.intervened === true;
    /* 这份结论是否由主审核官介入后给出（查询页据此改写第 ④ 节点文案） */
    rec.reviewedViaIntervene = wasIntervened;
    rec.reviewedViaInterveneBy = wasIntervened ? (rec.intervenedBy || admin.username) : '';
    rec.reviewedViaInterveneAtText = wasIntervened ? cnTime(now) : '';
    /* 统一记录「最后操作人 / 时间」，便于追溯（退回与移交同样记录） */
    rec.reviewedAt = now.toISOString();
    rec.reviewedAtText = cnTime(now);
    rec.reviewedBy = admin.username;

    if (value.action === 'approve') {
      rec.status = STATUS.APPROVED;
      rec.recommendedDepartment = value.recommendedDepartment;
      rec.rejectReason = ''; rec.rejectReasonCode = '';
      rec.returnReason = '';
    } else if (value.action === 'reject') {
      rec.status = STATUS.REJECTED;
      rec.rejectReasonCode = value.rejectReasonCode;
      rec.rejectReason = value.rejectReason;
      rec.recommendedDepartment = '';
      rec.returnReason = '';
    } else if (value.action === 'return') {
      /* 退回：申请人可修改后提交复审（次数规则见 store.resubmitState：最多 2 次） */
      rec.status = STATUS.RETURNED;
      rec.returnReason = value.returnReason;
      rec.returnedAt = now.toISOString();
      rec.returnedAtText = cnTime(now);
      rec.returnedBy = admin.username;
      rec.recommendedDepartment = '';
      rec.rejectReason = ''; rec.rejectReasonCode = '';
    } else {
      /* 移交主审核官：此后仅超管可见 / 可审核 */
      rec.status = STATUS.ESCALATED;
      rec.escalatedAt = now.toISOString();
      rec.escalatedAtText = cnTime(now);
      rec.escalatedBy = admin.username;
      rec.recommendedDepartment = '';
      rec.rejectReason = ''; rec.rejectReasonCode = '';
      rec.returnReason = '';
    }
    /* 完成一次审核即解除「主审核官介入」锁定 */
    if (wasIntervened) {
      rec.intervened = false;
      rec.intervenedResolvedAt = now.toISOString();
      rec.intervenedResolvedAtText = cnTime(now);
    }
    store.saveApps();
    console.log(`[审核] #${rec.seq} ${rec.cn} → ${STATUS_LABEL_ADMIN[rec.status]}（${admin.username}，${rec.reviewedAtText}）`
      + (wasIntervened ? '（已解除主审核官介入锁定）' : ''));
    return sendJson(res, 200, {
      ok: true,
      statusLabel: STATUS_LABEL_ADMIN[rec.status],
      unlocked: wasIntervened,
      application: withSignedAssets(rec)
    });
  }

  return sendJson(res, 404, { ok: false, error: '接口不存在' });
}

/* =========================================================================
 * 服务器
 * ========================================================================= */
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = u.pathname;
    if (p.startsWith('/api/')) return await handleApi(req, res, u, p);
    return serveStatic(req, res, p, u);
  } catch (err) {
    const status = (err && err.status) || 500;
    const msg = (err && err.status)
      ? err.message
      : '服务器内部错误';
    if (!err || !err.status) console.error('[error]', err);
    if (!res.headersSent) sendJson(res, status, { ok: false, error: msg });
    else res.end();
  }
});

process.on('uncaughtException', e => console.error('[uncaught]', e));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));

server.listen(cfg.PORT, cfg.HOST, () => {
  const superAdmin = store.adminDb.admins.find(a => a.role === ROLES.SUPER);
  console.log('=========================================================');
  console.log('  示例动漫社 · 入社申请审核系统 已启动');
  console.log(`  用户填写端    : http://localhost:${cfg.PORT}/`);
  console.log(`  审核状态查询  : http://localhost:${cfg.PORT}/status`);
  console.log(`  审核管理后台  : http://localhost:${cfg.PORT}/admin`);
  if (seeded) {
    console.log('  ── 已初始化最高权限管理员 ──');
    console.log(`  账号：${seeded.username}    密码：${cfg.DEFAULT_SUPER_PASS}`);
    console.log('  （请登录后尽快修改密码）');
  } else {
    console.log(`  最高权限账号  : ${superAdmin ? superAdmin.username : '(无)'}`);
  }
  console.log(`  数据目录      : ${cfg.DATA_DIR}`);
  console.log(`  现有申请      : ${store.appDb.applications.length} 条`);
  console.log('=========================================================');
});
