'use strict';

/* =========================================================================
 * 命令行导出 Excel（用于自动化备份 / 部署后自检）
 *
 *   node tools/export-cli.js [输出文件] [服务地址]
 *
 *   例：node tools/export-cli.js backup.xlsx http://127.0.0.1:3000
 *
 *   账号密码取环境变量 ADMIN_USER / ADMIN_PASS（默认 admin / change-this-password）
 * ========================================================================= */

const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] || path.join(__dirname, '_probe', 'cli-export.xlsx');
const BASE = (process.argv[3] || process.env.BASE || 'http://127.0.0.1:' + (process.env.PORT || 3000)).replace(/\/$/, '');
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || 'change-this-password';

(async () => {
  const loginRes = await fetch(BASE + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS })
  });
  const login = await loginRes.json().catch(() => null);
  if (!login || !login.ok) {
    console.error('登录失败：' + ((login && login.error) || loginRes.status));
    process.exit(1);
  }

  const res = await fetch(BASE + '/api/export', {
    headers: { Authorization: 'Bearer ' + login.token }
  });
  if (!res.ok) {
    console.error('导出失败：HTTP ' + res.status);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, buf);
  console.log(`导出成功：${path.resolve(OUT)}（${buf.length} 字节）`);
  console.log('可用 python tools/verify_xlsx.py "' + OUT + '" 校验图片是否已内嵌。');
})().catch(e => { console.error('异常：' + e.message); process.exit(1); });
