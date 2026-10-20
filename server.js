'use strict';
// server.js — 论坛后端服务（零依赖：node:http + node:sqlite）
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config.js');
const { db, hashPassword, verifyPassword } = require('./db.js');
const stripe = require('./stripe.js');

const PAY = config; // 支付配置（payMode / channels / usdRate ...）

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL_HOURS = 24 * 7;
const UPLOAD_BODY_LIMIT = 512 * 1024;

// ---------- 工具 ----------
function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > UPLOAD_BODY_LIMIT) {
        reject(Object.assign(new Error('payload too large'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('bad json'), { code: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// 原始请求体（webhook 验签需要原样字节，不能经 JSON 解析）
function readRawBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------- 简易限流（防暴力破解/刷接口，内存滑动窗口） ----------
const rateBuckets = new Map();
function rateLimit(req, res, { max = 20, windowMs = 60000, label = '' } = {}) {
  const ip = ((req.headers['x-forwarded-for'] || '').split(',')[0].trim())
    || (req.socket && req.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  let hit = rateBuckets.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > hit.resetAt) hit = { count: 0, resetAt: now + windowMs };
  hit.count++;
  rateBuckets.set(ip, hit);
  if (rateBuckets.size > 5000) {
    // 防止 Map 无限膨胀：顺带清掉已过期桶
    for (const [k, v] of rateBuckets) if (v.resetAt < now) rateBuckets.delete(k);
  }
  if (hit.count > max) {
    json(res, 429, { error: `${label}过于频繁，请稍后再试` });
    return false;
  }
  return true;
}

// 定期清理过期会话，防止 sessions 表长期运行后膨胀
setInterval(() => {
  try {
    const r = db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
    if (r.changes) console.log(`[cleanup] 已清理 ${r.changes} 条过期会话`);
  } catch (e) { console.error('[cleanup] 会话清理失败:', e); }
}, 6 * 3600 * 1000);

// ---------- 会话 ----------
function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000)
    .toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)')
    .run(token, userId, expires);
  return { token, expires };
}

function currentUser(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const row = db.prepare(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).get(m[1]);
  return row || null;
}

function setSessionCookie(res, token, expires) {
  res.setHeader('Set-Cookie',
    `sid=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_HOURS * 3600}; SameSite=Lax`);
}

const FREE_CATEGORY = { id: 0, name: '全部分类', slug: 'all', color: '#334155', description: '' };

// auth 守卫
function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: '请先登录' });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: '请先登录' });
  if (user.role !== 'admin') return json(res, 403, { error: '仅管理员可操作' });
  req.user = user;
  next();
}

// ---------- 付费内容可见性 ----------
// 付费帖：仅作者、已购买者可见全文，否则只给预览
function postView(post, user) {
  const copy = { ...post };
  if (post.price > 0) {
    const unlocked = user && (user.id === post.user_id || post.purchased);
    copy.unlocked = !!unlocked;
    if (!unlocked) {
      copy.content = post.content.length > 140
        ? post.content.slice(0, 140) + ' ……'
        : post.content;
    }
  } else {
    copy.unlocked = true;
  }
  return copy;
}

const POST_SELECT = `
  SELECT p.id, p.title, p.content, p.price, p.status, p.views, p.created_at,
         p.user_id, p.category_id,
         u.username AS author, u.avatar AS author_avatar, u.membership AS author_membership,
         c.name AS category, c.slug AS category_slug, c.color AS category_color,
         (SELECT COUNT(*) FROM replies r WHERE r.post_id = p.id) AS reply_count,
         (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count
  FROM posts p
  JOIN users u ON u.id = p.user_id
  JOIN categories c ON c.id = p.category_id`;

// ---------- 广告服务 ----------
function serveAd(position, userId) {
  if (position !== 'banner' && position !== 'sidebar') return null;
  const ad = db.prepare(
    `SELECT * FROM ads WHERE position = ? AND status = 'running' AND spent < budget
     ORDER BY impressions ASC LIMIT 1`
  ).get(position);
  if (!ad) return null;
  db.prepare('UPDATE ads SET impressions = impressions + 1 WHERE id = ?').run(ad.id);
  return {
    id: ad.id,
    title: ad.title,
    image_url: ad.image_url,
    link_url: ad.link_url,
    position: ad.position,
  };
}

// ---------- 路由表 ----------
const routes = [];
function get(pathPattern, handler) { routes.push(['GET', pathPattern, handler]); }
function post(pathPattern, handler) { routes.push(['POST', pathPattern, handler]); }
function match(pathPattern, urlPath) {
  const parts = pathPattern.split('/').filter(Boolean);
  const segs = urlPath.split('?')[0].split('/').filter(Boolean);
  if (parts.length !== segs.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(':')) params[parts[i].slice(1)] = decodeURIComponent(segs[i]);
    else if (parts[i] !== segs[i]) return null;
  }
  return params;
}

// ============ 健康检查（Render 探活） ============
get('/api/health', (req, res) => {
  json(res, 200, { ok: true, name: '拾光集', time: new Date().toISOString() });
});

// ============ SEO：服务端预渲染 / robots.txt / sitemap.xml ============
const SITE_NAME = '拾光集';
const SITE_DESC = '一个温和、认真的中文讨论社区：公开注册、友好讨论、付费内容、会员与广告投放。';

let indexHtml = '';
try { indexHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf-8'); } catch {}

function escAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function seoDesc(text, fallback) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return fallback;
  return t.length > 140 ? t.slice(0, 140) + '…' : t;
}
function html200(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
}

