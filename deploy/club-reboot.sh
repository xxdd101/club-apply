#!/usr/bin/env bash
# =============================================================================
# club-reboot.sh —— 示例动漫社入社申请审核系统：重启**操作系统**
#
#   用法:  club-reboot.sh <manual|scheduled|test> [触发者]
#
#   只做三件事：① 写审计日志  ② sync 落盘  ③ 延迟几秒后重启操作系统
#
#   ⚠️ 只重启服务器系统，**不删除、不修改任何业务数据**：
#      data/applications.json（申请表与审核结果）
#      data/admins.json      （管理员账号）
#      data/uploads/ thumbs/ （上传的图片与音频）
#      这些都是磁盘文件，重启后原样还在。
#
#   安全要求（重要，别改坏）：
#     · 本脚本必须由 root 所有、且**不能被应用用户写入**，否则等于把 root 权限给了应用：
#         chown root:root /usr/local/bin/club-reboot.sh && chmod 755 /usr/local/bin/club-reboot.sh
#     · sudo 白名单只放行这一个脚本（/etc/sudoers.d/club-reboot），不要给通配符。
# =============================================================================

set -u

MODE="${1:-manual}"
WHO="${2:-unknown}"
DELAY="${CLUB_REBOOT_DELAY:-8}"          # 延迟秒数：留时间让接口响应、日志落盘
LOG="${CLUB_REBOOT_LOG:-/var/log/club-reboot.log}"
LOCK=/run/club-reboot.lock
STAMP="$(date '+%F %T %z')"
HOST="$(hostname)"
UP="$(uptime -p 2>/dev/null || uptime)"

case "$MODE" in
  manual)    DESC="手动重启（超级管理员在后台点击【重启系统】）" ;;
  scheduled) DESC="每日 00:00（东八区）定时自动重启" ;;
  selftest)  DESC="运维自检（只验证 sudo → 脚本链路，不重启）" ;;
  test)      DESC="重启功能测试" ;;
  *)         DESC="未知来源（$MODE）" ;;
esac

if [ "$(id -u)" != "0" ]; then
  echo "[$STAMP] 错误：需要 root 执行（当前 uid=$(id -u)）" >> "$LOG" 2>&1
  echo "club-reboot.sh: 需要 root 权限执行" >&2
  exit 1
fi

# ---- 自检模式：走完同样的 sudo → 脚本 链路，但**不重启**（运维用来验证白名单是否配好）----
if [ "$MODE" = "selftest" ]; then
  {
    echo "================================================================"
    echo "[$STAMP] 自检：$DESC"
    echo "           触发者 = $WHO   主机 = $HOST"
    echo "           sudo 白名单 → 脚本 → 即将执行 shutdown 的链路正常；本次不重启 ✅"
  } >> "$LOG" 2>&1
  chmod 644 "$LOG" 2>/dev/null || true
  exit 0
fi

# ---- 防止 2 分钟内重复重启（手动与定时任务撞车时的兜底）----
if [ -f "$LOCK" ]; then
  LAST="$(cat "$LOCK" 2>/dev/null || echo 0)"
  case "$LAST" in ''|*[!0-9]*) LAST=0 ;; esac
  if [ "$(( $(date +%s) - LAST ))" -lt 120 ]; then
    echo "[$STAMP] 已有一个重启请求在执行中（$LAST），本次跳过（mode=$MODE by=$WHO）" >> "$LOG" 2>&1
    exit 0
  fi
fi
date +%s > "$LOCK" 2>/dev/null || true

{
  echo "================================================================"
  echo "[$STAMP] 收到重启请求：$DESC"
  echo "           触发者 = $WHO"
  echo "           主机   = $HOST   模式 = $MODE   延迟 = ${DELAY}s"
  echo "           重启前已运行：$UP"
  echo "           业务数据不做任何改动（仅重启操作系统）"
} >> "$LOG" 2>&1
# 让应用用户也能读这份日志（后台【系统设置】页要展示，尤其是定时任务触发的重启）
chmod 644 "$LOG" 2>/dev/null || true

# 业务 JSON 本身是原子写入，这里再 sync 一次确保落盘
sync

sleep "$DELAY"

echo "[$(date '+%F %T %z')] 开始重启操作系统（${DELAY}s 延迟结束）" >> "$LOG" 2>&1

# 重启。优先 shutdown，其次 systemctl，最后 reboot
if [ -x /sbin/shutdown ]; then
  /sbin/shutdown -r now "club-reboot: $DESC"
elif command -v systemctl >/dev/null 2>&1; then
  systemctl reboot
else
  /sbin/reboot
fi
