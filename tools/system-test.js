'use strict';

/* =========================================================================
 * 【系统设置 / 重启服务器】单元测试
 *
 *   node tools/system-test.js
 *
 * 为什么单独测：
 *   · 「冷却时间 / 下次 00:00 计算 / 定时任务是否已安装」都是纯逻辑，走 HTTP 不好造；
 *   · **安全**：这里绝不会真的重启任何机器 —— 非演练分支把 REBOOT_CMD 指向一个
 *     不存在的路径，只验证「失败会被如实上报 + 请求照样进审计」；
 *   · 还会对 root 重启脚本做静态体检：必须拒绝非 root、必须先 sync、必须不碰任何业务数据。
 * ========================================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');

/* 必须在 require config 之前指定数据目录 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'club-system-test-'));
process.env.DATA_DIR = TMP;
process.env.REBOOT_SCHEDULE_FILE = path.join(TMP, 'club-reboot.cron');
delete process.env.REBOOT_DRY_RUN;

const cfg = require('../lib/config');
const system = require('../lib/system');

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✅ ' + n); }
  else { fail++; console.log('  ❌ ' + n + (e !== undefined ? ' :: ' + JSON.stringify(e) : '')); }
};

(async () => {
  console.log('\n[1] 每日 00:00 的下一次触发时间（东八区）');
  const cases = [
    ['2026-10-01T00:00:01+08:00', '2026-10-01T16:00:00.000Z'],   // 刚过零点 → 明天
    ['2026-10-01T12:00:00+08:00', '2026-10-01T16:00:00.000Z'],   // 中午 → 今晚
    ['2026-10-01T23:59:59+08:00', '2026-10-01T16:00:00.000Z'],   // 差 1 秒 → 今晚
    ['2026-10-02T00:00:00+08:00', '2026-10-02T16:00:00.000Z']    // 正好零点 → 明天
  ];
  for (const [nowStr, want] of cases) {
    const got = new Date(system.nextScheduledAt(Date.parse(nowStr))).toISOString();
    ok(`${nowStr} → 下一次 ${want}`, got === want, got);
  }

  console.log('\n[2] 定时任务是否已安装（读 cron 文件）');
  ok('cron 文件不存在 → 未启用', system.scheduleInstalled() === false);
  fs.writeFileSync(process.env.REBOOT_SCHEDULE_FILE,
    '# 注释\nSHELL=/bin/bash\n0 0 * * * root /usr/local/bin/club-reboot.sh scheduled cron\n', 'utf8');
  ok('cron 文件里有生效行 → 已启用', system.scheduleInstalled() === true);
  fs.writeFileSync(process.env.REBOOT_SCHEDULE_FILE,
    '# 整行被注释掉 = 临时停用\n#0 0 * * * root /usr/local/bin/club-reboot.sh scheduled cron\n', 'utf8');
  ok('整行被注释掉 → 视为未启用', system.scheduleInstalled() === false);

  console.log('\n[3] 演练模式：记录请求但绝不重启');
  cfg.REBOOT_DRY_RUN = true;
  const dry = await system.executeReboot({ mode: 'manual', by: 'probe-test', ip: '127.0.0.1' });
  ok('返回成功 + dryRun 标记', dry.ok === true && dry.dryRun === true, dry);
  const log1 = system.readLog();
  ok('审计里记录了操作人', log1.lastRequest && log1.lastRequest.by === 'probe-test', log1.lastRequest);
  ok('审计里记录了模式与来源 IP',
    log1.lastRequest.mode === 'manual' && log1.lastRequest.ip === '127.0.0.1', log1.lastRequest);
  ok('审计时间文本为东八区格式',
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(log1.lastRequest.atText || ''), log1.lastRequest.atText);
  ok('演练不占用冷却时间', system.cooldownRemaining() === 0, system.cooldownRemaining());

  console.log('\n[4] 非演练 + 脚本不可用：必须如实报错，且请求照样进审计');
  cfg.REBOOT_DRY_RUN = false;
  cfg.REBOOT_CMD = path.join(TMP, 'not-exists-club-reboot.sh');   // 指向不存在 → 不会真的重启
  ok('canReboot() 为 false（脚本不可用）', system.canReboot() === false, system.canReboot());
  ok('给出不可用原因', /重启脚本未就绪|不是 Linux/.test(system.rebootBlockReason()), system.rebootBlockReason());
  const real = await system.executeReboot({ mode: 'manual', by: 'probe-test2', ip: '10.0.0.9' });
  ok('执行失败且返回错误说明（不会假装成功）', real.ok === false && !!real.error, real);
  const log2 = system.readLog();
  ok('失败也写入审计（可追溯）', log2.lastRequest.by === 'probe-test2', log2.lastRequest);
  ok('手动重启进入冷却（> 0）', system.cooldownRemaining() > 0, system.cooldownRemaining());
  ok('冷却上限不超过配置值',
    system.cooldownRemaining() <= cfg.REBOOT_COOLDOWN_MS, { left: system.cooldownRemaining(), max: cfg.REBOOT_COOLDOWN_MS });

  console.log('\n[5] 定时/自检模式都不会被当成"手动"（不占用手动冷却）');
  cfg.REBOOT_DRY_RUN = true;
  await system.executeReboot({ mode: 'scheduled', by: 'cron', ip: '' });
  cfg.REBOOT_DRY_RUN = false;
  const log3 = system.readLog();
  ok('最近一条是定时任务', log3.lastRequest.mode === 'scheduled', log3.lastRequest.mode);
  ok('审计历史保留多条（可追溯）', log3.history.length >= 3, log3.history.length);
  ok('history 最多保留 30 条', system.readLog().history.length <= 30, system.readLog().history.length);

  cfg.REBOOT_DRY_RUN = true;
  await system.executeReboot({ mode: 'selftest', by: 'ops-selftest', ip: '' });
  cfg.REBOOT_DRY_RUN = false;
  ok('自检模式不占用冷却时间', system.cooldownRemaining() === 0, system.cooldownRemaining());
  ok('审计里写明是自检、不重启', /自检/.test(system.readLog().lastRequest.reason), system.readLog().lastRequest.reason);

  console.log('\n[6] systemInfo 返回给前端的字段完整');
  cfg.REBOOT_DRY_RUN = true;
  const info = system.systemInfo({});
  const need = ['platform', 'hostname', 'serverTimeText', 'timezone', 'uptimeText', 'bootAtText',
    'canReboot', 'blockReason', 'dryRun', 'rebootDelaySeconds', 'cooldownMinutes', 'cooldownRemainingMs',
    'schedule', 'lastRequest', 'history', 'dataSafety'];
  const missing = need.filter(k => !(k in info));
  ok('字段齐全', missing.length === 0, missing);
  ok('schedule 含 cron / desc / enabled / nextAtText',
    info.schedule.cron === '0 0 * * *' && !!info.schedule.desc &&
    typeof info.schedule.enabled === 'boolean' && /00:00:00$/.test(info.schedule.nextAtText),
    info.schedule);
  ok('dataSafety 明确列出四类业务数据',
    ['applications.json', 'admins.json', 'uploads', 'thumbs'].every(k => info.dataSafety.join('|').includes(k)),
    info.dataSafety);
  ok('时区说明为东八区', info.timezone.includes('东八区') && info.timezone.includes('+8'), info.timezone);
  ok('运行时长文本可读', /分钟|小时|天/.test(info.uptimeText), info.uptimeText);

  console.log('\n[7] root 重启脚本静态体检（防止脚本被改坏成"会动数据"的东西）');
  /* 仓库里 deploy/ 放的是随项目一起发布的副本；_deploy-tools/ 是运维在现场用的那份 */
  const DEPLOY = path.join(__dirname, '..', 'deploy');
  const OPS = path.join(__dirname, '..', '..', '_deploy-tools');
  const pick = name => {
    const a = path.join(DEPLOY, name), b = path.join(OPS, name);
    if (fs.existsSync(a)) return a;
    if (fs.existsSync(b)) return b;
    throw new Error('找不到 ' + name);
  };
  const sh = fs.readFileSync(pick('club-reboot.sh'), 'utf8');
  /* 只看真正会执行的命令行，忽略注释（注释里为了说明"不碰数据"本来就会提到这些文件名） */
  const shCode = sh.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
  ok('脚本拒绝非 root 执行', /id -u/.test(shCode) && /需要 root/.test(shCode));
  ok('重启前先 sync 落盘', /\bsync\b/.test(shCode));
  ok('使用 shutdown -r / systemctl reboot 重启', /shutdown -r now/.test(shCode) && /systemctl reboot/.test(shCode));
  ok('有 2 分钟内防重复重启锁', /club-reboot\.lock/.test(shCode) && /-lt 120/.test(shCode));
  ok('脚本里没有任何删除/清空业务数据的动作',
    !/(rm\s+-|rm\s+\/|truncate|>\s*\/opt\/club-apply\/data|mv\s+\/opt\/club-apply\/data)/.test(shCode),
    '命中删除类命令');
  ok('命令行里不引用业务数据文件（不碰申请表/账号/附件）',
    !/applications\.json|admins\.json|uploads/.test(shCode));
  ok('延迟秒数可通过环境变量调整', /CLUB_REBOOT_DELAY/.test(shCode));
  ok('脚本支持 selftest 自检模式（跑通链路但不重启）',
    /selftest/.test(shCode) && /不重启/.test(shCode) && /exit 0/.test(shCode));
  ok('自检分支出现在真正重启之前（不会误重启）',
    shCode.indexOf('selftest') < shCode.indexOf('shutdown -r now'), '顺序不对');

  const sudoers = fs.readFileSync(pick('club-reboot.sudoers'), 'utf8');
  const activeLines = sudoers.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
  ok('sudoers 只有一条生效规则', activeLines.length === 1, activeLines);
  ok('sudoers 只放行 club-reboot.sh 一个命令',
    activeLines[0].includes('NOPASSWD: /usr/local/bin/club-reboot.sh') &&
    !/ALL\s*$/.test(activeLines[0]) && !/\*/.test(activeLines[0]), activeLines[0]);
  ok('sudoers 没有 NOPASSWD: ALL（注释里提到不算）', !/NOPASSWD:\s*ALL/.test(activeLines.join('\n')));

  const cron = fs.readFileSync(pick('club-reboot.cron'), 'utf8');
  ok('cron 配置为每日 00:00 触发',
    /^0 0 \* \* \* root \/usr\/local\/bin\/club-reboot\.sh scheduled cron$/m.test(cron));
  ok('cron 里带 SHELL 与 PATH（cron.d 需要）', /SHELL=\/bin\/bash/.test(cron) && /PATH=/.test(cron));
  ok('cron 注释里说明了不会删除业务数据', cron.includes('不会删除'));

  /* deploy/ 里的副本与运维目录里的那份必须一致，避免改了一边漏了另一边 */
  if (fs.existsSync(path.join(OPS, 'club-reboot.sh'))) {
    const same = ['club-reboot.sh', 'club-reboot.sudoers', 'club-reboot.cron']
      .filter(n => fs.readFileSync(path.join(OPS, n), 'utf8') !== fs.readFileSync(path.join(DEPLOY, n), 'utf8'));
    ok('deploy/ 与 _deploy-tools/ 里的重启文件完全一致（无漂移）', same.length === 0, same);
  }

  console.log('\n==================================================');
  console.log(` 通过 ${pass} 项，失败 ${fail} 项`);
  console.log('==================================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('[测试异常] ' + e.stack); process.exit(1); });