// 基于 index.html 模板注入标题/描述/canonical/OG/JSON-LD，实现可被搜索引擎收录的预渲染页
function renderShell(o) {
  const title = o.title ? `${o.title} · ${SITE_NAME}` : `${SITE_NAME} · 友好讨论社区`;
  const desc = o.description || SITE_DESC;
  const canonical = o.canonical || PAY.baseUrl + '/';
  const jsonLd = o.jsonLd ? `<script type="application/ld+json">${JSON.stringify(o.jsonLd)}</script>` : '';
  let html = indexHtml;
  if (!html) {
    html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escAttr(title)}</title></head><body><main id="app"></main><script src="/app.js"></script></body></html>`;
  }
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escAttr(title)}</title>`);
  html = html.replace(/(<meta name="description" content=")[^"]*(")/i, `$1${escAttr(desc)}$2`);
  const extra = `
  <link rel="canonical" href="${escAttr(canonical)}" />
  <meta property="og:site_name" content="${escAttr(SITE_NAME)}" />
  <meta property="og:title" content="${escAttr(title)}" />
  <meta property="og:description" content="${escAttr(desc)}" />
  <meta property="og:type" content="${o.ogType || 'website'}" />
  <meta property="og:url" content="${escAttr(canonical)}" />
  <meta name="twitter:card" content="summary" />
  <meta name="robots" content="index,follow" />${jsonLd}`;
  return html.replace('</head>', extra + '</head>');
}

get('/', (req, res) => {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url: PAY.baseUrl + '/',
    description: SITE_DESC,
    potentialAction: {
      '@type': 'SearchAction',
      target: PAY.baseUrl + '/?q={search_term_string}',
      'query-input': 'required name=search_term_string',
    },
  };
  html200(res, renderShell({ canonical: PAY.baseUrl + '/', jsonLd }));
});

get('/post/:id', (req, res) => {
  const id = Number(req.params.id);
  const p = db.prepare(POST_SELECT + ' WHERE p.id = ?').get(id);
  if (!p || p.status === 'hidden') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not Found');
  }
  const canonical = `${PAY.baseUrl}/post/${p.id}`;
  const desc = seoDesc(p.content, p.title);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: p.title,
    description: desc,
    author: { '@type': 'Person', name: p.author },
    datePublished: p.created_at,
    mainEntityOfPage: canonical,
  };
  html200(res, renderShell({ title: p.title, description: desc, canonical, ogType: 'article', jsonLd }));
});

get('/c/:slug', (req, res) => {
  const c = db.prepare('SELECT * FROM categories WHERE slug = ?').get(req.params.slug);
  if (!c) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not Found');
  }
  html200(res, renderShell({
    title: c.name,
    description: seoDesc(c.description, `${c.name}分类下的讨论内容`),
    canonical: `${PAY.baseUrl}/c/${c.slug}`,
  }));
});

get('/robots.txt', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`User-agent: *\nAllow: /\nSitemap: ${PAY.baseUrl}/sitemap.xml\n`);
});

