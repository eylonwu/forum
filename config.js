// config.js — 读取配置（手动解析 .env，无需 node --env-file）
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function loadEnv() {
  const p = path.join(__dirname, '.env');
  const out = {};
  if (fs.existsSync(p)) {
    const lines = fs.readFileSync(p, 'utf-8').split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[k] = v;
    }
  }
  return out;
}
const env = loadEnv();

// ---------- 支付模式 ----------
// sandbox：本地演示，提交订单即自动到账，不发真实外呼
// live   ：启用真实支付通道（需要在上方 .env 配好正式凭据）
const PAY_MODE = (env.PAY_MODE || 'sandbox').toLowerCase();

// 美元/人民币汇率（用于 Stripe 美元收款时的展示与换算）
const USD_RATE = Number(env.USD_CNY_RATE) || 7.1;

// 站点对外根地址：用于 Stripe Checkout 成功/取消回跳（上线后改为 https 域名）
const BASE_URL = (env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');

// 由站长分账：付费内容/广告点击收入进入一个汇总结算（其余保持站点所有）
// 保持简单，真实对账webhook见 deploy.md

// ---------- 各支付通道开关与凭据 ----------
const config = {
  payMode: PAY_MODE,
  usdRate: USD_RATE,
  baseUrl: BASE_URL,
  // 双通道能力声明
  channels: {
    stripe: !!env.STRIPE_SECRET_KEY,
    alipay: !!env.ALIPAY_APPID,
    wechat: !!env.WECHAT_MCHID,
  },
  // Stripe（美元）
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    publishableKey: env.STRIPE_PUBLISHABLE_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  },
  // 支付宝（中国大陆银行卡/花呗）
  alipay: {
    appId: env.ALIPAY_APPID || '',
    privateKey: env.ALIPAY_PRIVATE_KEY || '',
    publicKey: env.ALIPAY_PUBLIC_KEY || '',
    gateway: env.ALIPAY_GATEWAY || 'https://openapi.alipay.com/gateway.do',
  },
  // 微信支付（中国大陆银行卡/零钱）
  wechat: {
    mchid: env.WECHAT_MCHID || '',
    appid: env.WECHAT_APPID || '',
    apiv3Key: env.WECHAT_APIV3_KEY || '',
    serialNo: env.WECHAT_SERIAL_NO || '',
    privateKeyPath: env.WECHAT_PRIVATE_KEY_PATH || '',
    notifyUrl: env.WECHAT_NOTIFY_URL || '',
  },
};

module.exports = config;