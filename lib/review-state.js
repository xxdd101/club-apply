'use strict';

/* =========================================================================
 * 审核系统开关状态（启动 / 暂停 / 终止）
 *
 *   running  启动审核系统（默认）—— 申请表正常填写、正常提交
 *   paused   暂停审核系统         —— 申请表仍可填写提交，但前台明确提示「审核已暂停」
 *                                     （展示：暂停时间、暂停原因、预计恢复时间）
 *   stopped  终止审核系统         —— 停止新人入社申请：前台弹出公告，且不再接收提交
 *
 * 状态与「所有操作、状态变更记录」单独保存在 data/review-state.json，
 * 不触碰 applications.json / admins.json 等任何业务数据。
 * ========================================================================= */

const fs = require('fs');
const path = require('path');

const cfg = require('./config');
const { cnTime } = require('./util');

const FILE = cfg.REVIEW_STATE_FILE;

function blank() {
  return {
    status: cfg.REVIEW_STATUS.RUNNING,
    /* 暂停信息 */
    reason: '',
    pauseUntil: null,
    pauseUntilText: '',
    /* 终止（通告文本） */
    notice: '',
    /* 最近一次变更 */
    updatedAt: null,
    updatedAtText: '',
    updatedBy: '',
    updatedByName: '',
    /* 启动 / 恢复时间（暂停、终止之后重新启动时刷新） */
    runningSinceAt: null,
    runningSinceText: '',
    /* 操作与状态变更记录 */
    history: []
  };
}

function normalize(d) {
  const b = blank();
  const src = (d && typeof d === 'object') ? d : {};
  const out = Object.assign(b, src);
  if (!Object.values(cfg.REVIEW_STATUS).includes(out.status)) out.status = cfg.REVIEW_STATUS.RUNNING;
  out.reason = typeof out.reason === 'string' ? out.reason : '';
  out.notice = typeof out.notice === 'string' ? out.notice : '';
  out.pauseUntil = out.pauseUntil || null;
  out.pauseUntilText = out.pauseUntilText || '';
  out.updatedAt = out.updatedAt || null;
  out.updatedAtText = out.updatedAtText || '';
  out.updatedBy = out.updatedBy || '';
  out.updatedByName = out.updatedByName || '';
  out.runningSinceAt = out.runningSinceAt || null;
  out.runningSinceText = out.runningSinceText || '';
  out.history = Array.isArray(out.history) ? out.history.slice(0, cfg.REVIEW_HISTORY_MAX) : [];
  /* running 状态下不保留暂停/终止信息，避免前台误显示 */
  if (out.status === cfg.REVIEW_STATUS.RUNNING) {
    out.pauseUntil = null; out.pauseUntilText = '';
  }
  return out;
}