get('/sitemap.xml', (req, res) => {
  const base = PAY.baseUrl;
  const urls = [{ loc: base + '/', lastmod: new Date().toISOString().slice(0, 10) }];
  db.prepare('SELECT slug FROM categories').all()
    .forEach((c) => urls.push({ loc: `${base}/c/${c.slug}` }));
  db.prepare("SELECT id, created_at FROM posts WHERE status != 'hidden' ORDER BY created_at DESC LIMIT 500").all()
    .forEach((p) => urls.push({ loc: `${base}/post/${p.id}`, lastmod: String(p.created_at || '').slice(0, 10) }));
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => `  <url><loc>${escAttr(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n') +
    '\n</urlset>';
  res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
  res.end(xml);
});

// ============ 鉴权 ============
post('/api/register', async (req, res) => {
  if (!rateLimit(req, res, { max: 10, windowMs: 60000, label: '注册' })) return;
  const b = await readBody(req);
  const username = (b.username || '').trim();
  const email = (b.email || '').trim();
  const password = String(b.password || '');
  if (username.length < 2 || username.length > 20) return json(res, 400, { error: '用户名需 2-20 个字符' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: '邮箱格式不正确' });
  if (password.length < 6) return json(res, 400, { error: '密码至少 6 位' });
  try {
    const { hash } = hashPassword(password);
    const r = db.prepare(
      'INSERT INTO users (username, email, password_hash) VALUES (?,?,?)'
    ).run(username, email, hash);
    const { token, expires } = createSession(r.lastInsertRowid);
    setSessionCookie(res, token, expires);
    json(res, 200, { ok: true });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return json(res, 409, { error: '用户名或邮箱已被注册' });
    throw e;
  }
});

post('/api/login', async (req, res) => {
  if (!rateLimit(req, res, { max: 20, windowMs: 60000, label: '登录' })) return;
  const b = await readBody(req);
  const account = (b.account || '').trim().toLowerCase();
  const password = String(b.password || '');
  const user = db.prepare('SELECT * FROM users WHERE LOWER(username)=? OR LOWER(email)=?').get(account, account);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return json(res, 401, { error: '账号或密码错误' });
  }
  const { token, expires } = createSession(user.id);
  setSessionCookie(res, token, expires);
  json(res, 200, { ok: true, user: publicUser(user) });
});

post('/api/logout', (req, res) => {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
  if (m) db.prepare('DELETE FROM sessions WHERE token = ?').run(m[1]);
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  json(res, 200, { ok: true });
});

function publicUser(u) {
  const membership = u.membership || 'none';
  const membershipPrice = { bronze: 18, silver: 38, gold: 88 }[membership];
  return {
    id: u.id, username: u.username, email: u.email, role: u.role,
    avatar: u.avatar, bio: u.bio, balance: u.balance,
    membership, membership_expires: u.membership_expires,
    membership_price: membershipPrice,
  };
}

get('/api/me', (req, res) => {
  const user = currentUser(req);
  json(res, 200, user ? { user: publicUser(user) } : { user: null });
});

// ============ 分类与帖子 ============
get('/api/categories', (req, res) => {
  const rows = db.prepare('SELECT * FROM categories ORDER BY sort').all();
  json(res, 200, { categories: [FREE_CATEGORY, ...rows] });
});

get('/api/posts', (req, res) => {
  const url = new URL(req.url, 'http://x');
  const slug = url.searchParams.get('category') || 'all';
  const q = (url.searchParams.get('q') || '').trim();
  const user = currentUser(req);
  let sql = POST_SELECT + ' WHERE p.status != ?';
  const args = ['hidden'];
  if (slug !== 'all') {
    sql += ' AND c.slug = ?';
    args.push(slug);
  }
  if (q) {
    sql += ' AND (p.title LIKE ? OR p.content LIKE ? OR u.username LIKE ?)';
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY p.created_at DESC LIMIT 200';
  const rows = db.prepare(sql).all(...args);

  // 已购买集合
  const paidIds = new Set();
  if (user) {
    const buys = db.prepare('SELECT post_id FROM purchases WHERE user_id = ?').all(user.id);
    buys.forEach((x) => paidIds.add(x.post_id));
  }
  const posts = rows.map((p) =>
    postView({ ...p, purchased: paidIds.has(p.id) }, user));
  json(res, 200, { posts });
});

get('/api/posts/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return json(res, 400, { error: '参数错误' });
  const user = currentUser(req);
  const post = db.prepare(POST_SELECT + ' WHERE p.id = ?').get(id);
  if (!post || post.status === 'hidden' && !(user && user.role === 'admin')) {
    return json(res, 404, { error: '帖子不存在' });
  }
  db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').run(id);

  let purchased = false;
  if (user) purchased = !!db.prepare('SELECT 1 FROM purchases WHERE user_id=? AND post_id=?').get(user.id, id);
  const view = postView({ ...post, purchased }, user);

  const replies = db.prepare(
    `SELECT r.id, r.content, r.created_at, r.user_id,
            u.username, u.avatar, u.membership
     FROM replies r JOIN users u ON u.id = r.user_id
     WHERE r.post_id = ? ORDER BY r.created_at ASC`
  ).all(id);

  let liked = false;
  if (user) liked = !!db.prepare('SELECT 1 FROM likes WHERE user_id=? AND post_id=?').get(user.id, id);

  json(res, 200, { post: view, replies, liked, isAuthor: !!(user && user.id === post.user_id) });
});

post('/api/posts', async (req, res) => {
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: '请先登录' });
  const b = await readBody(req);
  const title = (b.title || '').trim();
  const content = (b.content || '').trim();
  const categoryId = Number(b.category_id);
  const price = Math.max(0, Number(b.price) || 0);
  if (!title || title.length > 80) return json(res, 400, { error: '标题不能为空且不超过 80 字' });
  if (!content || content.length < 4) return json(res, 400, { error: '内容太短' });
  if (!db.prepare('SELECT 1 FROM categories WHERE id=?').get(categoryId)) {
    return json(res, 400, { error: '分类不存在' });
  }
  if (price < 0 || price > 999) return json(res, 400, { error: '价格需在 0-999 之间' });
  const r = db.prepare(
    'INSERT INTO posts (user_id, category_id, title, content, price) VALUES (?,?,?,?,?)'
  ).run(user.id, categoryId, title, content, price);
  json(res, 200, { ok: true, id: r.lastInsertRowid });
});

post('/api/posts/:id/reply', async (req, res) => {
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: '请先登录' });
  const id = Number(req.params.id);
  const b = await readBody(req);
  const content = (b.content || '').trim();
  if (!content || content.length > 2000) return json(res, 400, { error: '回复内容无效' });
  const post = db.prepare('SELECT id,status FROM posts WHERE id=?').get(id);
  if (!post || post.status === 'hidden') return json(res, 404, { error: '帖子不存在' });
  db.prepare('INSERT INTO replies (post_id, user_id, content) VALUES (?,?,?)').run(id, user.id, content);
  json(res, 200, { ok: true });
});

post('/api/posts/:id/like', (req, res) => {
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: '请先登录' });
  const id = Number(req.params.id);
  const exists = db.prepare('SELECT 1 FROM posts WHERE id=?').get(id);
  if (!exists) return json(res, 404, { error: '帖子不存在' });
  const liked = db.prepare('DELETE FROM likes WHERE user_id=? AND post_id=?').run(user.id, id).changes;
  if (!liked) db.prepare('INSERT INTO likes (user_id, post_id) VALUES (?,?)').run(user.id, id);
  const count = db.prepare('SELECT COUNT(*) c FROM likes WHERE post_id=?').get(id).c;
  json(res, 200, { ok: true, liked: !liked, count });
});

// 付费解锁
post('/api/posts/:id/unlock', async (req, res) => {
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: '请先登录' });
  const id = Number(req.params.id);
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(id);
  if (!post || post.status === 'hidden') return json(res, 404, { error: '帖子不存在' });
  if (post.price <= 0) return json(res, 400, { error: '这是免费帖' });
  if (user.id === post.user_id) return json(res, 400, { error: '这是你自己的帖子' });
  const bought = db.prepare('SELECT 1 FROM purchases WHERE user_id=? AND post_id=?').get(user.id, id);
  if (bought) return json(res, 200, { ok: true, already: true });
  if (user.balance < post.price) {
    return json(res, 402, { error: '余额不足，请先充值', need: post.price - user.balance });
  }
  const amount = Number(post.price);
  // 记账 + 扣款（事务）
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amount, user.id);
    db.prepare(
      'INSERT INTO orders (user_id, type, item, amount) VALUES (?,?,?,?)'
    ).run(user.id, 'post', `购买《${post.title}》`, amount);
    db.prepare('INSERT INTO purchases (user_id, post_id, amount) VALUES (?,?,?)').run(user.id, id, amount);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  json(res, 200, { ok: true, balance: u.balance, full: post.content });
});

// ============ 账户 / 余额 / 会员（演示沿用同一余额）============
get('/api/account', (req, res) => {
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: '请先登录' });
  const orders = db.prepare(
    'SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 100'
  ).all(user.id);
  const purchases = db.prepare(
    `SELECT p.id, p.title, pc.amount, pc.created_at FROM purchases pc
     JOIN posts p ON p.id = pc.post_id WHERE pc.user_id=? ORDER BY pc.created_at DESC LIMIT 100`
  ).all(user.id);
  json(res, 200, { user: publicUser(user), orders, purchases });
});

post('/api/recharge', async (req, res) => {
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: '请先登录' });
  const b = await readBody(req);
  let amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount < 1 || amount > 10000) {
    return json(res, 400, { error: '充值金额需在 1-10000 之间' });
  }
  amount = Math.round(amount * 100) / 100;
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, user.id);
    db.prepare('INSERT INTO orders (user_id, type, item, amount) VALUES (?,?,?,?)')
      .run(user.id, 'recharge', `账户充值`, amount);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  json(res, 200, { ok: true, balance: u.balance });
});

post('/api/membership', async (req, res) => {
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: '请先登录' });
  const b = await readBody(req);
  const tier = (b.tier || '').toLowerCase();
  const prices = { bronze: 18, silver: 38, gold: 88 };
  const perks = {
    bronze: '普通会员：金色昵称徽章',
    silver: '高级会员：金色徽章 + 优先回复置顶',
    gold: '至尊会员：金色徽章 + 专属配色 + 免广告',
  };
  if (!prices[tier]) return json(res, 400, { error: '无效的会员等级' });
  if (user.membership === tier) return json(res, 400, { error: '已是该等级会员' });
  const price = prices[tier];
  if (user.balance < price) return json(res, 402, { error: '余额不足，请先充值', need: price - user.balance });
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE users SET balance = balance - ?, membership = ?, membership_expires = ? WHERE id = ?')
      .run(price, tier, expires, user.id);
    db.prepare('INSERT INTO orders (user_id, type, item, amount) VALUES (?,?,?,?)')
      .run(user.id, 'membership', `${perks[tier]} · 月卡`, price);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  json(res, 200, { ok: true, balance: u.balance, user: publicUser(u) });
});

// ============ 实时支付（双通道：Stripe 美元 + 支付宝/微信人民币）============
function genOrderNo() {
  return 'P' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
}
const MEMBER_PRICE = { bronze: 18, silver: 38, gold: 88 };
const MEMBER_PERK = {
  bronze: '普通会员：金色昵称徽章',
  silver: '高级会员：金色徽章 + 优先回复置顶',
  gold: '至尊会员：金色徽章 + 专属配色 + 免广告',
};

// 可用支付通道（按支付模式降级为 sandbox）
function availableChannels() {
  const base = {
    alipay: { label: '支付宝', tag: '人民币/大陆银行卡/花呗', on: !!(PAY.channels.alipay) },
    wechat: { label: '微信支付', tag: '人民币/大陆银行卡/零钱', on: !!(PAY.channels.wechat) },
    stripe: { label: 'Stripe', tag: '美元/美元账户', on: !!(PAY.channels.stripe) },
  };
  if (PAY.payMode !== 'live') {
    base.sandbox = { label: '沙箱（演示）', tag: '无真实扣款，即点即到账', on: true };
  } else if (!Object.values(base).some((c) => c.on)) {
    // live 模式但一个真实通道都没配置：退回沙箱，避免收银台空白/误扣
    base.sandbox = { label: '沙箱（降级）', tag: '未配置支付凭据，暂以演示模式运行', on: true };
  }
  return base;
}

// 创建支付订单；沙箱模式立即结算
post('/api/pay/create', async (req, res) => {
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: '请先登录' });
  const b = await readBody(req);
  const type = (b.type || '').toLowerCase();
  const channel = (b.channel || '').toLowerCase();
  const channels = availableChannels();
  if (channel && !channels[channel]) return json(res, 400, { error: '该支付通道未开通或不可用' });
  const effChannel = channel || (PAY.payMode === 'live' ? 'alipay' : 'sandbox');

  let amountCny = 0, amountUsd = 0, item = '', meta = { type };

  if (type === 'recharge') {
    amountCny = Number(b.amount);
    if (!Number.isFinite(amountCny) || amountCny < 1 || amountCny > 10000) {
      return json(res, 400, { error: '充值金额需在 1-10000 之间' });
    }
    item = `账户充值 ¥${amountCny}`;
  } else if (type === 'membership') {
    const tier = (b.tier || '').toLowerCase();
    if (!MEMBER_PRICE[tier]) return json(res, 400, { error: '无效的会员等级' });
    if (user.membership === tier) return json(res, 400, { error: '已是该等级会员' });
    amountCny = MEMBER_PRICE[tier];
    item = `${MEMBER_PERK[tier]} · 30天`;
    meta.tier = tier;
  } else if (type === 'post') {
    const post = db.prepare('SELECT * FROM posts WHERE id=?').get(Number(b.post_id));
    if (!post || post.status === 'hidden') return json(res, 404, { error: '帖子不存在' });
    if (post.price <= 0) return json(res, 400, { error: '这是免费帖' });
    if (user.id === post.user_id) return json(res, 400, { error: '不能购买自己的帖子' });
    if (db.prepare('SELECT 1 FROM purchases WHERE user_id=? AND post_id=?').get(user.id, post.id)) {
      return json(res, 400, { error: '已购买过该内容' });
    }
    amountCny = post.price;
    item = `解锁付费帖《${post.title}》`;
    meta.post_id = post.id;
  } else if (type === 'ad') {
    // 直接为已创建广告（未审核）充值预算——先落地一条 pending 广告，支付后进入审核
    const snap = {
      title: (b.title || '').trim(), link_url: (b.link_url || '').trim(),
      image_url: (b.image_url || '').trim(), position: (b.position === 'banner' ? 'banner' : 'sidebar'),
      budget: Math.max(10, Number(b.budget) || 10), cpc: Math.max(0.1, Number(b.cpc) || 0.5),
    };
    if (!snap.title || snap.title.length > 40) return json(res, 400, { error: '广告标题不能为空且不超过 40 字' });
    if (!/^https?:\/\//.test(snap.link_url)) return json(res, 400, { error: '请填写正确的链接（http/https）' });
    amountCny = snap.budget;
    item = `广告投放《${snap.title}》预算`;
    meta.campaign = snap;
  } else if (type === 'ad_slot') {
    const slot = db.prepare('SELECT * FROM ad_slots WHERE id=? AND available=1').get(Number(b.slot_id));
    if (!slot) return json(res, 404, { error: '广告位不存在或已停售' });
    amountCny = slot.price;
    item = `广告位：${slot.name}`;
    meta.slot_id = slot.id;
  } else {
    return json(res, 400, { error: '不支持的支付类型' });
  }

  amountCny = Math.round(amountCny * 100) / 100;
  amountUsd = Math.round((amountCny / PAY.usdRate) * 100) / 100;

  const orderNo = genOrderNo();
  const r = db.prepare(
    `INSERT INTO pay_orders (order_no, user_id, type, item, amount_cny, amount_usd, channel, meta)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(orderNo, user.id, type, item, amountCny, amountUsd, effChannel, JSON.stringify(meta));

  const po = db.prepare('SELECT * FROM pay_orders WHERE id=?').get(r.lastInsertRowid);

  if (effChannel === 'sandbox') {
    settleOrder(po);
    json(res, 200, {
      ok: true, sandbox: true,
      order: { order_no: orderNo, item, amount_cny: amountCny, amount_usd: amountUsd, channel: effChannel, status: 'paid' },
    });
    return;
  }

  // ---- 真实通道 ----
  if (effChannel === 'stripe') {
    if (!PAY.stripe.secretKey) {
      db.prepare("UPDATE pay_orders SET status='failed' WHERE id=?").run(po.id);
      return json(res, 400, { error: 'Stripe 尚未配置（.env 缺少 STRIPE_SECRET_KEY）' });
    }
    const cs = await stripe.createCheckoutSession({
      secretKey: PAY.stripe.secretKey,
      amountUsdCents: Math.max(50, Math.round(amountUsd * 100)), // Stripe 单笔 ≥ $0.50
      item,
      metadata: { order_no: orderNo },
      customerEmail: user.email,
      successUrl: `${PAY.baseUrl}/#/pay-result?order=${orderNo}&status=success`,
      cancelUrl: `${PAY.baseUrl}/#/pay-result?order=${orderNo}&status=cancel`,
    });
    if (!cs.ok) {
      db.prepare("UPDATE pay_orders SET status='failed' WHERE id=?").run(po.id);
      return json(res, 502, { error: '创建 Stripe 支付单失败', detail: cs.error });
    }
    // 记录第三方订单号（Checkout Session id）与支付链接
    db.prepare("UPDATE pay_orders SET provider_order=?, meta=? WHERE id=?")
      .run(cs.id, JSON.stringify({ ...meta, checkout_url: cs.url }), po.id);
    json(res, 200, {
      ok: true, sandbox: false,
      order: { order_no: orderNo, item, amount_cny: amountCny, amount_usd: amountUsd, channel: effChannel, status: 'pending' },
      provider: { type: 'stripe_checkout', url: cs.url, session_id: cs.id },
    });
    return;
  }

  // 支付宝/微信：需先配置对应商户凭据（见 deploy.md），未配置则提示
  json(res, 400, { error: `${effChannel === 'alipay' ? '支付宝' : '微信支付'}通道未配置商户凭据，请联系站长开通` });
});

