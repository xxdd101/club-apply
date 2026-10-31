#!/usr/bin/env bash
# =============================================================================
# 示例动漫社 · 入社申请审核系统 —— Ubuntu / Debian 云服务器一键部署
#
# 用法（先上传整个项目文件夹到服务器，然后在项目根目录执行）：
#     cd /root/club-apply
#     sudo bash deploy/install-ubuntu.sh
#
# 可选环境变量：
#     PORT=3000 ADMIN_USER=admin ADMIN_PASS=你的密码 NODE_VER=22.11.0 \
#         sudo -E bash deploy/install-ubuntu.sh
#
# 说明：除 Node.js 本体（≥18）外，还需要安装两个运行依赖（exceljs 导出 Excel、
#       jimp 生成图片缩略图）。本脚本会自动执行 npm install --omit=dev。
#       若服务器无法访问 npm 官方源，可用 NPM_REGISTRY 指定镜像，例如：
#       NPM_REGISTRY=https://registry.npmmirror.com sudo -E bash deploy/install-ubuntu.sh
# =============================================================================
set -euo pipefail

APP_NAME="club-apply"
APP_DIR="/opt/${APP_NAME}"
SERVICE_NAME="${APP_NAME}"
PORT="${PORT:-3000}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-}"
NODE_VER="${NODE_VER:-22.11.0}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

