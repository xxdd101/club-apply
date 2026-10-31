'use strict';

/* =========================================================================
 * 业务常量与配置
 * ========================================================================= */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
const APP_DB_FILE = path.join(DATA_DIR, 'applications.json');
const ADMIN_DB_FILE = path.join(DATA_DIR, 'admins.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

/** 默认最高权限管理员（仅首次初始化时使用，可用环境变量覆盖） */
const DEFAULT_SUPER_USER = process.env.ADMIN_USER || 'admin';
const DEFAULT_SUPER_PASS = process.env.ADMIN_PASS || 'change-this-password';

const TOKEN_TTL_MS = Number(process.env.TOKEN_TTL_HOURS || 12) * 60 * 60 * 1000;

const MAX_IMAGE_SIZE = 10 * 1024 * 1024;  // 单张图片 10MB
const MAX_AUDIO_SIZE = 30 * 1024 * 1024;  // 单个音频 30MB
const MAX_JSON_SIZE = 2 * 1024 * 1024;    // JSON 请求体 2MB
const MAX_IMAGES_PER_QUESTION = 6;
const MIN_AUDIO_SECONDS = 15;             // CV 部录音最短时长

/* ---------------- 上传滥用防护 ---------------- */
/** 上传目录总量上限（超过则拒绝新上传，防止刷满磁盘导致服务崩溃） */
const MAX_UPLOAD_TOTAL_BYTES = Number(process.env.MAX_UPLOAD_TOTAL_MB || 5120) * 1024 * 1024; // 5GB
/** 磁盘剩余空间下限（低于则拒绝新上传） */
const MIN_FREE_DISK_BYTES = Number(process.env.MIN_FREE_DISK_MB || 1024) * 1024 * 1024;       // 1GB
/** 单张图片最大像素数（防止"解压炸弹"图片在生成缩略图时撑爆内存） */
const MAX_IMAGE_PIXELS = 40 * 1000 * 1000;   // 4000 万像素
const MAX_IMAGE_EDGE = 12000;
/** 上传频率限制：每分钟每 IP 次数 */
const UPLOAD_RATE_PER_MIN = 30;

/* ---------------- 附件访问签名 ---------------- */
/** 上传成功后回给前端的预览链接有效期（够填完表格即可） */
const UPLOAD_URL_TTL_MS = Number(process.env.UPLOAD_URL_TTL_HOURS || 24) * 60 * 60 * 1000;
/** 管理端查看附件时签发的链接有效期（很短，防止链接外泄后被长期利用） */
const ADMIN_ASSET_TTL_MS = Number(process.env.ADMIN_ASSET_TTL_HOURS || 3) * 60 * 60 * 1000;

/**
 * 第13题：14 个部门（顺序与需求一致）
 * 最后一个「宣传部」为新增部门：申请阶段不需要提交任何作品资料
 * （不在 WORK_RULES 里 = 不显示第14~21题，前后端都不要求附件）
 */
const DEPARTMENTS = [
  'COS部', '唱见部', '舞见部', 'CV部', '三坑部', '后勤部', '妆娘部',
  '绘画部', '后期部', '摄影部', '特摄部', 'FURRY（福瑞）部', 'Kigurumi(人偶扮演)部',
  '宣传部'
];

/** 部门 → 作品提交要求（第14~21题联动）。无作品要求的部门不在此表中 */
const WORK_RULES = {
  'COS部': { q: 14, kind: 'image', max: MAX_IMAGES_PER_QUESTION },
  '三坑部': { q: 15, kind: 'image', max: MAX_IMAGES_PER_QUESTION },
  '摄影部': { q: 16, kind: 'image', max: MAX_IMAGES_PER_QUESTION },
  '后期部': { q: 16, kind: 'image', max: MAX_IMAGES_PER_QUESTION },
  '绘画部': { q: 17, kind: 'image', max: MAX_IMAGES_PER_QUESTION },
  'CV部': { q: 18, kind: 'audio', max: 1, minDuration: MIN_AUDIO_SECONDS },
  '特摄部': { q: 19, kind: 'image', max: MAX_IMAGES_PER_QUESTION },
  'FURRY（福瑞）部': { q: 20, kind: 'image', max: MAX_IMAGES_PER_QUESTION },
  'Kigurumi(人偶扮演)部': { q: 21, kind: 'image', max: MAX_IMAGES_PER_QUESTION }
};

const GENDERS = ['男', '女', '两性人', '生理男认知女', '生理女认知男', '其他认知性别'];

/** 审核状态：内部码 */
const STATUS = {
  SUBMITTED: 'submitted',      // 已提交申请（审核员还未查看）
  VIEWING: 'viewing',          // 审核员查看中
  APPROVED: 'approved',        // 审核通过
  REJECTED: 'rejected',        // 审核拒绝
  RETURNED: 'returned',        // 审核员退回（申请人可修改后提交复审）
  RESUBMITTED: 'resubmitted',  // 已提交复审申请（等待重新审核）
  ESCALATED: 'escalated',      // 已移交主审核官（仅超管可见 / 可审核）
  INTERVENED: 'intervened'     // 主审核官介入中（锁定：仅具【介入权限】的账号可审核）
};

/** 允许审核员操作的「待处理」状态 */
const REVIEWABLE = [STATUS.SUBMITTED, STATUS.VIEWING, STATUS.RESUBMITTED];

/**
 * 复审机会规则（2026-10-01 修改版）
 *   · 初审【审核拒绝】     → 1 次机会（第 1 次）
 *   · 初审【退回】         → 1 次机会（第 1 次）
 *   · 复审后【被退回】     → 额外再 1 次机会（第 2 次）
 *   · 复审后【被拒绝】     → 直接结束，不再提供机会
 *   · 上限 2 次，用尽后按钮永久隐藏
 * 具体判定见 store.resubmitState()
 */
const MAX_RESUBMITS = Number(process.env.MAX_RESUBMITS || 2);

/** 申请人可以点「前往修改-提交复审」的状态（还要通过次数规则，见 store.resubmitState） */
const RESUBMIT_ALLOWED = [STATUS.RETURNED, STATUS.REJECTED];

/** 后台列表用状态文案 */
const STATUS_LABEL_ADMIN = {
  [STATUS.SUBMITTED]: '待审核',
  [STATUS.VIEWING]: '审核员查看中',
  [STATUS.APPROVED]: '审核通过',
  [STATUS.REJECTED]: '审核不通过',
  [STATUS.RETURNED]: '审核员退回',
  [STATUS.RESUBMITTED]: '复审待审核',
  [STATUS.ESCALATED]: '已移交主审核官',
  [STATUS.INTERVENED]: '主审核官介入中'
};

/** 用户查询页用状态文案（需求指定了退回与复审两种情况的具体文字） */
const STATUS_LABEL_PUBLIC = {
  [STATUS.SUBMITTED]: '已提交申请',
  [STATUS.VIEWING]: '审核员查看中',
  [STATUS.APPROVED]: '审核通过',
  [STATUS.REJECTED]: '审核拒绝',
  [STATUS.RETURNED]: '该申请表被退回',
  [STATUS.RESUBMITTED]: '已提交复审申请',
  [STATUS.ESCALATED]: '等待审核结果',
  [STATUS.INTERVENED]: '该申请表已由主审核官介入'
};

/**
 * 催促审核
 *   · 只有「等待审核」的申请可以催促：已提交申请（submitted）、已提交复审申请（resubmitted）
 *   · 同一申请 1 小时内最多成功催促 1 次（冷却），防止重复骚扰管理员
 *   · 一旦出了终审结果（通过/不通过）就不再接收催促
 */
const URGE_COOLDOWN_MS = Number(process.env.URGE_COOLDOWN_MINUTES || 60) * 60 * 1000;
const URGE_RATE_PER_MIN = Number(process.env.URGE_RATE_PER_MIN || 10);   // 每 IP 每分钟
const URGE_ALLOWED_STATUS = [STATUS.SUBMITTED, STATUS.RESUBMITTED];
/** 单条申请最多保留多少条催促日志 */
const URGE_LOG_MAX = 20;
/** 催促成功的提示文案（需求指定） */
const URGE_OK_MESSAGE = '已提交催促提醒，审核人员将尽快查看，请耐心等待。';

/**
 * 子管理员权限开关（超管恒定拥有全部权限，不受此处影响）
 *   review    审核权限        —— 默认开启（新建子账号自动勾选）
 *   system    系统设置权限    —— 手动勾选
 *   ban       封禁账号权限    —— 手动勾选
 *   intervene 主审核官介入权限 —— 手动勾选（勾选后才能看到/点击【审核介入】）
 */
const PERMS = {
  REVIEW: 'review',
  SYSTEM: 'system',
  BAN: 'ban',
  INTERVENE: 'intervene',
  OPEN_SYSTEM: 'openSystem'
};

const PERM_LIST = [
  { key: PERMS.REVIEW, label: '审核权限', def: true, desc: '可查看申请表并执行 审核通过 / 审核不通过 / 退回 / 移交主审核官' },
  { key: PERMS.SYSTEM, label: '系统设置权限', def: false, desc: '可进入【系统设置】页（查看服务器状态、重启服务器）' },
  { key: PERMS.BAN, label: '封禁账号权限', def: false, desc: '可在账号管理页停用 / 解封其他管理员账号' },
  { key: PERMS.INTERVENE, label: '主审核官介入权限', def: false, desc: '可执行【审核介入】并审核被介入锁定的申请表' },
  { key: PERMS.OPEN_SYSTEM, label: '系统开启权限', def: false, desc: '可进入【审核设置】页，启动 / 暂停 / 终止整个审核系统' }
];

function defaultPerms() {
  const d = {};
  for (const p of PERM_LIST) d[p.key] = p.def;
  return d;
}

/** 拒绝理由选项 */
const REJECT_REASONS = ['拥有其他社会性质社团', '不符合入社部门要求', '其他'];
const REJECT_REASON_OTHER = '其他';

const ROLES = { SUPER: 'super', SUB: 'sub' };
const ROLE_LABEL = { super: '最高权限管理员', sub: '分管理员（审核员）' };

/* ---------------- 系统设置 / 重启服务器 ----------------
 * 重启只做一件事：重启操作系统。不删除、不修改任何业务数据
 * （申请表 applications.json、账号 admins.json、附件 uploads/ 全部在磁盘上，重启后原样还在）。 */
/** root 只读脚本：唯一被 sudo 白名单放行的命令 */
const REBOOT_CMD = process.env.REBOOT_CMD || '/usr/local/bin/club-reboot.sh';
/** 脚本收到指令后延迟多少秒才真正重启（留时间把接口响应、审计日志落盘） */
const REBOOT_DELAY_SECONDS = Number(process.env.REBOOT_DELAY_SECONDS || 8);
/** 两次**手动**重启之间的最小间隔（防误点、防被刷成重启循环） */
const REBOOT_COOLDOWN_MS = Number(process.env.REBOOT_COOLDOWN_MINUTES || 5) * 60 * 1000;
/** 每日定时重启（cron 表达式 + 展示用说明），真正的定时任务在 /etc/cron.d/club-reboot */
const REBOOT_CRON = process.env.REBOOT_CRON || '0 0 * * *';
const REBOOT_CRON_DESC = '每日 00:00（东八区）自动重启';
const REBOOT_SCHEDULE_FILE = process.env.REBOOT_SCHEDULE_FILE || '/etc/cron.d/club-reboot';
/** 服务器日志里的重启记录（运维查证用） */
const REBOOT_SYSTEM_LOG = process.env.REBOOT_SYSTEM_LOG || '/var/log/club-reboot.log';
/** 传给重启脚本的模式：manual=手动；selftest=只跑通 sudo→脚本 链路、不真重启（运维自检用） */
const REBOOT_MODE = process.env.REBOOT_MODE || 'manual';
/** 演练模式（测试用）：只记录请求、不真正重启，避免测试把机器重启掉 */
const REBOOT_DRY_RUN = process.env.REBOOT_DRY_RUN === '1';

/* ---------------- 审核系统开关（启动 / 暂停 / 终止） ----------------
 *   running 启动审核系统（默认）：申请表正常填写提交
 *   paused  暂停审核系统：可继续提交申请表，但会明确提示审核已暂停（原因 + 预计恢复时间）
 *   stopped 终止审核系统：停止新人入社申请（申请表不再接收提交）
 * 状态与操作记录单独存在 data/review-state.json，不动任何业务数据。 */
const REVIEW_STATUS = {
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPED: 'stopped'
};
const REVIEW_STATUS_LABEL = {
  running: '审核系统运行中',
  paused: '审核系统已暂停',
  stopped: '审核系统已终止（停止新人入社申请）'
};
const REVIEW_ACTIONS = {
  START: 'start',
  PAUSE: 'pause',
  STOP: 'stop'
};
/** 终止状态下的公告标题（需求指定） */
const REVIEW_STOP_TITLE = '示例动漫社团暂时停止新人入社申请';
const REVIEW_STATE_FILE = path.join(DATA_DIR, 'review-state.json');
/** 状态变更记录最多保留多少条 */
const REVIEW_HISTORY_MAX = Number(process.env.REVIEW_HISTORY_MAX || 50);

module.exports = {
  ROOT, PUBLIC_DIR, DATA_DIR, UPLOAD_DIR, THUMB_DIR,
  APP_DB_FILE, ADMIN_DB_FILE, SECRET_FILE,
  PORT, HOST, TOKEN_TTL_MS,
  DEFAULT_SUPER_USER, DEFAULT_SUPER_PASS,
  MAX_IMAGE_SIZE, MAX_AUDIO_SIZE, MAX_JSON_SIZE,
  MAX_IMAGES_PER_QUESTION, MIN_AUDIO_SECONDS,
  MAX_UPLOAD_TOTAL_BYTES, MIN_FREE_DISK_BYTES, MAX_IMAGE_PIXELS, MAX_IMAGE_EDGE,
  UPLOAD_RATE_PER_MIN, UPLOAD_URL_TTL_MS, ADMIN_ASSET_TTL_MS,
  DEPARTMENTS, WORK_RULES, GENDERS,
  STATUS, STATUS_LABEL_ADMIN, STATUS_LABEL_PUBLIC, REVIEWABLE, RESUBMIT_ALLOWED, MAX_RESUBMITS,
  PERMS, PERM_LIST, defaultPerms,
  URGE_COOLDOWN_MS, URGE_RATE_PER_MIN, URGE_ALLOWED_STATUS, URGE_LOG_MAX, URGE_OK_MESSAGE,
  REJECT_REASONS, REJECT_REASON_OTHER,
  ROLES, ROLE_LABEL,
  REBOOT_CMD, REBOOT_DELAY_SECONDS, REBOOT_COOLDOWN_MS,
  REBOOT_CRON, REBOOT_CRON_DESC, REBOOT_SCHEDULE_FILE, REBOOT_SYSTEM_LOG, REBOOT_DRY_RUN,
  REBOOT_MODE,
  REVIEW_STATUS, REVIEW_STATUS_LABEL, REVIEW_ACTIONS, REVIEW_STOP_TITLE,
  REVIEW_STATE_FILE, REVIEW_HISTORY_MAX
};
