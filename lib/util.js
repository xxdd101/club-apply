'use strict';

/* =========================================================================
 * 通用工具
 * ========================================================================= */

/** 东八区时间文本：YYYY-MM-DD HH:mm:ss */
function cnTime(d) {
  d = d || new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** 中文日期文本：YYYY年MM月DD日 */
function cnDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}年${p.month}月${p.day}日`;
}

/**
 * 'YYYY-MM-DD' → 该日 00:00（东八区）的时间戳
 * 明确按 +08:00 解析，不受服务器时区设置影响
 */
function dateStrToTs(ymd) {
  const s = String(ymd || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN;
  const t = Date.parse(s + 'T00:00:00+08:00');
  return Number.isFinite(t) ? t : NaN;
}

/** 时间戳 → 'YYYY-MM-DD'（东八区） */
function tsToDateStr(ts) {
  if (!ts) return '';
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(new Date(ts));
}

/** 清洗字符串：去控制字符、去首尾空白、限长 */
function str(v, max) {
  if (v === undefined || v === null) return '';
  return String(v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max || 5000);
}

/** 定长安全比较，防时序侧信道 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return require('crypto').timingSafeEqual(ba, bb);
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function httpError(msg, status) {
  return Object.assign(new Error(msg), { status: status || 400 });
}

module.exports = { cnTime, cnDate, dateStrToTs, tsToDateStr, str, safeEqual, sendJson, httpError };