// 沙箱/测试回调解：标记订单已支付并结算
post('/api/pay/simulate', async (req, res) => {
  const b = await readBody(req);
  const orderNo = (b.order_no || '').trim();
  const po = db.prepare('SELECT * FROM pay_orders WHERE order_no=?').get(orderNo);
  if (!po) return json(res, 404, { error: '订单不存在' });
  if (po.status === 'paid') return json(res, 200, { ok: true, already: true });
  if (po.status === 'cancelled') return json(res, 400, { error: '订单已取消' });
  settleOrder(po);
  json(res, 200, { ok: true });
});

// Stripe Webhook 回调（真实收款确认入口；必须公网 HTTPS 可达，见 deploy.md）
post('/api/pay/webhook/stripe', async (req, res) => {
  const raw = await readRawBody(req);
  const sig = req.headers['stripe-signature'] || '';
  const secret = PAY.stripe.webhookSecret;
  const check = stripe.verifyWebhookSignature(raw, sig, secret);
  if (!check.ok) {
    console.error('[stripe-webhook] 验签失败:', check.error);
    return json(res, 400, { error: '签名校验失败' });
  }
  // 防重放：与当前时间偏差超过 5 分钟拒绝
  if (Math.abs(Date.now() / 1000 - check.timestamp) > 300) {
    return json(res, 400, { error: '事件时间戳过期' });
  }
  let event;
  try { event = JSON.parse(raw.toString('utf-8')); } catch {
    return json(res, 400, { error: '事件格式错误' });
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object || {};
    const orderNo = session.metadata && session.metadata.order_no;
    if (!orderNo) return json(res, 400, { error: '缺少订单号' });
    const po = db.prepare('SELECT * FROM pay_orders WHERE order_no=?').get(orderNo);
    if (!po) return json(res, 404, { error: '订单不存在' });
    if (po.status === 'paid') return json(res, 200, { ok: true, already: true }); // 幂等
    settleOrder(po);
  }
  // 其他事件（payment_intent 等）直接 200 确认接收
  json(res, 200, { ok: true, received: event.type });
});