info() { echo -e "\033[32m[+]\033[0m $*"; }
warn() { echo -e "\033[33m[!]\033[0m $*"; }
die()  { echo -e "\033[31m[x]\033[0m $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "需要 root 权限，请执行： sudo bash deploy/install-ubuntu.sh"
[ -f "${SRC_DIR}/server.js" ] || die "未找到 server.js，请在项目根目录执行本脚本"

# ---------------------------------------------------------------- 1. Node.js
NODE_BIN="$(command -v node || true)"
if [ -n "$NODE_BIN" ]; then
  MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$MAJOR" -lt 18 ]; then
    warn "已安装的 Node 版本过低（v${MAJOR}），将安装 v${NODE_VER}"
    NODE_BIN=""
  else
    info "检测到已安装 Node：$("$NODE_BIN" -v)（跳过安装）"
  fi
fi

if [ -z "$NODE_BIN" ]; then
  info "开始安装 Node.js v${NODE_VER} ..."
  command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq curl ca-certificates; }
  PKG="node-v${NODE_VER}-linux-x64"
  TMP="$(mktemp -d)"
  OK=""
  # 国内服务器优先走 npmmirror，失败再回退官方源
  for BASE in "https://npmmirror.com/mirrors/node" "https://nodejs.org/dist"; do
    URL="${BASE}/v${NODE_VER}/${PKG}.tar.gz"
    info "下载 ${URL}"
    if curl -fsSL --connect-timeout 15 --max-time 300 "$URL" -o "${TMP}/node.tar.gz"; then OK="1"; break; fi
    warn "该源不可用，尝试下一个..."
  done
  [ -n "$OK" ] || die "Node.js 下载失败，请检查服务器网络，或手动安装 Node ≥18 后重跑本脚本"
  tar -xzf "${TMP}/node.tar.gz" -C "$TMP"
  install -m 0755 "${TMP}/${PKG}/bin/node" /usr/local/bin/node
  if [ -d "${TMP}/${PKG}/lib/node_modules/npm" ]; then
    cp -a "${TMP}/${PKG}/lib/node_modules" /usr/local/lib/ 2>/dev/null || true
    ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm 2>/dev/null || true
    ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx 2>/dev/null || true
  fi
  rm -rf "$TMP"
  NODE_BIN="/usr/local/bin/node"
  [ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"
  info "Node.js 安装完成：$("$NODE_BIN" -v)  ($NODE_BIN)"
fi

# ------------------------------------------------------- 2. 运行用户 & 代码
id -u "$APP_NAME" >/dev/null 2>&1 || {
  useradd -r -s /sbin/nologin -d "$APP_DIR" "$APP_NAME"
  info "已创建运行用户：${APP_NAME}"
}

mkdir -p "$APP_DIR"
if [ "$SRC_DIR" = "$APP_DIR" ]; then
  warn "脚本就在 ${APP_DIR} 内运行，跳过复制（原地重启）"
else
  info "复制程序到 ${APP_DIR}（保留已有 data/ 申请数据）"
  tar -C "$SRC_DIR" --exclude=./data --exclude=./node_modules -cf - . | tar -C "$APP_DIR" -xf -
fi
mkdir -p "${APP_DIR}/data/uploads"

# ------------------------------------------------- 2.5 安装运行依赖（npm）
NPM_BIN="$(command -v npm || true)"
if [ -z "$NPM_BIN" ] && [ -x /usr/local/bin/npm ]; then NPM_BIN=/usr/local/bin/npm; fi
[ -n "$NPM_BIN" ] || die "未找到 npm，请确认 Node.js（含 npm）安装完整后重跑本脚本"

NPM_REGISTRY="${NPM_REGISTRY:-}"
info "安装运行依赖 exceljs / jimp（在 ${APP_DIR} 执行 npm install --omit=dev）..."
cd "$APP_DIR"
set +e
if [ -n "$NPM_REGISTRY" ]; then
  "$NPM_BIN" install --omit=dev --no-audit --no-fund --registry="$NPM_REGISTRY" >/tmp/club-npm.log 2>&1
else
  "$NPM_BIN" install --omit=dev --no-audit --no-fund >/tmp/club-npm.log 2>&1
fi
NPM_RC=$?
if [ $NPM_RC -ne 0 ] && [ -z "$NPM_REGISTRY" ]; then
  warn "npm 官方源安装失败，改用国内镜像重试（registry.npmmirror.com）"
  "$NPM_BIN" install --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com >/tmp/club-npm.log 2>&1
  NPM_RC=$?
fi
set -e
if [ $NPM_RC -ne 0 ]; then
  warn "依赖安装失败，日志尾部如下："
  tail -n 20 /tmp/club-npm.log || true
  die "请检查服务器网络后重试；也可手动执行： cd ${APP_DIR} && npm install --omit=dev"
fi
info "依赖安装完成（$(ls -1 "${APP_DIR}/node_modules" 2>/dev/null | wc -l) 个包）"

# ------------------------------------------------------ 3. 管理员密码
GEN_PASS=""
if [ -z "$ADMIN_PASS" ]; then
  ADMIN_PASS="$(head -c 9 /dev/urandom | base64 | tr -d '/+=' | cut -c1-10)"
  GEN_PASS="1"
  warn "未指定 ADMIN_PASS，已随机生成管理员密码"
fi
# 去掉换行，避免破坏环境文件格式
ADMIN_PASS="$(printf '%s' "$ADMIN_PASS" | tr -d '\r\n')"

# 凭据写入独立环境文件：密码含空格/引号/# 也不会被 systemd 解析坏
info "写入管理员凭据：${APP_DIR}/data/env"
cat > "${APP_DIR}/data/env" <<EOF
PORT=${PORT}
ADMIN_USER=${ADMIN_USER}
ADMIN_PASS=${ADMIN_PASS}
EOF

chown -R "${APP_NAME}:${APP_NAME}" "$APP_DIR"
chmod 750 "$APP_DIR"
chmod 600 "${APP_DIR}/data/env"

# ------------------------------------------------------------ 4. systemd
info "写入 systemd 服务：/etc/systemd/system/${SERVICE_NAME}.service"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Club Application Review System
After=network.target

[Service]
Type=simple
User=${APP_NAME}
WorkingDirectory=${APP_DIR}
EnvironmentFile=-${APP_DIR}/data/env
ExecStart=${NODE_BIN} ${APP_DIR}/server.js
Restart=always
RestartSec=3
EOF

# StandardOutput=append: 需要 systemd ≥ 240；老系统（如 CentOS 7）走 journald
# 用 awk 单条完成，避免 head 提前退出触发 SIGPIPE 被 pipefail 判为失败
SYSTEMD_VER="$(systemctl --version 2>/dev/null | awk 'NR==1{print $2}' || echo 0)"
if [ "${SYSTEMD_VER:-0}" -ge 240 ] 2>/dev/null; then
  cat >> "$UNIT_FILE" <<EOF
StandardOutput=append:${APP_DIR}/data/server.log
StandardError=append:${APP_DIR}/data/server.log
EOF
else
  warn "当前 systemd 版本较低（${SYSTEMD_VER:-未知}），日志将只写入 journald"
fi

# 若使用 80 等特权端口（<1024），授予绑定低位端口的能力
if [ "${PORT}" -lt 1024 ] 2>/dev/null; then
  info "端口 ${PORT} 属于特权端口，已为服务授予 CAP_NET_BIND_SERVICE 能力"
  cat >> "$UNIT_FILE" <<EOF
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
EOF
fi

cat >> "$UNIT_FILE" <<EOF

[Install]
WantedBy=multi-user.target
EOF
chmod 600 "$UNIT_FILE"

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1
systemctl restart "${SERVICE_NAME}"

# ------------------------------------------------------------ 5. 系统防火墙
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "${PORT}/tcp" >/dev/null 2>&1 && info "已放行 ufw 端口 ${PORT}/tcp"
fi
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null 2>&1 && firewall-cmd --reload >/dev/null 2>&1 && info "已放行 firewalld 端口 ${PORT}/tcp"
fi

# ------------------------------------------------------------ 6. 结果
sleep 2
PUBLIC_IP="$(curl -fsS --max-time 5 https://ipinfo.io/ip 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"

echo
echo "============================================================"
if systemctl is-active --quiet "${SERVICE_NAME}"; then
  echo -e "  \033[32m部署成功，服务已启动并设置为开机自启\033[0m"
else
  echo -e "  \033[31m服务启动失败，请查看日志： tail -n 50 ${APP_DIR}/data/server.log\033[0m"
fi
echo "============================================================"
echo "  用户填写端 : http://${PUBLIC_IP}:${PORT}/"
echo "  审核状态查询: http://${PUBLIC_IP}:${PORT}/status"
echo "  审核管理后台: http://${PUBLIC_IP}:${PORT}/admin"
echo "  管理员账号 : ${ADMIN_USER}"
echo "  管理员密码 : ${ADMIN_PASS}${GEN_PASS:+   （系统随机生成，请立即记下）}"
echo "------------------------------------------------------------"
echo "  常用命令："
echo "    查看状态  systemctl status ${SERVICE_NAME}"
echo "    查看日志  tail -f ${APP_DIR}/data/server.log"
echo "    查看日志  journalctl -u ${SERVICE_NAME} -f   （老系统用这个）"
echo "    重启服务  systemctl restart ${SERVICE_NAME}"
echo "    停止服务  systemctl stop ${SERVICE_NAME}"
echo "    更新版本  重新上传代码后重跑本脚本即可（data/ 不会被覆盖）"
echo "  数据目录：${APP_DIR}/data  （申请记录 + 上传附件，务必备份）"
echo "------------------------------------------------------------"
echo -e "  \033[33m重要：请到云控制台「安全组 / 防火墙」放行 TCP ${PORT} 端口，\033[0m"
echo -e "  \033[33m否则手机和外部网络仍无法访问！\033[0m"
echo "  绑定域名 + HTTPS 请参考 deploy/nginx-club.conf 与 README 第七章"
echo "============================================================"
