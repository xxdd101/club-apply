'use strict';

/* =========================================================================
 * 账号停用「到期自动解封」逻辑单元测试
 *
 *   node tools/ban-expiry-test.js
 *
 * 为什么单独测：自动解封依赖"当前时间超过解封日期"，走 HTTP 接口无法在
 * 测试里把日期拨到过去（接口按需求只接受未来日期）。这里用独立的临时
 * 数据目录直接测 store 的判定逻辑。
 * ========================================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');

/* 必须在 require store 之前指定数据目录 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'club-ban-test-'));
process.env.DATA_DIR = TMP;

const store = require('../lib/store');
const { cnDate, dateStrToTs } = require('../lib/util');

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✅ ' + n); }
  else { fail++; console.log('  ❌ ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e) : '')); }
};
const DAY = 24 * 3600 * 1000;

console.log('临时数据目录:', TMP, '\n');

/* 造两个子账号 */
const mk = (id, name) => {
  const a = {
    id, username: name, role: 'sub', salt: 's', hash: 'h', note: '',
    createdAt: Date.now(), createdAtText: '', createdBy: 'test', lastLoginAt: null, lastLoginAtText: ''
  };
  store.normalizeAdmin(a);
  store.adminDb.admins.push(a);
  return a;
};
const future = mk('A1', '未来解封');
const today = mk('A2', '今天解封');
const past = mk('A3', '已过期');

console.log('--- 1. 未停用的账号 ---');
ok('banActive = false', store.banActive(future) === false);

console.log('\n--- 2. 停用到「明天」→ 应处于停用中 ---');
store.applyBan(future, dateStrToTs(ymd(Date.now() + DAY)), '测试理由', 'admin');
ok('banActive = true', store.banActive(future) === true);
ok('解封日期文本为中文格式', /^\d{4}年\d{2}月\d{2}日$/.test(future.banUntilText), future.banUntilText);
ok('停用开始时间已记录', !!future.bannedAtText, future.bannedAtText);
ok('封禁理由已保存', future.banReason === '测试理由', future.banReason);

console.log('\n--- 3. 解封日期就是今天 00:00（已到达）→ 应视为未停用 ---');
store.applyBan(today, dateStrToTs(ymd(Date.now())), '今天到期', 'admin');   // 今天 00:00，早已过去
ok('banActive = false（到期即失效）', store.banActive(today) === false);

console.log('\n--- 4. 解封日期在过去 → 同样应视为未停用 ---');
store.applyBan(past, dateStrToTs(ymd(Date.now() - 3 * DAY)), '已过期', 'admin');
ok('banActive = false', store.banActive(past) === false);

console.log('\n--- 5. clearExpiredBans() 应清掉到期的、保留未到期的 ---');
const changed = store.clearExpiredBans();
ok('返回 true（有记录被清理）', changed === true);
ok('到期的「今天解封」已清除字段', today.banned === false && today.banUntil === null && today.banReason === '', today);
ok('到期的「已过期」已清除字段', past.banned === false && past.banReason === '', past);
ok('未到期的「未来解封」保持不变', future.banned === true && future.banReason === '测试理由');

console.log('\n--- 6. 解除停用 ---');
store.liftBan(future);
ok('liftBan 后 banActive = false', store.banActive(future) === false);
ok('相关字段被清空', !future.banUntil && !future.banReason && !future.bannedAtText, future);

console.log('\n--- 7. 停用信息是否随 publicAdmin 正确输出 ---');
store.applyBan(future, dateStrToTs(ymd(Date.now() + 5 * DAY)), '违规', 'admin');
const pub = store.publicAdmin(future);
ok('publicAdmin.banned = true', pub.banned === true);
ok('输出解封日期文本', !!pub.banUntilText, pub.banUntilText);
ok('输出 YYYY-MM-DD（供日期控件回填）', /^\d{4}-\d{2}-\d{2}$/.test(pub.banUntilYmd), pub.banUntilYmd);
ok('输出封禁理由', pub.banReason === '违规', pub.banReason);
ok('不泄露口令散列', !('hash' in pub) && !('salt' in pub), Object.keys(pub));

/* 清理 */
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }

console.log(`\n==================================================`);
console.log(` 通过 ${pass} 项，失败 ${fail} 项`);
console.log('==================================================');
process.exit(fail ? 1 : 0);

function ymd(ts) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(ts).reduce((o, x) => (o[x.type] = x.value, o), {});
  return `${p.year}-${p.month}-${p.day}`;
}