// 结算支付订单：根据类型落地权益/记账
function settleOrder(po) {
  const meta = JSON.parse(po.meta || '{}');
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    if (po.status !== 'paid') {
      db.prepare("UPDATE pay_orders SET status='paid', paid_at=? WHERE id=?").run(now, po.id);
    }
    if (po.type === 'recharge') {
      db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(po.amount_cny, po.user_id);
      db.prepare('INSERT INTO orders (user_id, type, item, amount) VALUES (?,?,?,?)')
        .run(po.user_id, 'recharge', po.item, po.amount_cny);
    } else if (po.type === 'membership') {
      const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
      db.prepare('UPDATE users SET membership=?, membership_expires=? WHERE id=?')
        .run(meta.tier, expires, po.user_id);
      db.prepare('INSERT INTO orders (user_id, type, item, amount) VALUES (?,?,?,?)')
        .run(po.user_id, 'membership', po.item, po.amount_cny);
    } else if (po.type === 'post') {
      if (!db.prepare('SELECT 1 FROM purchases WHERE user_id=? AND post_id=?').get(po.user_id, meta.post_id)) {
        db.prepare('INSERT INTO purchases (user_id, post_id, amount) VALUES (?,?,?)')
          .run(po.user_id, meta.post_id, po.amount_cny);
        db.prepare('INSERT INTO orders (user_id, type, item, amount) VALUES (?,?,?,?)')
          .run(po.user_id, 'post', po.item, po.amount_cny);
      }
    } else if (po.type === 'ad') {
      const c = meta.campaign;
      const adR = db.prepare(
        'INSERT INTO ads (user_id, title, image_url, link_url, position, budget, cpc, status) VALUES (?,?,?,?,?,?,?,?)'
      ).run(po.user_id, c.title, c.image_url, c.link_url, c.position, c.budget, c.cpc, 'pending');
      db.prepare('INSERT INTO orders (user_id, type, item, amount) VALUES (?,?,?,?)')
        .run(po.user_id, 'ad_recharge', po.item, po.amount_cny);
      db.prepare('UPDATE pay_orders SET meta=? WHERE id=?').run(
        JSON.stringify({ ...meta, ad_id: adR.lastInsertRowid }), po.id);
    } else if (po.type === 'ad_slot') {
      const start = now, end = new Date(Date.now() + (meta.duration_days || 7) * 864e5).toISOString();
      db.prepare('INSERT INTO slot_purchases (user_id, slot_id, amount, start_at, end_at) VALUES (?,?,?,?,?)')
        .run(po.user_id, meta.slot_id, po.amount_cny, start, end);
      db.prepare('UPDATE ad_slots SET sold = sold + 1 WHERE id=?').run(meta.slot_id);
      db.prepare('INSERT INTO orders (user_id, type, item, amount) VALUES (?,?,?,?)')
        .run(po.user_id, 'ad_slot', po.item, po.amount_cny);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// 我的支付订单
get('/api/pay/my', (req, res) => {
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: '请先登录' });
  const orders = db.prepare(
    'SELECT order_no, type, item, amount_cny, amount_usd, channel, status, created_at FROM pay_orders WHERE user_id=? ORDER BY created_at DESC LIMIT 50'
  ).all(user.id);
  const channels = availableChannels();
  json(res, 200, { orders, channels, payMode: PAY.payMode, usdRate: PAY.usdRate });
});

