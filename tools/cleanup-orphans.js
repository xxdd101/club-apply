#!/usr/bin/env node
'use strict';

/* =========================================================================
 * 清理孤儿上传文件与失效缩略图
 *
 *   用法：node tools/cleanup-orphans.js [--dry-run]
 *
 * 背景：上传接口无需登录（申请人填表时就要能传图），因此有人可以只上传
 *       但不提交申请，文件会永久留在磁盘上，最终把盘写满导致服务崩溃。
 *       本脚本删除「没有被任何申请引用、且超过宽限期」的文件。
 *
 * 保护措施：
 *   - 只删除 uploads/ 与 thumbs/ 下的文件，不动别的
 *   - 宽限期默认 6 小时（ORPHAN_GRACE_HOURS 可调），避免误删正在填写中的文件
 *   - 只要读取申请数据失败就整体中止，绝不在数据不可信时删东西
 * ========================================================================= */

const fs = require('fs');
const path = require('path');
const cfg = require('../lib/config');

const DRY = process.argv.includes('--dry-run');
const GRACE_MS = Number(process.env.ORPHAN_GRACE_HOURS || 6) * 3600 * 1000;
const now = Date.now();

function human(n) {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return Math.round(n / 1024) + ' KB';
}

/* 1. 读出所有被引用到的文件名（读不到就中止，绝不在数据不可信时删除） */
let referenced;
try {
  const db = JSON.parse(fs.readFileSync(cfg.APP_DB_FILE, 'utf8'));
  referenced = new Set();
  for (const a of db.applications || []) {
    for (const u of a.workImages || []) {
      const n = path.basename(String(u).split('?')[0]);
      if (n) referenced.add(n);
    }
    if (a.workAudio) {
      const n = path.basename(String(a.workAudio).split('?')[0]);
      if (n) referenced.add(n);
    }
  }
} catch (e) {
  console.error('[清理] 无法读取申请数据，为安全起见中止：', e.message);
  process.exit(1);
}

console.log(`[清理] 被引用的附件：${referenced.size} 个`);
console.log(`[清理] 宽限期：${GRACE_MS / 3600000} 小时${DRY ? '   （DRY-RUN，只报告不删除）' : ''}`);

/* 2. 清理 uploads/ 下的孤儿文件 */
let orphans = 0, orphanBytes = 0, kept = 0;
let entries = [];
try { entries = fs.readdirSync(cfg.UPLOAD_DIR); } catch (e) { console.error('[清理] 读取上传目录失败：', e.message); }

for (const name of entries) {
  const fp = path.join(cfg.UPLOAD_DIR, name);
  let st;
  try { st = fs.statSync(fp); } catch (e) { continue; }
  if (!st.isFile()) continue;
  if (referenced.has(name)) { kept++; continue; }
  if (now - st.mtimeMs < GRACE_MS) { kept++; continue; }   // 可能正在填写中
  orphans++;
  orphanBytes += st.size;
  console.log(`  孤儿文件 ${name}  ${human(st.size)}  (${new Date(st.mtimeMs).toLocaleString('zh-CN')})`);
  if (!DRY) { try { fs.unlinkSync(fp); } catch (e) { console.error('    删除失败：', e.message); } }
}
console.log(`[清理] 上传目录：保留 ${kept} 个，${DRY ? '待删除' : '已删除'} ${orphans} 个（释放 ${human(orphanBytes)}）`);

/* 3. 清理 thumbs/ 里源文件已不存在的缓存 */
let thumbGone = 0, thumbBytes = 0;
let thumbs = [];
try { thumbs = fs.readdirSync(cfg.THUMB_DIR); } catch (e) { /* 忽略 */ }
for (const name of thumbs) {
  const fp = path.join(cfg.THUMB_DIR, name);
  let st;
  try { st = fs.statSync(fp); } catch (e) { continue; }
  if (!st.isFile()) continue;
  const base = name.replace(/\.[^.]+$/, '');
  // 原始文件可能是 .jpg/.png/.wav/.mp3，任一存在就保留
  const alive = ['jpg', 'jpeg', 'png', 'wav', 'mp3']
    .some(ext => fs.existsSync(path.join(cfg.UPLOAD_DIR, base + '.' + ext)));
  if (alive) continue;
  thumbGone++;
  thumbBytes += st.size;
  if (!DRY) { try { fs.unlinkSync(fp); } catch (e) { /* 忽略 */ } }
}
console.log(`[清理] 缩略图缓存：${DRY ? '待删除' : '已删除'} ${thumbGone} 个（${human(thumbBytes)}）`);

/* 4. 汇总当前占用 */
function dirSize(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      try { total += fs.statSync(path.join(dir, f)).size; } catch (e) { /* 忽略 */ }
    }
  } catch (e) { /* 忽略 */ }
  return total;
}
console.log(`[清理] 当前占用：uploads ${human(dirSize(cfg.UPLOAD_DIR))} / thumbs ${human(dirSize(cfg.THUMB_DIR))}`);
