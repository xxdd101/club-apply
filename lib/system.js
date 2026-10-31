'use strict';

/* =========================================================================
 * 系统设置 / 重启服务器
 *
 *   ⚠️ 本模块只做一件事：调用一个 root 脚本重启**操作系统**。
 *      不删除、不修改任何业务数据 —— 申请表（applications.json）、
 *      管理员账号（admins.json）、上传附件（uploads/）都在磁盘上，
 *      重启后原样还在（这也是需求里明确要求的前提）。
 *
 * 安全设计：
 *   1. 只有最高权限管理员（超管）能调用，分管理员一律 403；
 *   2. sudo 白名单只放行 /usr/local/bin/club-reboot.sh 这一个 root 只读脚本；
 *   3. 冷却时间：两次手动重启之间至少间隔 N 分钟，避免被刷成重启循环；
 *   4. 每次请求都写审计（本文件 + /var/log/club-reboot.log），记录操作人、时间、原因、来源 IP。
 * ========================================================================= */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const cfg = require('./config');
const { cnTime } = require('./util');

const LOG_FILE = path.join(cfg.DATA_DIR, 'reboot-log.json');
const MAX_HISTORY = 30;

/* ---------------- 审计日志 ---------------- */
function readLog() {
  try {
    const d = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    if (d && typeof d === 'object') {
      if (!Array.isArray(d.history)) d.history = [];
      return d;
    }
  } catch (e) { /* 首次运行或文件损坏都从空开始 */ }
  return { lastRequest: null, lastActualReboot: null, history: [] };
}

function writeLog(d) {
  try {
    fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
    const tmp = LOG_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
    fs.renameSync(tmp, LOG_FILE);
  } catch (e) {
    console.error('[系统设置] 重启审计日志写入失败：' + e.message);
  }
}

/** 记录一次重启请求（mode: manual | scheduled） */
function recordRequest({ mode, by, ip, dryRun }) {
  const d = readLog();
  const now = Date.now();
  const entry = {
    at: now,
    atText: cnTime(now),
    mode,
    reason: mode === 'manual' ? '超级管理员手动点击【重启系统】'
      : mode === 'selftest' ? '运维自检（只验证 sudo → 脚本链路，不重启）'
        : '每日 00:00 定时任务',
    by: by || '(系统/定时任务)',
    ip: ip || '',
    dryRun: !!dryRun
  };
  d.lastRequest = entry;
  d.history.unshift(entry);
  if (d.history.length > MAX_HISTORY) d.history.length = MAX_HISTORY;
  writeLog(d);
  return entry;
}

/** 记录一次"确认已经真正重启过"（启动时若发现开机时间晚于上次请求，就补记一条） */
function recordActualReboot(entry) {
  const d = readLog();
  d.lastActualReboot = Object.assign({}, entry, { rebootedAtText: cnTime() });
  writeLog(d);
  return d.lastActualReboot;
}

/** 冷却：距离上次**手动**重启请求还剩多少毫秒 */
function cooldownRemaining() {
  const d = readLog();
  const last = d.lastRequest;
  if (!last || last.mode !== 'manual' || last.dryRun) return 0;
  const left = (last.at + cfg.REBOOT_COOLDOWN_MS) - Date.now();
  return left > 0 ? left : 0;
}

/* ---------------- 系统信息 ---------------- */
const CN_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 计算"下一次每日 00:00（东八区）"的时间戳 */
function nextScheduledAt(nowMs) {
  const now = nowMs || Date.now();
  const cn = new Date(now + CN_OFFSET_MS);
  const y = cn.getUTCFullYear(), m = cn.getUTCMonth(), d = cn.getUTCDate();
  let nextCn = Date.UTC(y, m, d, 0, 0, 0, 0);          // 今天 00:00（东八区）
  if (nextCn <= cn.getTime()) nextCn += 24 * 3600 * 1000;   // 已过则取明天
  return nextCn - CN_OFFSET_MS;
}

function humanDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  const mi = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时 ${mi} 分`;
  if (h > 0) return `${h} 小时 ${mi} 分`;
  return `${mi} 分钟`;
}

/** 定时重启任务是否已经装在服务器上（读 cron 文件；Windows / 无权限时为 false） */
function scheduleInstalled() {
  try {
    const active = fs.readFileSync(cfg.REBOOT_SCHEDULE_FILE, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))     // 只认没被注释掉的行
      .join('\n');
    return /club-reboot\.sh/.test(active);
  } catch (e) { return false; }
}

function isLinux() { return process.platform === 'linux'; }

/** 只读文件尾部若干字节（避免日志变大后一次性全读进内存） */
function readTail(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes || 16 * 1024);
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

/**
 * 服务器侧的重启日志（/var/log/club-reboot.log）。
 * 定时任务触发的重启不经过应用，只能靠这份日志留痕，所以后台要能直接看到。
 */
function systemLogTail(maxLines) {
  try {
    const txt = readTail(cfg.REBOOT_SYSTEM_LOG, 16 * 1024);
    const lines = txt.split('\n').filter(l => l.trim()).slice(-(maxLines || 14));
    return { path: cfg.REBOOT_SYSTEM_LOG, readable: true, lines };
  } catch (e) {
    return {
      path: cfg.REBOOT_SYSTEM_LOG, readable: false, lines: [],
      error: e.code === 'ENOENT' ? '本机还没有重启日志（尚未重启过）' : e.message
    };
  }
}

/** 当前环境能不能真的执行重启（非 Linux、脚本不存在、演练模式都要如实告诉前端） */
function canReboot() {
  if (cfg.REBOOT_DRY_RUN) return true;               // 演练模式照样走完整流程
  if (!isLinux()) return false;
  try { fs.accessSync(cfg.REBOOT_CMD, fs.constants.X_OK); return true; } catch (e) { return false; }
}

function rebootBlockReason() {
  if (cfg.REBOOT_DRY_RUN) return '';
  if (!isLinux()) return '当前运行环境不是 Linux（本地开发预览），服务器重启只在线上 Linux 服务器上生效。';
  try { fs.accessSync(cfg.REBOOT_CMD, fs.constants.X_OK); } catch (e) {
    return '服务器重启脚本未就绪（缺少可执行的 ' + cfg.REBOOT_CMD + '），请联系运维安装。';
  }
  return '';
}

function systemInfo(req) {
  const upSec = os.uptime();
  const bootAt = Date.now() - upSec * 1000;
  const d = readLog();
  const nextAt = nextScheduledAt();
  return {
    platform: process.platform,
    hostname: os.hostname(),
    serverTimeText: cnTime(),
    timezone: 'Asia/Shanghai（东八区 UTC+8）',
    uptimeText: humanDuration(upSec),
    uptimeSeconds: Math.floor(upSec),
    bootAtText: cnTime(bootAt),
    canReboot: canReboot(),
    blockReason: rebootBlockReason(),
    dryRun: cfg.REBOOT_DRY_RUN,
    rebootMode: cfg.REBOOT_MODE,
    rebootDelaySeconds: cfg.REBOOT_DELAY_SECONDS,
    cooldownMinutes: Math.round(cfg.REBOOT_COOLDOWN_MS / 60000),
    cooldownRemainingMs: cooldownRemaining(),
    schedule: {
      enabled: scheduleInstalled(),
      cron: cfg.REBOOT_CRON,
      desc: cfg.REBOOT_CRON_DESC,
      file: cfg.REBOOT_SCHEDULE_FILE,
      nextAt: nextAt,
      nextAtText: cnTime(nextAt)
    },
    lastRequest: d.lastRequest,
    lastActualReboot: d.lastActualReboot,
    history: d.history.slice(0, 5),
    systemLog: systemLogTail(14),
    dataSafety: [
      '申请表与审核结果：data/applications.json',
      '管理员账号：data/admins.json',
      '上传的图片/音频：data/uploads/、缩略图 data/thumbs/',
      '以上均为磁盘文件，重启系统不会删除或改动'
    ]
  };
}

/* ---------------- 执行重启 ---------------- */
/**
 * 调用 root 脚本重启操作系统。
 * 脚本会「先记录日志 + sync 落盘，再延迟 N 秒重启」，并且**立刻返回**，
 * 因此这里能在 1.5 秒内拿到退出码，从而把「白名单没配好 / sudo 被拒」这类
 * 失败如实报给前端，而不是假装成功。
 *
 * @returns {Promise<{ok:boolean, dryRun?:boolean, error?:string, detail?:string}>}
 */
function executeReboot({ mode, by, ip }) {
  return new Promise(resolve => {
    const entry = recordRequest({ mode, by, ip, dryRun: cfg.REBOOT_DRY_RUN });
    console.log(`[系统] ${by} 请求重启服务器（mode=${mode}, dryRun=${cfg.REBOOT_DRY_RUN}, ip=${ip}）`);

    if (cfg.REBOOT_DRY_RUN) {
      return resolve({
        ok: true, dryRun: true, entry,
        message: '（演练模式）重启指令已记录，未真正重启服务器'
      });
    }
    if (!isLinux()) {
      return resolve({ ok: false, error: rebootBlockReason(), entry });
    }

    let child;
    try {
      child = spawn('sudo', ['-n', cfg.REBOOT_CMD, mode, by || '-'], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (e) {
      return resolve({ ok: false, error: '重启指令执行失败：' + e.message, entry });
    }
    child.unref();

    let err = '', out = '';
    if (child.stdout) child.stdout.on('data', b => { out += b.toString(); });
    if (child.stderr) child.stderr.on('data', b => { err += b.toString(); });

    let settled = false;
    const finish = r => { if (!settled) { settled = true; resolve(r); } };
    const timer = setTimeout(() => {
      /* 1.5 秒还没退出 = 脚本已经进入"等待重启"阶段，说明指令被接受了 */
      finish({ ok: true, entry, message: '重启指令已下发' });
    }, 1500);

    child.on('error', e => { clearTimeout(timer); finish({ ok: false, error: '无法执行重启脚本：' + e.message, entry }); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) return finish({ ok: true, entry, message: '重启指令已下发' });
      const detail = (err || out).trim().slice(0, 300);
      console.error(`[系统] 重启脚本退出码 ${code}：${detail}`);
      finish({
        ok: false, entry, detail,
        error: '重启指令被服务器拒绝（请检查 sudo 白名单是否已放行 ' + cfg.REBOOT_CMD + '）'
      });
    });
  });
}

module.exports = {
  systemInfo, executeReboot, cooldownRemaining,
  recordRequest, recordActualReboot, readLog,
  nextScheduledAt, scheduleInstalled, canReboot, rebootBlockReason,
  systemLogTail, LOG_FILE
};
