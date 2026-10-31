'use strict';

/* =========================================================================
 * 催促审核 单元测试
 *
 *   node tools/urge-test.js
 *
 * 规则：
 *   · 只有「已提交申请（submitted）」「已提交复审申请（resubmitted）」可以催促
 *   · 同一申请 1 小时内最多成功催促 1 次（冷却），冷却期内再催要被拒
 *   · 终审（通过 / 不通过）与退回 / 查看中 / 移交 / 介入中 都不接收催促
 *   · 每次成功催促：urge_count +1、刷新 last_urge_time、追加一条操作日志（含 IP，最多 20 条）
 * ========================================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'club-urge-test-'));
process.env.DATA_DIR = TMP;

const store = require('../lib/store');
const { STATUS, URGE_COOLDOWN_MS, URGE_LOG_MAX } = require('../lib/config');

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✅ ' + n); }
  else { fail++; console.log('  ❌ ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e) : '')); }
};

const NOW = Date.parse('2026-10-03T12:00:00+08:00');
const MIN = 60 * 1000;

console.log('\n[1] 配置');
ok('默认冷却为 60 分钟', URGE_COOLDOWN_MS === 60 * 60 * 1000, URGE_COOLDOWN_MS);
ok('催促日志上限 20 条', URGE_LOG_MAX === 20, URGE_LOG_MAX);

console.log('\n[2] 可催促的状态');
for (const s of [STATUS.SUBMITTED, STATUS.RESUBMITTED]) {
  const r = store.urgeState({ status: s, urgeCount: 0 }, NOW);
  ok(`${s} → 可催促`, r.allowed === true, r);
}
console.log('\n[3] 不可催促的状态');
const blocked = [
  [STATUS.VIEWING, '审核员查看中'],
  [STATUS.RETURNED, '已退回'],
  [STATUS.ESCALATED, '已移交主审核官'],
  [STATUS.INTERVENED, '主审核官介入中']
];
for (const [s, label] of blocked) {
  const r = store.urgeState({ status: s, urgeCount: 0 }, NOW);
  ok(`${label}（${s}）→ 不可催促`, r.allowed === false && r.terminal === false, r);
}
console.log('\n[4] 终审状态直接标记为已结束');
for (const s of [STATUS.APPROVED, STATUS.REJECTED]) {
  const r = store.urgeState({ status: s, urgeCount: 0 }, NOW);
  ok(`${s} → 不可催促且 terminal = true`, r.allowed === false && r.terminal === true && r.reason === 'terminal', r);
}

console.log('\n[5] 1 小时冷却');
const mk = lastMin => store.urgeState({ status: STATUS.SUBMITTED, urgeCount: 1, lastUrgeAt: NOW - lastMin * MIN }, NOW);
ok('刚催过 → 拒绝', mk(0).allowed === false && mk(0).reason === 'cooldown');
ok('30 分钟前催过 → 还有 30 分钟冷却',
  mk(30).cooldownLeftMs === 30 * MIN, mk(30).cooldownLeftMs);
ok('59 分钟前催过 → 还剩 1 分钟', mk(59).cooldownLeftMs === 1 * MIN, mk(59).cooldownLeftMs);
ok('正好 60 分钟 → 冷却结束，可以再催', mk(60).allowed === true && mk(60).cooldownLeftMs === 0);
ok('61 分钟前催过 → 可以再催', mk(61).allowed === true);
ok('冷却中 allowed 为 false 但 statusOk 仍为 true', mk(10).statusOk === true && mk(10).allowed === false);

console.log('\n[6] applyUrge：计数、时间与日志');
const rec = store.normalizeApplication({ id: 'A1', seq: 1, cn: '催促君', status: STATUS.SUBMITTED });
ok('初始 urgeCount = 0', rec.urgeCount === 0, rec.urgeCount);
ok('初始 lastUrgeAt 为空', rec.lastUrgeAt === null && rec.lastUrgeAtText === '');
ok('初始日志为空数组', Array.isArray(rec.urgeLog) && rec.urgeLog.length === 0);
store.applyUrge(rec, { ip: '1.2.3.4', now: NOW });
ok('第 1 次催促后 urgeCount = 1', rec.urgeCount === 1, rec.urgeCount);
ok('记录了 last_urge_time', rec.lastUrgeAt === NOW, rec.lastUrgeAt);
ok('记录了东八区时间文本', /^2026-10-03 12:00:00$/.test(rec.lastUrgeAtText), rec.lastUrgeAtText);
ok('日志里记下了来源 IP', rec.urgeLog[0].ip === '1.2.3.4', rec.urgeLog[0]);
store.applyUrge(rec, { ip: '5.6.7.8', now: NOW + 61 * MIN });
ok('第 2 次催促后 urgeCount = 2', rec.urgeCount === 2, rec.urgeCount);
ok('最新日志排在最前', rec.urgeLog[0].ip === '5.6.7.8', rec.urgeLog.map(x => x.ip));
ok('冷却时间以最后一次为准',
  store.urgeState(rec, NOW + 61 * MIN).allowed === false &&
  store.urgeState(rec, NOW + 61 * MIN).cooldownLeftMs === 60 * MIN,
  store.urgeState(rec, NOW + 61 * MIN));
for (let i = 0; i < 30; i++) store.applyUrge(rec, { ip: 'x', now: NOW + i * MIN });
ok('日志最多保留 20 条（自动裁剪）', rec.urgeLog.length === URGE_LOG_MAX, rec.urgeLog.length);

console.log('\n[7] 旧数据迁移与汇总字段');
const legacy = store.normalizeApplication({ id: 'A2', seq: 2, cn: '老数据', status: STATUS.SUBMITTED });
ok('老记录补齐 urgeCount / lastUrgeAt / urgeLog',
  legacy.urgeCount === 0 && legacy.lastUrgeAt === null && Array.isArray(legacy.urgeLog), legacy);
ok('异常值被归一化（负数 → 0）',
  store.normalizeApplication({ id: 'A3', cn: 'x', status: STATUS.SUBMITTED, urgeCount: -5 }).urgeCount === 0);
ok('异常值被归一化（字符串 → 数字）',
  store.normalizeApplication({ id: 'A4', cn: 'x', status: STATUS.SUBMITTED, urgeCount: '3' }).urgeCount === 3);
const sum = store.summaryOf(Object.assign({}, rec, { department: 'COS部' }));
ok('summary 带 urgeCount（列表红色标签用）', sum.urgeCount === rec.urgeCount, sum.urgeCount);
ok('summary 带 urged 布尔（筛选用）', sum.urged === true);
ok('summary 带最近催促时间', !!sum.lastUrgeAtText, sum.lastUrgeAtText);
ok('未催促的记录 urged = false',
  store.summaryOf(store.normalizeApplication({ id: 'A5', cn: 'y', status: STATUS.SUBMITTED })).urged === false);

console.log('\n==================================================');
console.log(` 通过 ${pass} 项，失败 ${fail} 项`);
console.log('==================================================');
process.exit(fail ? 1 : 0);
