# 拾光集论坛 · 上线部署说明

本论坛是**零依赖全栈**（Node 内置 `node:http` + `node:sqlite`，无需任何 npm 依赖）。包含：
公开注册登录、友好讨论（发帖/评论/点赞）、付费帖、会员、**广告位出售**、广告主投放、
**站长中心**（用户日活 DAU、收入图表、广告审核、广告位库存管理），以及**双通道真实收款**
（Stripe 美元 + 支付宝/微信人民币）。

---

## 0. 快速上线（免费二级域名：GitHub + Render）

不买服务器、不备案，几分钟即可获得 `https://<服务名>.onrender.com` **免费二级域名**并公网访问（全站 HTTPS）。
仓库内 `render.yaml` 蓝图已就绪：GitHub 推代码后 Render 自动部署，`BASE_URL` 配置好后
`robots.txt` / `sitemap.xml` / canonical / 结构化数据全部自动生成，便于 SEO。

### 0.1 推送代码到 GitHub

```bash
# 1) 安装 git（Windows）后重开终端
winget install --id Git.Git -e --source winget

# 2) 在 github.com 新建空仓库（如 forum，不要勾选 README）
cd forum
git init
git add .
git commit -m "feat: 拾光集论坛首发（注册/讨论/付费/广告/SEO）"
git branch -M main
git remote add origin https://github.com/<你的用户名>/forum.git
git push -u origin main
```

> 已配置 `.gitignore`：`forum.db`、`.env` 等运行时/敏感文件不会入库。

### 0.2 在 Render 一键部署（免费）

