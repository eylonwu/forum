// db.js — SQLite 数据库初始化与种子数据（使用 Node 内置 node:sqlite）
'use strict';
const { DatabaseSync } = require('node:sqlite');
const { scryptSync, randomBytes } = require('node:crypto');
const path = require('node:path');

const DB_PATH = path.join(__dirname, 'forum.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',           -- user | admin
  avatar TEXT DEFAULT '',                       -- 头像（emoji/图片，空则用首字母）
  bio TEXT DEFAULT '',
  balance REAL NOT NULL DEFAULT 0,              -- 账户余额（元）
  membership TEXT NOT NULL DEFAULT 'none',      -- none | bronze | silver | gold
  membership_expires TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT DEFAULT '',
  color TEXT NOT NULL DEFAULT '#b03a2e',
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  category_id INTEGER NOT NULL REFERENCES categories(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  price REAL NOT NULL DEFAULT 0,                -- 0=免费；>0 付费可见
  status TEXT NOT NULL DEFAULT 'normal',        -- normal | hidden（管理员隐藏）
  views INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS likes (
  user_id INTEGER NOT NULL REFERENCES users(id),
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,                           -- recharge | membership | post | ad_recharge
  item TEXT NOT NULL,                           -- 描述
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'paid',          -- paid | refunded
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS purchases (
  user_id INTEGER NOT NULL REFERENCES users(id),
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS ads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  image_url TEXT DEFAULT '',
  link_url TEXT NOT NULL,
  position TEXT NOT NULL DEFAULT 'sidebar',     -- banner | sidebar
  budget REAL NOT NULL,                         -- 总预算（元）
  spent REAL NOT NULL DEFAULT 0,
  cpc REAL NOT NULL DEFAULT 0.5,                -- 单次点击成本
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | running | paused | rejected | exhausted
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 支付订单（双通道：Stripe 美元 + 支付宝/微信人民币）
CREATE TABLE IF NOT EXISTS pay_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  order_no TEXT UNIQUE NOT NULL,                -- 平台订单号
  type TEXT NOT NULL,                           -- recharge|membership|post|ad|ad_slot
  item TEXT NOT NULL,                           -- 描述（含商品快照，如会员等级、广告位名）
  amount_cny REAL NOT NULL,                     -- 人民币金额（本站基准货币）
  amount_usd REAL NOT NULL DEFAULT 0,           -- 美元金额（Stripe 通道）
  currency TEXT NOT NULL DEFAULT 'CNY',         -- CN1=人民币 CNY / USD
  channel TEXT NOT NULL,                        -- stripe|alipay|wechat|sandbox
  provider_order TEXT DEFAULT '',               -- 第三方支付系统订单号
  status TEXT NOT NULL DEFAULT 'created',       -- created|pending|paid|failed|cancelled
  meta TEXT DEFAULT '{}',                       -- 商品快照 JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  paid_at TEXT DEFAULT NULL
);

-- 可售广告位库存（站长设置出售的广告位套餐）
CREATE TABLE IF NOT EXISTS ad_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position TEXT NOT NULL DEFAULT 'sidebar',     -- banner|sidebar
  name TEXT NOT NULL,                           -- 套餐名：如"首页侧栏周卡"
  description TEXT DEFAULT '',
  price REAL NOT NULL,                          -- 售价（元/期）
  duration_days INTEGER NOT NULL DEFAULT 7,     -- 购买后权益时长（天）
  available INTEGER NOT NULL DEFAULT 1,         -- 1=在售 0=停售
  sold INTEGER NOT NULL DEFAULT 0,              -- 累计售出份数
  sort INTEGER NOT NULL DEFAULT 0
);

-- 广告位购买记录
CREATE TABLE IF NOT EXISTS slot_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  slot_id INTEGER NOT NULL REFERENCES ad_slots(id),
  amount REAL NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 页面浏览埋点（用于站长查看用户日活）
CREATE TABLE IF NOT EXISTS page_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,                              -- 未登录为 NULL
  session_id TEXT,                              -- 匿名访问标识
  page TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

// —— 工具函数 ——
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash: salt + ':' + hash };
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const calc = scryptSync(String(password), salt, 32).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(calc, 'hex');
  return a.length === b.length && a.equals(b);
}

