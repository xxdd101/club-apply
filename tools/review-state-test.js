'use strict';

/* =========================================================================
 * 审核系统开关（启动 / 暂停 / 终止）单元测试
 *
 *   node tools/review-state-test.js
 *
 * 规则：
 *   · 默认 running（启动审核系统）
 *   · paused  需 暂停原因 + 预计恢复时间（必须晚于当前时间）
 *   · stopped 需 通告文本（不需要预计恢复时间），且 blockSubmit = true
 *   · running 清空暂停/终止信息并记录启动时间
 *   · 所有操作（含重复设置同一状态）都写入变更记录，落盘 data/review-state.json
 * ========================================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'club-rstate-test-'));
process.env.DATA_DIR = TMP;

const rs = require('../lib/review-state');
const cfg = require('../lib/config');

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✅ ' + n); }
  else { fail++; console.log('  ❌ ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e) : '')); }
};

const NOW = Date.parse('2026-10-14T10:00:00+08:00');
const future = '2026-10-17T09:30';
const past = '2026-10-13T09:30';

console.log('\n[1] 默认状态');
const pv0 = rs.publicView();
ok('默认 running', pv0.status === 'running' && pv0.running === true, pv0.status);
ok('状态文案为「审核系统运行中」', pv0.statusLabel === '审核系统运行中', pv0.statusLabel);
ok('默认不拦截提交', pv0.blockSubmit === false);
ok('默认没有暂停原因 / 通告', pv0.reason === '' && pv0.notice === '');
ok('终止公告标题与需求一致',
  pv0.noticeTitle === '示例动漫社团暂时停止新人入社申请', pv0.noticeTitle);
ok('初始没有变更记录', rs.history(10).length === 0);

console.log('\n[2] 校验规则');
ok('非法 action 被拒', /无效的操作/.test(rs.validate({ action: 'x' }, NOW).error));
ok('暂停缺原因被拒', rs.validate({ action: 'pause' }, NOW).error === '请填写暂停原因');
ok('暂停缺预计恢复时间被拒', rs.validate({ action: 'pause', reason: 'r' }, NOW).error === '请填写预计恢复时间');
ok('暂停时间格式非法被拒',
  /格式不正确/.test(rs.validate({ action: 'pause', reason: 'r', pauseUntil: '不是时间' }, NOW).error));
ok('暂停时间早于当前被拒',
  /晚于当前时间/.test(rs.validate({ action: 'pause', reason: 'r', pauseUntil: past }, NOW).error));
ok('终止缺通告被拒', rs.validate({ action: 'stop' }, NOW).error === '请填写通告文本');
ok('合法暂停通过', !rs.validate({ action: 'pause', reason: 'r', pauseUntil: future }, NOW).error);
ok('合法终止通过', !rs.validate({ action: 'stop', notice: 'n' }, NOW).error);
ok('启动无需额外字段', !rs.validate({ action: 'start' }, NOW).error);

console.log('\n[3] 暂停');
const a = rs.apply({ action: 'pause', reason: '期末周暂停审核', pauseUntil: future, by: 'admin', byName: '赛博', now: NOW });
ok('暂停成功', a.ok === true && a.changed === true, a.error);
const pvP = rs.publicView(a.state);
ok('状态 = paused 且 blockSubmit = false', pvP.status === 'paused' && pvP.blockSubmit === false, pvP);
ok('记录暂停原因', pvP.reason === '期末周暂停审核', pvP.reason);
ok('暂停时间 = 操作时间', pvP.pausedAtText === '2026-10-14 10:00:00', pvP.pausedAtText);
ok('预计恢复时间按东八区解析', pvP.pauseUntilText === '2026-10-17 09:30:00', pvP.pauseUntilText);

console.log('\n[4] 终止');
const b = rs.apply({ action: 'stop', notice: '本轮招新已结束', by: 'admin', byName: '赛博', now: NOW + 1000 });
ok('终止成功', b.ok === true && b.changed === true, b.error);
const pvS = rs.publicView(b.state);
ok('状态 = stopped 且 blockSubmit = true', pvS.status === 'stopped' && pvS.blockSubmit === true, pvS);
ok('保存通告文本', pvS.notice === '本轮招新已结束', pvS.notice);
ok('终止后不残留暂停信息', pvS.reason === '' && pvS.pauseUntilText === '' && pvS.pausedAtText === '', pvS);

console.log('\n[5] 重新启动');
const c = rs.apply({ action: 'start', by: 'admin', now: NOW + 2000 });
ok('启动成功', c.ok === true && c.changed === true, c.error);
const pvR = rs.publicView(c.state);
ok('状态 = running', pvR.status === 'running' && pvR.running === true, pvR.status);
ok('清空暂停与通告', pvR.reason === '' && pvR.notice === '' && pvR.pauseUntilText === '', pvR);
ok('记录启动时间', pvR.runningSinceText === '2026-10-14 10:00:02', pvR.runningSinceText);
ok('恢复后不拦截提交', pvR.blockSubmit === false);

console.log('\n[6] 重复设置同一状态（也要留痕）');
const d = rs.apply({ action: 'start', by: 'admin', now: NOW + 3000 });
ok('返回 ok 但 changed = false', d.ok === true && d.changed === false, d);

console.log('\n[7] 变更记录与落盘');
const h = rs.history(10);
ok('共 4 条记录（含重复启动）', h.length === 4, h.length);
ok('最新一条在最前', h[0].action === 'start' && h[0].changed === false, h[0]);
ok('记录里有 运行中→已暂停', h.some(x => x.from === 'running' && x.to === 'paused'), h.map(x => x.from + '→' + x.to));
ok('记录里有 已暂停→已终止', h.some(x => x.from === 'paused' && x.to === 'stopped'));
ok('记录里有 已终止→运行中', h.some(x => x.from === 'stopped' && x.to === 'running'));
ok('记录含操作人 / 时间 / 原因', h.every(x => x.by && x.atText), h[0]);
ok('记录含暂停原因与通告', h.some(x => x.reason) && h.some(x => x.notice));
ok('历史条目上限受配置约束', cfg.REVIEW_HISTORY_MAX >= 10, cfg.REVIEW_HISTORY_MAX);
ok('状态文件已落盘', fs.existsSync(rs.FILE), rs.FILE);
const onDisk = JSON.parse(fs.readFileSync(rs.FILE, 'utf8'));
ok('磁盘上的状态与内存一致', onDisk.status === 'running' && onDisk.history.length === 4, onDisk.status);
ok('磁盘文件不包含任何业务数据（只有开关状态）',
  !JSON.stringify(onDisk).includes('applications') && !!onDisk.history);

console.log('\n[8] 时间解析（东八区）');
ok('YYYY-MM-DDTHH:mm 解析正确',
  rs.parseCnDateTime('2026-10-17T09:30') === Date.parse('2026-10-17T09:30:00+08:00'));
ok('只给日期按 00:00 处理',
  rs.parseCnDateTime('2026-10-17') === Date.parse('2026-10-17T00:00:00+08:00'));
ok('空值返回 NaN', Number.isNaN(rs.parseCnDateTime('')));
ok('非法值返回 NaN', Number.isNaN(rs.parseCnDateTime('2026/10/17')));

console.log('\n==================================================');
console.log(` 通过 ${pass} 项，失败 ${fail} 项`);
console.log('==================================================');
process.exit(fail ? 1 : 0);