function read() {
  try {
    return normalize(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch (e) {
    return blank();
  }
}

function write(d) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

/** 当前状态（完整，含历史） */
function current() { return read(); }

/** 公开给前台/后台展示的字段（不含历史） */
function publicView(d) {
  const s = normalize(d || read());
  return {
    status: s.status,
    statusLabel: cfg.REVIEW_STATUS_LABEL[s.status] || s.status,
    running: s.status === cfg.REVIEW_STATUS.RUNNING,
    paused: s.status === cfg.REVIEW_STATUS.PAUSED,
    stopped: s.status === cfg.REVIEW_STATUS.STOPPED,
    /* 暂停：时间 + 原因 + 预计恢复时间 */
    reason: s.reason,
    pausedAtText: s.status === cfg.REVIEW_STATUS.PAUSED ? s.updatedAtText : '',
    pauseUntil: s.pauseUntil,
    pauseUntilText: s.pauseUntilText,
    /* 终止：公告文本 + 标题 */
    notice: s.notice,
    noticeTitle: cfg.REVIEW_STOP_TITLE,
    /* 其它 */
    runningSinceText: s.runningSinceText,
    updatedAt: s.updatedAt,
    updatedAtText: s.updatedAtText,
    updatedBy: s.updatedBy,
    updatedByName: s.updatedByName,
    /* 前台是否需要拦截提交（终止 = 停止新人入社申请） */
    blockSubmit: s.status === cfg.REVIEW_STATUS.STOPPED
  };
}

function history(limit) {
  const s = read();
  return s.history.slice(0, Number(limit) || 20);
}

/** 'YYYY-MM-DDTHH:mm'（datetime-local）→ 东八区时间戳 */
function parseCnDateTime(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  if (!m) return NaN;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4] || '00'}:${m[5] || '00'}:00+08:00`);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * 校验一次状态变更请求
 * @returns {{error?:string, value?:object}}
 */
function validate(body, now) {
  const t = Number(now) || Date.now();
  const action = String((body && body.action) || '').trim();
  if (!Object.values(cfg.REVIEW_ACTIONS).includes(action)) {
    return { error: '无效的操作（应为 start / pause / stop）' };
  }
  if (action === cfg.REVIEW_ACTIONS.START) {
    return { value: { action, status: cfg.REVIEW_STATUS.RUNNING } };
  }
  if (action === cfg.REVIEW_ACTIONS.PAUSE) {
    const reason = String((body && body.reason) || '').trim().slice(0, 300);
    if (!reason) return { error: '请填写暂停原因' };
    const untilRaw = String((body && body.pauseUntil) || '').trim();
    if (!untilRaw) return { error: '请填写预计恢复时间' };
    const until = parseCnDateTime(untilRaw);
    if (!Number.isFinite(until)) return { error: '预计恢复时间格式不正确（请使用日期时间选择器）' };
    if (until <= t) return { error: '预计恢复时间必须晚于当前时间' };
    return { value: { action, status: cfg.REVIEW_STATUS.PAUSED, reason, pauseUntil: until, pauseUntilText: cnTime(until) } };
  }
  /* stop */
  const notice = String((body && body.notice) || '').trim().slice(0, 1000);
  if (!notice) return { error: '请填写通告文本' };
  return { value: { action, status: cfg.REVIEW_STATUS.STOPPED, notice } };
}

/**
 * 应用一次状态变更（会落盘并记录历史）
 * @param {{action:string, reason?:string, pauseUntil?:string, notice?:string, by?:string, byName?:string, now?:number}} input
 */
function apply(input) {
  const now = Number(input && input.now) || Date.now();
  const { error, value } = validate(input, now);
  if (error) return { ok: false, error };

  const d = read();
  const prev = d.status;
  const next = value.status;

  d.status = next;
  d.updatedAt = now;
  d.updatedAtText = cnTime(now);
  d.updatedBy = (input && input.by) || '';
  d.updatedByName = (input && input.byName) || (input && input.by) || '';

  if (next === cfg.REVIEW_STATUS.PAUSED) {
    d.reason = value.reason;
    d.pauseUntil = value.pauseUntil;
    d.pauseUntilText = value.pauseUntilText;
    /* 暂停时保留上一次的通告文本？按需求互斥：暂停态只展示暂停信息 */
    d.notice = '';
  } else if (next === cfg.REVIEW_STATUS.STOPPED) {
    d.notice = value.notice;
    d.reason = '';
    d.pauseUntil = null;
    d.pauseUntilText = '';
  } else {
    d.reason = ''; d.notice = '';
    d.pauseUntil = null; d.pauseUntilText = '';
    d.runningSinceAt = now;
    d.runningSinceText = cnTime(now);
  }

  /* 操作记录（含未改变状态但重复保存的情况，便于追溯） */
  d.history.unshift({
    at: now,
    atText: cnTime(now),
    from: prev,
    fromLabel: cfg.REVIEW_STATUS_LABEL[prev] || prev,
    to: next,
    toLabel: cfg.REVIEW_STATUS_LABEL[next] || next,
    action: value.action,
    changed: prev !== next,
    reason: value.reason || '',
    pauseUntilText: value.pauseUntilText || '',
    notice: value.notice || '',
    by: d.updatedBy,
    byName: d.updatedByName
  });
  if (d.history.length > cfg.REVIEW_HISTORY_MAX) d.history.length = cfg.REVIEW_HISTORY_MAX;

  write(d);
  return { ok: true, state: d, changed: prev !== next, prevStatus: prev };
}

module.exports = {
  current, publicView, history, validate, apply, parseCnDateTime,
  blank, FILE,
  STATUS: cfg.REVIEW_STATUS, STATUS_LABEL: cfg.REVIEW_STATUS_LABEL, ACTIONS: cfg.REVIEW_ACTIONS
};
