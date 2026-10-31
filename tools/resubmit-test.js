'use strict';

/* =========================================================================
 * 复审机会规则单元测试（2026-10-01 修改版）
 *
 *   node tools/resubmit-test.js
 *
 * 规则：
 *   · 初审【审核拒绝】  → 1 次机会（第 1 次）
 *   · 初审【退回】      → 1 次机会（第 1 次）
 *   · 复审后【被退回】  → 额外 1 次机会（第 2 次）
 *   · 复审后【被拒绝】  → 不再提供机会
 *   · 上限 2 次，用尽后按钮永久隐藏
 *   · 只有【审核拒绝】【退回】可能显示按钮，其余状态一律不显示
 * ========================================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'club-resubmit-test-'));
process.env.DATA_DIR = TMP;

const store = require('../lib/store');
const { STATUS, MAX_RESUBMITS } = require('../lib/config');

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✅ ' + n); }
  else { fail++; console.log('  ❌ ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e) : '')); }
};
const st = (status, resubmitCount) => store.resubmitState({ status, resubmitCount });
const label = (status, count) => `${status}(已复审${count}次)`;

console.log('\n[1] 上限与全局开关');
ok('复审上限为 2 次', MAX_RESUBMITS === 2, MAX_RESUBMITS);

console.log('\n[2] 初审拒绝：只有第 1 次机会');
ok('审核拒绝 + 未复审过 → 显示按钮', st(STATUS.REJECTED, 0).canResubmit === true);
ok('  · 下一次是第 1 次', st(STATUS.REJECTED, 0).nextNo === 1);
ok('  · 不是最后一次（还有第 2 次可能）', st(STATUS.REJECTED, 0).isLast === false);
ok('审核拒绝 + 已复审 1 次 → 不显示按钮（复审被拒即结束）', st(STATUS.REJECTED, 1).canResubmit === false);
ok('  · 已结束标记为 true', st(STATUS.REJECTED, 1).ended === true);
ok('  · 结束原因是「复审申请已被审核拒绝」',
  /复审申请已被审核拒绝/.test(st(STATUS.REJECTED, 1).reason), st(STATUS.REJECTED, 1).reason);
ok('审核拒绝 + 已复审 2 次 → 不显示按钮', st(STATUS.REJECTED, 2).canResubmit === false);
ok('  · 结束原因优先说「次数用尽」', /已用完 2 次/.test(st(STATUS.REJECTED, 2).reason), st(STATUS.REJECTED, 2).reason);

console.log('\n[3] 初审退回 / 复审退回：可以提交');
ok('退回 + 未复审过 → 显示按钮（初审被退回也给 1 次）', st(STATUS.RETURNED, 0).canResubmit === true);
ok('退回 + 已复审 1 次 → 显示按钮（这是第 2 次，最后一次）', st(STATUS.RETURNED, 1).canResubmit === true);
ok('  · 标记为最后一次', st(STATUS.RETURNED, 1).isLast === true);
ok('  · 下一次是第 2 次', st(STATUS.RETURNED, 1).nextNo === 2);
ok('退回 + 已复审 2 次 → 不显示按钮（次数用尽）', st(STATUS.RETURNED, 2).canResubmit === false);
ok('  · 已结束', st(STATUS.RETURNED, 2).ended === true);

console.log('\n[4] 其它状态一律不显示按钮（需求第 5 条）');
for (const s of [STATUS.SUBMITTED, STATUS.VIEWING, STATUS.RESUBMITTED, STATUS.APPROVED, STATUS.ESCALATED]) {
  for (const n of [0, 1, 2]) {
    ok(`${label(s, n)} → 不显示按钮`, st(s, n).canResubmit === false);
  }
}
ok('已提交复审（等待审核）时给出「状态不支持」的原因',
  /当前状态不支持/.test(st(STATUS.RESUBMITTED, 1).reason), st(STATUS.RESUBMITTED, 1).reason);
ok('审核通过后 ended 为 false（已终结但不是"机会用尽"）', st(STATUS.APPROVED, 1).ended === false);

console.log('\n[5] 完整流程推演（初审拒绝 → 复审1 被退回 → 复审2）');
const flow = [];
let rec = { status: STATUS.REJECTED, resubmitCount: 0 };
flow.push(['初审拒绝', st(rec.status, rec.resubmitCount).canResubmit]);
const submit = r => { r.resubmitCount += 1; r.status = STATUS.RESUBMITTED; };
submit(rec);
flow.push(['提交复审1（审核中）', st(rec.status, rec.resubmitCount).canResubmit]);
rec.status = STATUS.RETURNED;                                     // 复审1 被退回
flow.push(['复审1 被退回', st(rec.status, rec.resubmitCount).canResubmit]);
submit(rec);
flow.push(['提交复审2（审核中）', st(rec.status, rec.resubmitCount).canResubmit]);
rec.status = STATUS.RETURNED;                                     // 复审2 又被退回
flow.push(['复审2 被退回', st(rec.status, rec.resubmitCount).canResubmit]);
ok('流程：初审拒绝 ✅ → 复审1 ❌ → 复审1被退回 ✅ → 复审2 ❌ → 复审2被退回 ❌',
  JSON.stringify(flow.map(x => x[1])) === JSON.stringify([true, false, true, false, false]), flow);

console.log('\n[6] 另一条流程（初审拒绝 → 复审1 被拒绝 → 结束）');
const flow2 = [];
let r2 = { status: STATUS.REJECTED, resubmitCount: 0 };
flow2.push(['初审拒绝', st(r2.status, r2.resubmitCount).canResubmit]);
submit(r2);
r2.status = STATUS.REJECTED;                                      // 复审1 被拒绝
flow2.push(['复审1 被拒绝', st(r2.status, r2.resubmitCount).canResubmit]);
ok('流程：初审拒绝 ✅ → 复审1 ❌（被拒绝后永久结束）',
  JSON.stringify(flow2.map(x => x[1])) === JSON.stringify([true, false]), flow2);
ok('  · 复审被拒后理由明确指向"被拒绝"而不是"状态不支持"',
  /已被审核拒绝/.test(st(r2.status, r2.resubmitCount).reason), st(r2.status, r2.resubmitCount).reason);

console.log('\n[7] 旧数据迁移（只有 resubmitUsed 布尔标记的老记录）');
const legacy = store.normalizeApplication({
  id: 'A1', seq: 1, cn: '老数据', status: STATUS.RETURNED, resubmitUsed: true
});
ok('resubmitUsed=true → resubmitCount 迁移为 1', legacy.resubmitCount === 1, legacy.resubmitCount);
ok('迁移后这类记录还能再用 1 次机会（复审被退回 → 复审2）',
  store.resubmitState(legacy).canResubmit === true);
const legacy2 = store.normalizeApplication({ id: 'A2', seq: 2, cn: '老数据2', status: STATUS.REJECTED });
ok('没有 resubmitUsed 的记录 → 次数为 0', legacy2.resubmitCount === 0, legacy2.resubmitCount);
ok('resubmitUsed 是 resubmitCount>0 的派生展示字段', legacy2.resubmitUsed === false);

console.log('\n[8] 汇总给后台列表的字段');
const sum = store.summaryOf({ id: 'A3', seq: 3, cn: 'x', department: 'COS部', status: STATUS.RETURNED, resubmitCount: 1 });
ok('summary 带 resubmitCount / resubmitMax / resubmitCan',
  sum.resubmitCount === 1 && sum.resubmitMax === 2 && sum.resubmitCan === true, sum);

console.log('\n==================================================');
console.log(` 通过 ${pass} 项，失败 ${fail} 项`);
console.log('==================================================');
process.exit(fail ? 1 : 0);