// ============ 可售广告位 ============
get('/api/ad-slots', (req, res) => {
  const slots = db.prepare('SELECT * FROM ad_slots ORDER BY sort').all();
  json(res, 200, { slots });
});

get('/api/slots/my', (req, res) => {
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: '请先登录' });
  const rows = db.prepare(
    `SELECT sp.*, s.name AS slot_name, s.position FROM slot_purchases sp
     JOIN ad_slots s ON s.id = sp.slot_id WHERE sp.user_id=? ORDER BY sp.created_at DESC`
  ).all(user.id);
  json(res, 200, { purchases: rows });
});

// ============ 页面埋点（用户日活） ============
post('/api/track', (req, res) => {
  const user = currentUser(req);
  const url = new URL(req.url, 'http://x');
  const page = (url.searchParams.get('page') || '/').slice(0, 120);
  let vid = ((req.headers.cookie || '').match(/vid=([^;]+)/) || [])[1] || '';
  if (!vid) {
    vid = 'v' + crypto.randomBytes(9).toString('hex');
    res.setHeader('Set-Cookie', `vid=${vid}; Path=/; Max-Age=15552000; SameSite=Lax`);
  }
  const sessionId = user ? `u${user.id}` : vid;
  db.prepare('INSERT INTO page_events (user_id, session_id, page) VALUES (?,?,?)')
    .run(user ? user.id : null, sessionId, page);
  json(res, 200, { ok: true });
});