1. 注册 [Render](https://dashboard.render.com)（直接用 GitHub 账号登录，即"接入 GitHub"）；
2. Dashboard → **New → Web Service** → 连接 GitHub → 选中 `forum` 仓库；
3. Render 自动读取 `render.yaml`（Web 服务 + 环境变量）→ **Create Web Service**；
4. 部署完成后打开 `https://<服务名>.onrender.com` 即网站上线；
5. **改 BASE_URL（必做，否则 SEO/支付会指向 localhost）**：Service → Environment，
   把 `BASE_URL` 改成你的真实二级域名（如 `https://forum.onrender.com`），保存后自动重新部署。
   ⚠️ 校验方法：部署后打开 `https://你的域名/robots.txt`，若 Sitemap 行不是你的域名则说明未生效。

### 0.3 免费层须知（重要）

- 免费实例 **15 分钟无访问会休眠**，下次访问首次加载稍慢（自动唤醒）；
- 免费实例磁盘**不持久**：重新部署/实例回收可能重置数据（论坛回到种子数据）。
  正式运营请定期在后台备份/导出 `forum.db`，或升级付费实例/改走第 4 节服务器方案；
- SEO 的 `sitemap.xml`、`robots.txt`、canonical 随 `BASE_URL` 自动生成，无需手动维护。

**内置稳定性措施**（无需额外配置）：全局异常兜底（`uncaughtException`/`unhandledRejection` 不中断服务）、
SIGTERM/SIGINT 优雅关闭（先关服务再关库）、注册/登录 IP 限流（防暴力破解）、每 6 小时自动清理过期会话、
请求体超限返回 413、坏 JSON 返回 400、隐藏帖子等管理操作已加管理员鉴权、全站 UTF-8 输出防乱码。

### 0.4 真实收款与备案

公网可访问后按第 2、3 节配置 Stripe/支付宝/微信凭据。Render 为海外节点不强制备案，
但大陆支付宝/微信商户审核仍要求已备案域名，合规细节见第 5 节。

---

## 1. 本地运行（演示）

要求：Node ≥ 22（本项目用 node:sqlite，实测 v24 正常）。

```bash
cd forum
node server.js
```

打开 http://localhost:3000

- 默认以 **沙箱模式** 运行：收银台选「沙箱（演示）」即点即到账，方便完整体验下单→到账→权益生效。
- 演示账号：管理员 `admin / admin123`（右侧导航出现「管理后台」）；普通用户 `墨语 / 123456`。

### 目录结构

```
forum/
├── server.js          # HTTP 服务 + 全部 API
├── config.js          # 读取 .env 配置（支付模式/通道/汇率）
├── db.js              # SQLite 建表 + 种子数据 + 广告位库存
├── forum.db           # 数据库（自动生成，WAL 模式）
├── .env.example       # 支付配置模板（复制为 .env）
└── public/            # 前端（index.html / app.js / style.css）
```

---

## 2. 配置真实收款（.env）

复制 `.env.example` 为 `.env`，填写你的真实凭据：

```bash
# 切到真实收款
PAY_MODE=live
USD_CNY_RATE=7.1

# —— Stripe（美元账户）——
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# —— 支付宝（大陆银行卡/花呗）——
ALIPAY_APPID=...
ALIPAY_PRIVATE_KEY=...
ALIPAY_PUBLIC_KEY=...
ALIPAY_GATEWAY=https://openapi.alipay.com/gateway.do

# —— 微信支付（大陆银行卡/零钱/店员收款）——
WECHAT_MCHID=...
WECHAT_APPID=...
WECHAT_APIV3_KEY=...
WECHAT_SERIAL_NO=...
WECHAT_PRIVATE_KEY_PATH=...
WECHAT_NOTIFY_URL=https://你的域名/api/pay/webhook/wechat
```

各通道如未配置凭据，则收银台不会出现该通道（自动隐藏）。`PAY_MODE=live` 且通道未配置时，
收银台会退回沙箱，避免线上误扣。

### 开通与提现（站长收款账户）

- **美元**：注册 [Stripe](https://dashboard.stripe.com) → 关联你的海外/美元银行账户 → 收款后按周期结算到该账户。
- **人民币（大陆银行卡）**：企业主体开通支付宝/微信「即时到账」商户，收款结算到对公/对私大陆银行卡。
  - 支付宝需注册**企业支付宝**并完成商家认证、签约「computer 支付」。
  - 微信支付需微信商户平台（`pay.weixin.qq.com`），用**个体工商户/企业**入驻，绑定结算银行卡。
  - 国内商户上线要求：**已备案域名 + HTTPS**，支付宝/微信仍可能要求网站通过内容审核。

> 个人站长收款建议：早期先用 Stripe（支持个人账户/非营利）收美元；人民币端若暂时无法申请企业商户，
> 可先用支付宝「当面付/个人码」过渡，或保留沙箱引导联系站长线下付款。

---

## 3. 真实支付接入点说明

`server.js` 已实现**完整的订单与到账逻辑**（`/api/pay/create` 建单、`settleOrder` 结算权益，
订单进入 `pay_orders` 与 `orders` 表，站长后台据此统计收入），真实通道的接入方式：

```
pay/create ──live──▶ 调 Stripe/支付宝/微信生成支付单 ──▶ 返回支付地址
浏览器付款 ────────▶ 支付平台异步回调 ──▶ /api/pay/webhook/:channel ──▶ settleOrder(order)
前端跳回 #/pay-result 轮询 /api/pay/my 看到 status=paid ──▶ 刷新权益
```

### 3.1 Stripe（美元，已实现）

`stripe.js` 为纯 Node 内置实现的 Stripe 客户端（无需 npm 依赖）：

- **下单**：`/api/pay/create` 收到 `channel=stripe` 时调用 Stripe Checkout 创建托管收银台，
  返回 `provider.url`，前端直接跳转（见 `public/app.js` 的 `showPayModal`）。
- **回调**：`POST /api/pay/webhook/stripe` 使用 `STRIPE_WEBHOOK_SECRET` 做
  **HMAC-SHA256 签名校验** + 时间戳防重放（±5 分钟），处理 `checkout.session.completed`
  后调用 `settleOrder` 结算（幂等：重复回调不会重复记账）。

**开通步骤（需美元银行账户）**：

1. 注册 [Stripe](https://dashboard.stripe.com) → 完成账户激活，关联美元收款银行账户
   （Stripe 按周期自动结算到该账户）；
2. Dashboard → Developers → API keys：复制 `sk_test_...`/`pk_test_...` 到 `.env` 先联调；
3. Dashboard → Developers → Webhooks → **Add endpoint**：
   - URL：`https://你的域名/api/pay/webhook/stripe`
   - 事件：勾选 `checkout.session.completed`
   - 复制签名密钥 `whsec_...` 到 `.env` 的 `STRIPE_WEBHOOK_SECRET`；
4. `.env` 设 `PAY_MODE=live`、`BASE_URL=https://你的域名`，重启即可收款。

**本地联调（无服务器也能验签）**：用 [Stripe CLI](https://stripe.com/docs/stripe-cli) 把线上 webhook 转发到本机：
```bash
stripe login
stripe listen --forward-to http://localhost:3000/api/pay/webhook/stripe
# 终端会打印 whsec_...，填入 .env 后重启；在浏览器走一遍 Stripe 收银台即可端到端验证
```

### 3.2 支付宝/微信（人民币，代码已预留）

`/api/pay/create` 的 `alipay`/`wechat` 分支已建单，但**商户凭据需你本人注册**（无法纯代码代办）：

- 支付宝：注册企业支付宝 → 商家认证 → 签约「电脑网站支付」→ 配置 `ALIPAY_APPID`、
  RSA2 私钥/公钥到 `.env`；
- 微信：微信商户平台（pay.weixin.qq.com）用个体户/企业入驻 → 绑定结算大陆银行卡 →
  配置 `WECHAT_MCHID / WECHAT_APPID / WECHAT_APIV3_KEY / WECHAT_SERIAL_NO /
  WECHAT_PRIVATE_KEY_PATH / WECHAT_NOTIFY_URL`。

> 未配置凭据时收银台自动隐藏该通道；`PAY_MODE=live` 且通道未配置时退回沙箱，避免线上误扣。

---

## 4. 部署到云服务器

本项目无第三方依赖，部署最简单方式：**把整个 `forum` 目录复制到服务器**。

### 4.1 用 Node 直接跑（低配可用）

```bash
# 假设用 pm2 守护
npm i -g pm2
cd /srv/forum
pm2 start server.js --name forum
pm2 save && pm2 startup
```

### 4.2 用 nginx 反代 + HTTPS（推荐，真实收款必须）

```nginx
server {
  listen 80;
  server_name 你的域名;
  return 301 https://$host$request_uri;
}
server {
  listen 443 ssl http2;
  server_name 你的域名;

  ssl_certificate     /etc/letsencrypt/live/域名/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/域名/privkey.pem;

  # 图片/静态资源
  root /srv/forum/public;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Cookie $http_cookie;
  }
}
```

证书用 [certbot](https://certbot.eff.org) 签发；国内需先完成域名备案且在 nginx 上启用 HTTPS。

### 4.3 可选：加一层反垃圾与限流

建议在 nginx 上做：单 IP 请求频率限制、上传体积限制；cookie 已带 `HttpOnly; SameSite=Lax`，
登录密码使用 **scrypt** 加盐哈希存储。

---

## 5. ICP 备案（大陆部署必读）

> 只要服务器在大陆境内，**必须先备案才能用域名 + 80/443 端口正式提供服务**；
> 支付宝/微信商户审核同样要求**已备案域名 + HTTPS**。走港澳台/海外服务器可免 ICP，
> 但无法接大陆支付通道，二者取其一。

### 5.1 前置条件

1. 域名已完成**实名认证**，且实名主体与备案主体一致（个人或个人独资/企业）；
2. 服务器购买时选择**大陆节点**（阿里云/腾讯云/华为云/京东云等）；
3. 域名有效期建议 ≥ 3 个月（部分省份管局硬性要求）。

### 5.2 备案流程（以阿里云/腾讯云为例，服务商全程代办）

| 步骤 | 内容 |
|---|---|
| 1 | 云控制台「ICP 备案」入口发起，选择接入商与备案服务码/关联服务器 IP |
| 2 | 填写**主体信息**：个人填身份证；企业填营业执照 + 法人身份证 |
| 3 | 填写**网站信息**：网站名称（不能含"论坛/社区/商城"等敏感词，可用"XX信息站"）、服务内容、前置审批项（无） |
| 4 | 人脸核验：服务商 App 内手持身份证拍照 |
| 5 | 服务商初审（1~2 天）→ 提交通信管理局审核（个人 1~4 周，企业 1~3 周） |
| 6 | 通过后取得备案号，如 `京ICP备XXXXXXXX号` |
| 7 | **公安备案**：上线后 30 日内到全国互联网安全管理服务平台（beian.mps.gov.cn）登记，取得公网安备号 |

### 5.3 网站合规要求（与本站相关的重点）

- 页脚必须展示**ICP 备案号**，并链接到 `https://beian.miit.gov.cn`；同时展示公安备案号。
  （本站 `public/index.html` 页脚已预留 `#foot-icp` 占位，替换文字即可。）
- 有用户注册与发言功能 → 需落实**实名注册**（本站注册已要求邮箱/密码，建议开启邮箱验证）、
  **不良信息巡查与投诉举报渠道**（管理员账号即投诉处理人）。
- 内容含"付费/交易/会员"等经营性活动 → 企业主体比个人主体更稳妥，
  也直接影响支付宝/微信商户能否通过审核。

### 5.4 常见坑

- 域名实名主体与备案主体不一致 → 被退回；
- 备案审核期间**域名不能解析到大陆服务器**对外提供 80/443 服务（管局抽查）；
  可先用 `服务器IP:3000` 联调内部流程；
- 更换服务商或机房 → 需做**接入备案变更**，不能直接沿用旧备案号；
- 部分省份（湖南、上海等）要求网站正式开通后提交"网站开通报告"。

---

## 6. 一键上云脚本（推荐）

仓库内已提供 `deploy/` 目录：

```
forum/deploy/
├── setup.sh        # 一键初始化：装环境 + 部署 + systemd + 防火墙 + nginx + HTTPS 证书 + 每日备份
├── forum.service   # systemd 服务单元（比 pm2 更稳，开机自启、崩溃自愈）
└── nginx.conf      # 反代 + 限流模板（setup.sh 自动替换域名）
```

### 6.1 使用步骤（约 10 分钟）

```bash
# 1) 服务器上先完成域名解析（A 记录 → 服务器公网 IP）

# 2) 本地把论坛目录上传到服务器（任选其一）
scp -r forum root@<服务器IP>:/root/forum
#   或
rsync -av --exclude 'forum.db*' forum/ root@<服务器IP>:/root/forum/

# 3) 登录服务器，一键部署
ssh root@<服务器IP>
cd /root/forum
sudo bash deploy/setup.sh 你的域名.com 你的邮箱@example.com

# 4) 填写支付密钥并重启
vi /srv/forum/.env        # 填入 Stripe/支付宝/微信凭据，PAY_MODE=live
systemctl restart forum
```

脚本自动完成：系统更新 → Node 24 → nginx + certbot → 创建 `forum` 系统账号 →
代码同步到 `/srv/forum`（保留线上 `forum.db` 与 `.env`）→ systemd 服务 →
UFW 防火墙 → HTTPS 证书（Let's Encrypt 自动续期）→ 每日凌晨 3 点备份数据库到
`/var/backups/forum/`。

### 6.2 手动等效操作（不跑脚本时）

- 服务：`cp deploy/forum.service /etc/systemd/system/ && systemctl enable --now forum`
- 反代：`sed "s/__DOMAIN__/你的域名/g" deploy/nginx.conf > /etc/nginx/sites-available/forum` 后启用
- 证书：`certbot --nginx -d 你的域名 --email 你的邮箱 --agree-tos --non-interactive --redirect`
- 备份：`0 3 * * * root cp /srv/forum/forum.db /var/backups/forum/forum-$(date +\%F).db`

### 6.3 服务器选购参考

- 最低配置 2C2G（Ubuntu 22.04/24.04 或 Debian 12），约 ¥50~¥100/月；
- 大陆节点+公网 IP；域名在境内注册商（便于实名认证）；
- 安全组放行：22 / 80 / 443（脚本内的 UFW 会自动配置）。

---

## 7. 数据与日志

- 数据全部存于 `forum/forum.db`（单文件 SQLite），备份即复制该文件。
- 结构：`users / sessions / categories / posts / replies / likes / orders / purchases /
  ads / pay_orders / ad_slots / slot_purchases / page_events`。
- `page_events` 为页面埋点（匿名按 cookie `vid` 去重、登录按 user_id），站长中心据此计算 DAU 与营收。

---

## 8. 上线检查清单

- [ ] `PAY_MODE=live` 且三类通道凭据已填
- [ ] 域名已备案、HTTPS 已启用
- [ ] 页脚已填写 ICP 备案号（含链接）与公安备案号
- [ ] 支付宝/微信商户已签约并配置 `notify_url` 回调域名
- [ ] Stripe webhook 已指向 `https://域名/api/pay/webhook/stripe`
- [ ] 已在站长中心「广告位库存」设定好对外出售的广告位套餐与售价
- [ ] 修改/去掉演示种子数据或清空 `forum.db` 后重新初始化正式账号
- [ ] 上线前备份 `forum.db`
- [ ] 已用 `deploy/setup.sh` 一键部署到大陆服务器（systemd + nginx + 证书 + 每日备份）