function seedUser(username, email, password, role = 'user', extra = {}) {
  const { hash } = hashPassword(password);
  db.prepare(
    'INSERT INTO users (username, email, password_hash, role, balance, membership, bio, avatar) VALUES (?,?,?,?,?,?,?,?)'
  ).run(username, email, hash, role, extra.balance ?? 0, extra.membership ?? 'none', extra.bio ?? '', extra.avatar ?? '');
  return db.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
}

// —— 种子数据（仅当空库时执行）——
const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
if (userCount === 0) {
  seedUser('admin', 'admin@forum.local', 'admin123', 'admin', {
    bio: '论坛管理员，维护社区秩序与广告审核。',
    avatar: '🛡️',
  });

  const idDemo = seedUser('墨语', 'moyu@forum.local', '123456', 'user', {
    balance: 188,
    membership: 'silver',
    bio: '写代码的人，也写生活。',
    avatar: '🦉',
  });
  const idLin = seedUser('林间风', 'linfeng@forum.local', '123456', 'user', {
    bio: '产品设计师，喜欢安静地讨论问题。',
    avatar: '🌿',
  });
  const idKe = seedUser('柯北', 'kebei@forum.local', '123456', 'user', {
    bio: '独立开发者，正在做一件小事情。',
    avatar: '🐳',
  });
  const idAd = seedUser('好味食品', 'hao@advertiser.local', '123456', 'user', {
    bio: '广告主账号',
    avatar: '🍜',
  });

  const cats = [
    ['综合讨论', 'general', '天南海北，什么都可以聊', '#b03a2e'],
    ['技术分享', 'tech', '编程、架构与工具心得', '#0f766e'],
    ['生活随记', 'life', '记录日常，交换生活切片', '#b45309'],
    ['灌水区', 'water', '轻松灌水，友好闲聊', '#6d28d9'],
    ['站务反馈', 'feedback', '对论坛的建议与问题', '#334155'],
  ];
  const insCat = db.prepare('INSERT INTO categories (name, slug, description, color, sort) VALUES (?,?,?,?,?)');
  cats.forEach((c, i) => insCat.run(...c, i + 1));
  const cat = (slug) => db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug).id;

  const insPost = db.prepare(
    'INSERT INTO posts (user_id, category_id, title, content, price, views) VALUES (?,?,?,?,?,?)'
  );
  const p1 = insPost.run(idDemo, cat('tech'), '用 Node 内置 SQLite 做全栈应用，零依赖也能跑得很舒服',
    '最近做小项目时彻底放弃了 ORM 和编译型依赖，直接用 node:sqlite 配 node:http。\n\n优点：启动快、无 node_modules、部署简单。\n\n以下是几个关键点：\n1. DatabaseSync 是同步 API，小流量完全够用；\n2. WAL 模式并发读很舒服；\n3. 用 PREPARE + 参数绑定避免注入。\n\n欢迎讨论你最喜欢的"零依赖"姿势。', 0, 342);
  const p2 = insPost.run(idLin, cat('life'), '秋天到了，分享我手机里最好看的五张照片',
    '最近降温明显，梧桐叶落了满地。随手拍了一些，最喜欢的是傍晚路灯下的那一组。\n\n大家最近有拍到什么好看的瞬间吗？附上你的城市吧。', 0, 156);
  const p3 = insPost.run(idKe, cat('general'), '【付费帖】独立开发者第一年的血泪账本',
    '先说结论：第一年净收入 -¥12,000，但换来了 40 个稳定用户和一个能跑的产品。\n\n=== 付费内容 ===\n这一年踩过的坑：\n1. 过早招人，团队沟通成本远大于产出；\n2. 功能优先级拍脑袋决定，三次返工；\n3. 唯一做对的事：坚持每周发一篇产品周报。\n\n完整表格数据请解锁后查看（仅需 ¥6）。', 6, 89);
  const p4 = insPost.run(idDemo, cat('water'), '新人报到，第一次发帖有点紧张',
    '大家好，刚注册，希望在这个社区交到朋友。平时喜欢折腾路由器。', 0, 45);
  const p5 = insPost.run(idKe, cat('feedback'), '建议：加一个"只看楼主"功能',
    '长贴回复太多的时候容易找不到楼主观点，建议加一个只看楼主过滤。\n\n如果同意请点赞，让管理员看到～', 0, 78);

  // 管理员发个公告
  insPost.run(
    db.prepare('SELECT id FROM users WHERE username = ?').get('admin').id,
    cat('general'),
    '【置顶】社区守则：友好讨论，拒绝攻击',
    '欢迎来到本社区。\n\n几条简单的约定：\n1. 讨论对事不对人；\n2. 尊重不同立场，禁止人身攻击；\n3. 广告投放请通过"广告主面板"提交，审核通过后展示；\n4. 会员与付费帖收入用于维持服务器。\n\n管理员团队致上。', 0, 512);

  // 一些回复
  const insReply = db.prepare('INSERT INTO replies (post_id, user_id, content) VALUES (?,?,?)');
  insReply.run(p1.lastInsertRowid, idKe, '学到了，最近正想把一个小工具迁移到零依赖方案。请问静态资源也是手动 serve 吗？');
  insReply.run(p1.lastInsertRowid, idDemo, '对，写了个几十行的静态文件函数，mime 映射维护一下就行。');
  insReply.run(p3.lastInsertRowid, idDemo, '已解锁支持～ 账本写得真实，独立开发者都不容易。');
  insReply.run(p5.lastInsertRowid, idLin, '+1，长帖确实需要这个功能。');
  insReply.run(p2.lastInsertRowid, idDemo, '照片在路灯光下的感觉真好，像电影截图。');

  // 演示用广告
  const imgNoodle = 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=' +
    encodeURIComponent('warm product photo of a handmade noodle gift box, rice paper texture, dried noodles, autumn theme, soft natural light, e-commerce banner style') +
    '&image_size=landscape_4_3';
  const imgCoffee = 'https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=' +
    encodeURIComponent('a cup of pour-over coffee on a wooden desk by the window, morning light, cozy cafe atmosphere, photorealistic') +
    '&image_size=square';
  const insAd = db.prepare(
    'INSERT INTO ads (user_id, title, image_url, link_url, position, budget, cpc, status, impressions) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  insAd.run(idAd, '秋日咖啡豆 · 手冲体验装', imgCoffee, 'https://example.com/ads/coffee',
    'sidebar', 100, 0.5, 'running', 36);
  insAd.run(idAd, '秋季新品 · 手工面条礼盒', imgNoodle, 'https://example.com/ads/noodle',
    'banner', 100, 0.5, 'running', 0);

  console.log('[seed] 已初始化演示数据：admin/admin123，普通用户 123456');
}

// —— 可售广告位库存种子（仅当库存为空时执行，避免每次启动重复插入）——
if (db.prepare('SELECT COUNT(*) AS c FROM ad_slots').get().c === 0) {
  const insSlot = db.prepare(
    `INSERT INTO ad_slots (position, name, description, price, duration_days, available, sold, sort)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  insSlot.run('banner', '首页顶部横幅 · 周卡', '整周占据首页顶部横幅位，展示约 30000+ PV。', 98, 7, 1, 0, 1);
  insSlot.run('banner', '首页顶部横幅 · 月卡', '整月占据首页顶部横幅位，性价比之选。', 328, 30, 1, 0, 2);
  insSlot.run('sidebar', '首页侧栏 · 周卡', '首页侧栏赞助位，周卡与内容同屏、持续曝光。', 68, 7, 1, 0, 3);
  insSlot.run('sidebar', '首页侧栏 · 月卡', '整月侧栏赞助位，适合品牌长期露出。', 228, 30, 1, 0, 4);
  console.log('[seed] 已初始化可售广告位库存');
}

module.exports = { db, hashPassword, verifyPassword };