// ============ 站长后台：营收与日活 ============
// 日活 = 当日访问的去重身份（登录用户按 user_id，游客按匿名 session）
function dauSeries(days) {
  const start = `datetime('now','-${days - 1} days','localtime')`;
  const rows = db.prepare(
    `SELECT date(created_at) AS d,
            COUNT(DISTINCT COALESCE(user_id, session_id)) AS c
     FROM page_events WHERE created_at >= ${start} GROUP BY d ORDER BY d`
  ).all();
  const dayMap = Object.fromEntries(rows.map((r) => [r.d, r.c]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toLocaleDateString('sv-SE'); // YYYY-MM-DD
    out.push({ date: key, count: dayMap[key] || 0 });
  }
  return out;
}

function revenueSeries(days) {
  const start = `datetime('now','-${days - 1} days','localtime')`;
  const rows = db.prepare(
    `SELECT date(created_at) AS d, SUM(amount) AS s, COUNT(*) AS n
     FROM orders WHERE status='paid' AND created_at >= ${start} GROUP BY d ORDER BY d`
  ).all();
  const dayMap = Object.fromEntries(rows.map((r) => [r.d, r]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toLocaleDateString('sv-SE');
    const hit = dayMap[key];
    out.push({ date: key, amount: hit ? hit.s : 0, count: hit ? hit.n : 0 });
  }
  return out;
}

get('/api/admin/dashboard', (req, res) => {
  const dau = dauSeries(14);
  const revenue = revenueSeries(14);
  const revenueByType = db.prepare(
    `SELECT type, SUM(amount) s, COUNT(*) n FROM orders WHERE status='paid' GROUP BY type`
  ).all();
  const todayDau = dau[dau.length - 1].count;
  const peakDau = Math.max(...dau.map((x) => x.count), 0);
  const todayRevenue = revenue[revenue.length - 1].amount;
  json(res, 200, { dau, revenue, revenueByType, todayDau, peakDau, todayRevenue });
});

// ============ 管理：可售广告位 ====
get('/api/admin/slots', (req, res) => {
  const slots = db.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM slot_purchases sp WHERE sp.slot_id=s.id) AS booking_count
     FROM ad_slots s ORDER BY s.sort`
  ).all();
  json(res, 200, { slots });
});

post('/api/admin/slots', async (req, res) => {
  const b = await readBody(req);
  const name = (b.name || '').trim();
  const position = (b.position === 'banner' ? 'banner' : 'sidebar');
  const price = Math.max(1, Number(b.price) || 0);
  const durationDays = Math.max(1, Number(b.duration_days) || 7);
  if (!name || name.length > 40) return json(res, 400, { error: '请输入套餐名' });
  const r = db.prepare(
    'INSERT INTO ad_slots (name, position, description, price, duration_days, available, sort) VALUES (?,?,?,?,?,?,?)'
  ).run(name, position, (b.description || '').trim(), price, durationDays, 1,
    db.prepare('SELECT COALESCE(MAX(sort),0)+1 s FROM ad_slots').get().s);
  json(res, 200, { ok: true, id: r.lastInsertRowid });
});

post('/api/admin/slots/:id', async (req, res) => {
  const b = await readBody(req);
  const id = Number(req.params.id);
  const slot = db.prepare('SELECT * FROM ad_slots WHERE id=?').get(id);
  if (!slot) return json(res, 404, { error: '广告位不存在' });
  const sets = [];
  const args = [];
  if (typeof b.price === 'number') { sets.push('price=?'); args.push(Math.max(1, b.price)); }
  if (typeof b.duration_days === 'number') { sets.push('duration_days=?'); args.push(Math.max(1, b.duration_days)); }
  if (typeof b.available === 'number') { sets.push('available=?'); args.push(b.available ? 1 : 0); }
  if (typeof b.name === 'string' && b.name.trim()) { sets.push('name=?'); args.push(b.name.trim()); }
  if (sets.length) {
    args.push(id);
    db.prepare(`UPDATE ad_slots SET ${sets.join(', ')} WHERE id=?`).run(...args);
  }
  json(res, 200, { ok: true });
});

// ============ 广告主面板 ============
post('/api/ads/impression', (req, res) => {
  // 首页加载时以 cookies 记录已展示的广告 id，避免同一会话重复计入
  const ads = db.prepare(
    `SELECT a.id, a.position FROM ads a
     WHERE a.status = 'running' AND a.spent < a.budget`
  ).all();
  const seen = ((req.headers.cookie || '').match(/seen_ads=([^;]+)/) || [])[1] || '';
  const seenSet = new Set(seen.split(',').filter(Boolean));
  try { db.exec('BEGIN'); } catch {}
  for (const ad of ads) {
    if (!seenSet.has(String(ad.id))) {
      db.prepare('UPDATE ads SET impressions = impressions + 1 WHERE id = ?').run(ad.id);
      seenSet.add(String(ad.id));
    }
  }
  try { db.exec('COMMIT'); } catch {}
  res.setHeader('Set-Cookie', `seen_ads=${[...seenSet].join(',')}; Path=/; Max-Age=3600; SameSite=Lax`);
  json(res, 200, { ok: true });
});

post('/api/ads/click', async (req, res) => {
  const b = await readBody(req);
  const url = new URL(req.url, 'http://x');
  const id = Number(url.searchParams.get('id'));
  if (!Number.isInteger(id)) return json(res, 400, { error: '参数错误' });
  const ad = db.prepare('SELECT * FROM ads WHERE id=?').get(id);
  if (!ad || ad.status !== 'running') return json(res, 200, { link_url: '/', error: '广告不可用' });
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE ads SET clicks = clicks + 1, spent = MIN(spent + cpc, budget) WHERE id = ?').run(id);
    const after = db.prepare('SELECT * FROM ads WHERE id=?').get(id);
    if (after.spent >= after.budget) {
      db.prepare("UPDATE ads SET status='exhausted' WHERE id=?").run(id);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const owner = db.prepare('SELECT * FROM users WHERE id=?').get(ad.user_id);
  // 广告主账户入账点击收入
  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(ad.cpc, ad.user_id);
  json(res, 200, { ok: true, link_url: ad.link_url });
});

post('/api/ads', async (req, res) => {
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: '请先登录' });
  const b = await readBody(req);
  const title = (b.title || '').trim();
  const link_url = (b.link_url || '').trim();
  const image_url = (b.image_url || '').trim();
  const position = (b.position === 'banner' ? 'banner' : 'sidebar');
  const budget = Math.max(0, Number(b.budget) || 0);
  const cpc = Math.max(0.1, Number(b.cpc) || 0.5);
  if (!title || title.length > 40) return json(res, 400, { error: '广告标题不能为空且不超过 40 字' });
  if (!/^https?:\/\//.test(link_url)) return json(res, 400, { error: '请填写正确的链接（http/https）' });
  if (budget < 10) return json(res, 400, { error: '预算至少 10 元' });
  // 扣广告主余额作为充值到广告账户
  if (user.balance < budget) return json(res, 402, { error: '余额不足，请先充值', need: budget - user.balance });
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(budget, user.id);
    const r = db.prepare(
      'INSERT INTO ads (user_id, title, image_url, link_url, position, budget, cpc, status) VALUES (?,?,?,?,?,?,?,?)'
    ).run(user.id, title, image_url, link_url, position, budget, cpc, 'pending');
    db.prepare('INSERT INTO orders (user_id, type, item, amount) VALUES (?,?,?,?)')
      .run(user.id, 'ad_recharge', `广告投放《${title}》预算`, budget);
    db.exec('COMMIT');
    json(res, 200, { ok: true, id: r.lastInsertRowid });
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});

get('/api/ads/my', (req, res) => {
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: '请先登录' });
  const ads = db.prepare('SELECT * FROM ads WHERE user_id=? ORDER BY created_at DESC').all(user.id);
  const spent = ads.reduce((s, a) => s + a.spent, 0);
  json(res, 200, { ads, spent, impressions: ads.reduce((s, a) => s + a.impressions, 0), clicks: ads.reduce((s, a) => s + a.clicks, 0) });
});

get('/api/ads/serve', (req, res) => {
  const url = new URL(req.url, 'http://x');
  const position = url.searchParams.get('position') === 'banner' ? 'banner' : 'sidebar';
  const user = currentUser(req);
  // 高级会员（gold）免广告
  if (user && user.membership === 'gold') return json(res, 200, { ad: null });
  json(res, 200, { ad: serveAd(position, user ? user.id : null) });
});

// ============ 管理 ============
get('/api/admin/stats', (req, res) => {
  const stats = {
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    posts: db.prepare('SELECT COUNT(*) c FROM posts').get().c,
    replies: db.prepare('SELECT COUNT(*) c FROM replies').get().c,
    ads: db.prepare("SELECT COUNT(*) c FROM ads").get().c,
    ordersRevenue: db.prepare("SELECT COALESCE(SUM(amount),0) s FROM orders WHERE status='paid'").get().s,
    adSpent: db.prepare('SELECT COALESCE(SUM(spent),0) s FROM ads').get().s,
  };
  const pendingAds = db.prepare("SELECT COUNT(*) c FROM ads WHERE status='pending'").get().c;
  json(res, 200, { ...stats, pendingAds });
});

get('/api/admin/ads', (req, res) => {
  const ads = db.prepare(
    `SELECT a.*, u.username AS owner FROM ads a JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC`
  ).all();
  json(res, 200, { ads });
});

post('/api/admin/ads/:id/status', async (req, res) => {
  const b = await readBody(req);
  const status = (b.status || '').toLowerCase();
  if (!['running', 'paused', 'rejected'].includes(status)) return json(res, 400, { error: '状态无效' });
  const id = Number(req.params.id);
  const ad = db.prepare('SELECT * FROM ads WHERE id=?').get(id);
  if (!ad) return json(res, 404, { error: '广告不存在' });
  if (status === 'running' && ad.spent >= ad.budget) {
    return json(res, 400, { error: '预算已耗尽，无法继续投放' });
  }
  db.prepare('UPDATE ads SET status=? WHERE id=?').run(status, id);
  json(res, 200, { ok: true });
});

post('/api/posts/:id/hide', async (req, res) => {
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: '请先登录' });
  if (user.role !== 'admin') return json(res, 403, { error: '仅管理员可操作' });
  const id = Number(req.params.id);
  const post = db.prepare('SELECT id FROM posts WHERE id=?').get(id);
  if (!post) return json(res, 404, { error: '帖子不存在' });
  const p = db.prepare('SELECT status FROM posts WHERE id=?').get(id).status;
  db.prepare("UPDATE posts SET status=? WHERE id=?")
    .run(p === 'hidden' ? 'normal' : 'hidden', id);
  json(res, 200, { ok: true });
});

// ============ 静态文件 ============
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------- 请求入口 ----------
const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];
  const method = req.method;

  // 遍历路由
  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    const params = match(pattern, urlPath);
    if (params) {
      req.params = params;
      // admin 校验
      if (urlPath.startsWith('/api/admin/')) {
        const u = currentUser(req);
        if (!u) { json(res, 401, { error: '请先登录' }); return; }
        if (u.role !== 'admin') { json(res, 403, { error: '仅管理员可操作' }); return; }
      }
      try {
        await handler(req, res);
      } catch (e) {
        console.error('[err]', e);
        const code = e.code === 413 || e.code === 400 || e.code === 429 ? e.code : 500;
        const msg = code === 413 ? '请求体过大' : (code === 400 ? '请求数据格式错误' : (code === 429 ? '操作过于频繁' : '服务器内部错误'));
        if (!res.headersSent && !res.destroyed) json(res, code, { error: msg });
      }
      return;
    }
  }

  // 静态资源
  if (method === 'GET' && !urlPath.startsWith('/api/')) {
    return serveStatic(req, res);
  }

  json(res, 404, { error: '接口不存在' });
});

server.listen(PORT, () => {
  console.log(`[forum] 服务运行中： http://localhost:${PORT}`);
});

// ---------- 全局异常兜底 + 优雅关闭 ----------
// 避免单个异步错误导致进程退出；收到停机信号时先关服务再关库
process.on('uncaughtException', (e) => {
  console.error('[fatal] uncaughtException:', e);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
});

function shutdown(signal) {
  console.log(`[forum] 收到 ${signal}，正在优雅关闭…`);
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));