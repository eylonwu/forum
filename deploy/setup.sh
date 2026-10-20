#!/usr/bin/env bash
# ============================================================
# 拾光集论坛 · 一键上云脚本（Ubuntu 22.04+ / Debian 12）
#
# 用法：
#   1. 先在 DNS 服务商把域名 A 记录指向本服务器公网 IP（TTL 短一点，方便生效）
#   2. 把整个 forum/ 目录上传到服务器（scp/rsync/git 均可）
#   3. 在 forum 目录内执行：
#        sudo bash deploy/setup.sh 你的域名.com 你的邮箱@example.com
#
# 脚本会自动完成：系统更新 → 安装 Node24/nginx/certbot → 部署应用
#   → 创建 systemd 服务 → 防火墙 → nginx 反代 → 自动申请 HTTPS 证书
#   → 配置每日数据库备份。
# ============================================================
set -euo pipefail

DOMAIN="${1:?用法: sudo bash deploy/setup.sh <域名> <邮箱>}"
EMAIL="${2:?用法: sudo bash deploy/setup.sh <域名> <邮箱>}"
APP_DIR="/srv/forum"
# 脚本位于 forum/deploy/setup.sh，项目根目录为其上一级
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "错误：请用 sudo 运行" >&2; exit 1
fi
if ! command -v rsync >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y rsync
fi

echo "==> [1/7] 安装 Node 24 + nginx + certbot（系统更新可能需要几分钟）"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y curl nginx ufw ca-certificates
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs certbot python3-certbot-nginx
node -v && nginx -v

echo "==> [2/7] 创建应用账号与目录，同步代码"
id -u forum >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -m forum
mkdir -p "$APP_DIR" /var/backups/forum
# 同步代码：保留线上 forum.db 与 .env（含密钥），首次部署时自动生成
rsync -a --delete \
  --exclude 'forum.db*' --exclude '.env' --exclude 'node_modules' --exclude 'deploy' \
  "$SRC_DIR/" "$APP_DIR/"
if [[ ! -f "$APP_DIR/.env" ]]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo "  首次部署：已从 .env.example 生成 $APP_DIR/.env（请稍后填入支付密钥）"
fi
# 默认沙箱模式，避免未配置凭据时线上误扣款
if ! grep -q '^PAY_MODE=' "$APP_DIR/.env"; then
  echo 'PAY_MODE=sandbox' >> "$APP_DIR/.env"
fi
chown -R forum:forum "$APP_DIR"

echo "==> [3/7] 安装 systemd 服务并启动"
install -m 0644 "$SRC_DIR/deploy/forum.service" /etc/systemd/system/forum.service
systemctl daemon-reload
systemctl enable --now forum
systemctl is-active forum

echo "==> [4/7] 配置防火墙（仅放行 SSH/HTTP/HTTPS）"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
ufw status | head -12

echo "==> [5/7] 配置 nginx 反向代理（端口 80 占位，证书签发后自动加 443 与跳转）"
sed "s/__DOMAIN__/$DOMAIN/g" "$SRC_DIR/deploy/nginx.conf" \
  > /etc/nginx/sites-available/forum
ln -sf /etc/nginx/sites-available/forum /etc/nginx/sites-enabled/forum
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> [6/7] 申请并自动续期 HTTPS 证书（Let's Encrypt）"
certbot --nginx -d "$DOMAIN" --email "$EMAIL" --agree-tos --non-interactive --redirect

echo "==> [7/7] 配置每日数据库备份（凌晨 3 点）"
cat > /etc/cron.d/forum-backup <<EOF
0 3 * * * root test -d /var/backups/forum && /usr/bin/cp "$APP_DIR/forum.db" "/var/backups/forum/forum-\$(date +%F).db"
EOF

echo
echo "================================================================"
echo "✔ 部署完成：https://$DOMAIN"
echo "✔ systemd 服务：systemctl status/restart forum"
echo "✔ 数据库备份：/var/backups/forum/"
echo "下一步："
echo "  1) vi $APP_DIR/.env  填写 Stripe/支付宝/微信密钥，PAY_MODE=live"
echo "  2) systemctl restart forum"
echo "  3) 在网站页脚填写备案号（见 deploy.md 第 7 节）"
echo "  4) 上线前清空演示数据或修改演示账号密码"
echo "================================================================"