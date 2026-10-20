'use strict';
// stripe.js — 零依赖 Stripe 集成（Checkout 下单 + Webhook 签名校验）
// 仅使用 Node 内置 node:https / node:crypto，不引入任何 npm 依赖。
const https = require('node:https');
const crypto = require('node:crypto');

const STRIPE_API = 'api.stripe.com';

/**
 * 向 Stripe API 发送表单请求（POST）。
 * @returns {Promise<{status:number, body:object}>}
 */
function stripePost(secretKey, pathname, formData) {
  const body = new URLSearchParams(formData).toString();
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: STRIPE_API,
      path: '/v1' + pathname,
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(secretKey + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(data || '{}'); } catch { parsed = { raw: data }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 创建 Stripe Checkout Session（托管支付页）。
 * @param {object} opts
 *  - secretKey, amountUsdCents（美元·分）, item（商品描述）, metadata（{order_no}）,
 *  - successUrl, cancelUrl, customerEmail
 * @returns {Promise<{ok:boolean, id:string, url:string, error?:string}>}
 */
async function createCheckoutSession(opts) {
  const formData = {
    mode: 'payment',
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    customer_email: opts.customerEmail || undefined,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(opts.amountUsdCents),
    'line_items[0][price_data][product_data][name]': (opts.item || '拾光集充值').slice(0, 120),
    'metadata[order_no]': String(opts.metadata.order_no),
  };
  const r = await stripePost(opts.secretKey, '/checkout/sessions', formData);
  if (r.status >= 400 || !r.body.url) {
    const errMsg = r.body.error
      ? `${r.body.error.message || 'Stripe 错误'}（code: ${r.body.error.code || ''}）`
      : `Stripe 返回 ${r.status}`;
    return { ok: false, error: errMsg };
  }
  return { ok: true, id: r.body.id, url: r.body.url };
}

/**
 * 校验 Stripe Webhook 签名（Stripe-Signature: t=...,v1=...）。
 * 签名 = HMAC_SHA256(webhookSecret, `${timestamp}.${原始body}`)，恒定时间比较。
 * @param {Buffer|string} payload 原始请求体（必须原样）
 * @param {string} signatureHeader req.headers['stripe-signature']
 * @param {string} secret whsec_...
 * @returns {{ok:boolean, timestamp?:number, error?:string}}
 */
function verifyWebhookSignature(payload, signatureHeader, secret) {
  if (!signatureHeader || !secret) {
    return { ok: false, error: '缺少签名头或 webhook secret' };
  }
  const items = new Map(
    signatureHeader.split(',').map((s) => {
      const eq = s.indexOf('=');
      return [s.slice(0, eq), s.slice(eq + 1)];
    })
  );
  const timestamp = items.get('t');
  const signature = items.get('v1');
  if (!timestamp || !signature) return { ok: false, error: '签名头格式错误' };

  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const signed = `${timestamp}.${payloadBuffer.toString('utf-8')}`;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  const actual = Buffer.from(signature, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const ok = actual.length === expectedBuf.length &&
    crypto.timingSafeEqual(actual, expectedBuf);
  return { ok, timestamp: Number(timestamp) };
}

module.exports = { createCheckoutSession, verifyWebhookSignature, stripePost };