/* =========================================================
   拾光集 · 前端应用（SPA，零框架）
   ========================================================= */
'use strict';

const $app = document.getElementById('app');
const $headerAuth = document.getElementById('header-auth');

const state = {
  user: null,
  categories: [{ id: 0, name: '全部分类', slug: 'all', color: '#334155' }],
};

// ---------- 工具 ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

function fmtRel(t) {
  if (!t) return '';
  const diff = Date.now() - new Date(t).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(t).toLocaleDateString('zh-CN');
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data.error || '请求失败');
    err.status = res.status;
    err.need = data.need;
    throw err;
  }
  return data;
}

function toast(msg, type = '') {
  const root = document.getElementById('toast-root');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  root.appendChild(t);
  setTimeout(() => { t.remove(); }, 2600);
}

function openModal(html) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-overlay" data-close><div class="modal" data-stop>${html}</div></div>`;
  root.querySelector('[data-close]').addEventListener('click', (e) => {
    if (e.target.closest('[data-stop]') && e.target !== root.querySelector('[data-close]')) return;
    if (!e.target.closest('[data-stop]')) { root.innerHTML = ''; }
  });
  root.querySelectorAll('[data-close-modal]').forEach((b) =>
    b.addEventListener('click', () => { root.innerHTML = ''; }));
  const stop = root.querySelector('[data-stop]');
  stop.addEventListener('click', (e) => e.stopPropagation());
}

function closeModal() { document.getElementById('modal-root').innerHTML = ''; }

// ---------- 头像 ----------
function avatarHTML(u, cls = '') {
  const initial = (u.avatar ? '' : esc((u.username || '?').slice(0, 1)));
  return `<span class="avatar ${cls}">${u.avatar ? esc(u.avatar) : `<span class="avatar-text">${initial}</span>`}</span>`;
}
function memberTag(m) {
  if (!m || m === 'none') return '';
  const names = { bronze: '青铜', silver: '白银', gold: '黄金' };
  return `<span class="member-tag ${m}">${names[m]}</span>`;
}

// ---------- API：想立即用的 ----------
async function refreshMe() {
  try {
    const d = await api('/api/me');
    state.user = d.user;
  } catch { state.user = null; }
  renderHeader();
}

// ---------- 顶部导航登录态 ----------
function renderHeader() {
  const u = state.user;
  if (u) {
    const isAdmin = u.role === 'admin';
    $headerAuth.innerHTML = `
      <button class="btn btn-outline btn-sm" onclick="location.hash='#/account'">💰 我的账户</button>
      <div class="header-user" onclick="location.hash='#/account'">
        ${avatarHTML(u)} <span>${memberTag(u.membership)} ${esc(u.username)}</span>
      </div>
      <button class="btn-ghost-header" onclick="App.logout()">退出</button>`;
    document.getElementById('admin-nav').classList.toggle('hidden', !isAdmin);
  } else {
    $headerAuth.innerHTML = `
      <button class="btn-ghost-header" onclick="App.showAuth('login')">登录</button>
      <button class="btn btn-primary btn-sm" onclick="App.showAuth('register')">注册</button>`;
    document.getElementById('admin-nav').classList.add('hidden');
  }
}

// ---------- 广告 ----------
async function trackImpression() { try { await api('/api/ads/impression', { method: 'POST', body: '{}' }); } catch {} }

function bannerAdHTML(ad) {
  if (!ad) return '';
  return `<div class="banner-ad">
    <img src="${esc(ad.image_url)}" alt="${esc(ad.title)}" />
    <div class="ad-body">
      <a class="ad-title" href="#" data-ad-click="${ad.id}" target="_blank" rel="noopener">${esc(ad.title)}</a>
      <span class="ad-tag">广告</span>
    </div>
  </div>`;
}
function sidebarAdHTML(ad) {
  if (!ad) return '';
  return ` <div class="side-card-title">··· 赞助 ···</div>
    <div class="sidebar-ad">
      <img src="${esc(ad.image_url)}" alt="${esc(ad.title)}" />
      <div class="side-ad-body">
        <div class="side-ad-title"><a href="#" data-ad-click="${ad.id}" target="_blank" rel="noopener">${esc(ad.title)}</a></div>
        <div class="side-ad-link">点击访问赞助商</div>
      </div>
    </div>`;
}

function onAdClicks(root) {
  root.querySelectorAll('[data-ad-click]').forEach(async (a) => {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        const d = await api(`/api/ads/click?id=${a.dataset.adClick}`, { method: 'POST', body: '{}' });
        if (d.link_url) window.open(d.link_url, '_blank', 'noopener');
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

// =========================================================
// 支付（双通道：Stripe 美元 + 支付宝/微信人民币；沙箱即点即到账）
// =========================================================
// intent: { type, amount?, tier?, post_id?, slot_id?,
//           title?, link_url?, image_url?, position?, budget?, cpc? }
let currentPayIntent = null;
let currentPayChannels = null;
let currentPayRate = 7.1;

async function showPayModal(intent) {
  if (!state.user) { toast('请先登录', 'error'); return App.showAuth('login'); }
  if (!currentPayChannels) {
    try {
      const d = await api('/api/pay/my');
      currentPayChannels = d.channels;
      currentPayRate = d.usdRate || 7.1;
    } catch { currentPayChannels = { sandbox: { label: '沙箱（演示）', tag: '即点即到账', on: true } }; }
  }
  currentPayIntent = intent;
  const list = Object.entries(currentPayChannels).filter(([, c]) => c.on);
  const desc = payIntentDesc(intent);
  openModal(`
    <div class="modal-pad">
      <button class="modal-close" data-close-modal>&times;</button>
      <h2 class="form-title">收银台</h2>
      <p class="form-sub">${desc.label} · ¥${desc.amount}${desc.usd ? ` ≈ $${desc.usd}` : ''}</p>
      <div class="pay-channels">
        ${list.map(([key, c], i) => `
          <label class="pay-channel ${i === 0 ? 'sel' : ''}" data-pay-channel="${key}">
            <input type="radio" name="pay-channel" value="${key}" ${i === 0 ? 'checked' : ''} />
            <span class="pay-channel-name">${esc(c.label)}</span>
            <span class="pay-channel-tag">${esc(c.tag)}</span>
          </label>`).join('')}
      </div>
      <button class="btn btn-primary btn-block" id="pay-confirm" style="margin-top:14px">确认支付 ¥${desc.amount}</button>
    </div>`);
  const root = document.getElementById('modal-root');
  root.querySelectorAll('[data-pay-channel]').forEach((l) =>
    l.addEventListener('click', () => {
      root.querySelectorAll('[data-pay-channel]').forEach((x) => x.classList.remove('sel'));
      l.classList.add('sel'); l.querySelector('input').checked = true;
    }));
  document.getElementById('pay-confirm').addEventListener('click', async () => {
    const channel = root.querySelector('input[name="pay-channel"]:checked').value;
    const btn = document.getElementById('pay-confirm');
    btn.disabled = true; btn.textContent = '处理中…';
    try {
      const body = { ...currentPayIntent, channel };
      const r = await api('/api/pay/create', { method: 'POST', body: JSON.stringify(body) });
      await refreshMe();
      closeModal();
      if (r.sandbox) {
        toast('支付成功 ✨（沙箱）');
        loc_after(currentPayIntent.onAfter);
      } else if (r.provider && r.provider.url) {
        // 跳转 Stripe 托管收银台，支付完成回跳 #/pay-result 轮询到账
        window.location.href = r.provider.url;
      } else {
        toast('订单已创建，等待支付');
        location.hash = `#/pay-result?order=${r.order.order_no}`;
      }
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; btn.textContent = '确认支付'; }
  });
}
function payIntentDesc(intent) {
  const byType = {
    recharge: intent.amount,
    membership: { bronze: 18, silver: 38, gold: 88 }[intent.tier],
    post: intent.amount,
    ad: intent.budget,
    ad_slot: intent.amount,
  };
  const amount = Number(byType[intent.type]) || 0;
  const usd = Math.round((amount / (currentPayRate || 7.1)) * 100) / 100;
  const labels = { recharge: '充值', membership: '开通会员', post: '解锁付费帖', ad: '广告投放', ad_slot: '购买广告位' };
  return { label: labels[intent.type] || '支付', amount, usd };
}
function loc_after(cb) {
  if (typeof cb === 'function') {
    try { cb(); } catch {}
  } else if (cb === 'refreshAccount') {
    if (location.hash.includes('/account')) App.account(); else location.hash = '#/account';
  } else if (cb === 'refreshAdvertise') {
    App.advertise();
  } else if (cb === 'refreshAdSlots') {
    App.adSlots();
  } else if (typeof cb === 'string') {
    location.hash = cb;
  }
}

// =========================================================
// 页面视图
// =========================================================
const App = {};

App.showAuth = function (mode) {
  if (state.user) return;
  const loginView = `
    <div class="modal-pad">
      <button class="modal-close" data-close-modal>&times;</button>
      <h2 class="form-title">欢迎回来</h2>
      <p class="form-sub">登录后即可发帖、评论与解锁付费内容</p>
      <form id="auth-form" data-mode="login">
        <div class="field"><label>账号 / 邮箱</label><input class="input" name="account" autocomplete="username" required /></div>
        <div class="field"><label>密码</label><input class="input" type="password" name="password" autocomplete="current-password" required /></div>
        <button class="btn btn-primary btn-block" type="submit">登录</button>
        <p class="hint" style="text-align:center;margin-top:12px">还没有账号？<a href="#" data-switch="register">去注册</a></p>
      </form>
    </div>`;
  const registerView = `
    <div class="modal-pad">
      <button class="modal-close" data-close-modal>&times;</button>
      <h2 class="form-title">加入拾光集</h2>
      <p class="form-sub">公开注册，友好讨论</p>
      <form id="auth-form" data-mode="register">
        <div class="field"><label>用户名</label><input class="input" name="username" maxlength="20" required /></div>
        <div class="field"><label>邮箱</label><input class="input" type="email" name="email" required /></div>
        <div class="field"><label>密码（至少 6 位）</label><input class="input" type="password" name="password" minlength="6" required /></div>
        <button class="btn btn-primary btn-block" type="submit">注册并登录</button>
        <p class="hint" style="text-align:center;margin-top:12px">已有账号？<a href="#" data-switch="login">去登录</a></p>
      </form>
    </div>`;

  openModal(mode === 'login' ? loginView : registerView);
  const root = document.getElementById('modal-root');
  root.querySelectorAll('[data-switch]').forEach((s) =>
    s.addEventListener('click', (e) => { e.preventDefault(); const m = s.dataset.switch; closeModal(); App.showAuth(m); }));
  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const fd = new FormData(f);
    const body = Object.fromEntries(fd.entries());
    const btn = f.querySelector('button');
    btn.disabled = true;
    try {
      if (f.dataset.mode === 'login') {
        await api('/api/login', { method: 'POST', body: JSON.stringify(body) });
      } else {
        await api('/api/register', { method: 'POST', body: JSON.stringify(body) });
      }
      closeModal();
      await refreshMe();
      toast('登录成功 ✨');
      location.hash = '#/';
    } catch (err) { toast(err.message, 'error'); }
    btn.disabled = false;
  });
};

App.logout = async function () {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch {}
  state.user = null;
  renderHeader();
  location.hash = '#/';
};

// ---------- 首页 ----------
App.home = async function () {
  await refreshCategories();
  const hashBody = window.location.hash.slice(1); // 形如 "/?cat=tech"
  const qIdx = hashBody.indexOf('?');
  const params = new URLSearchParams(qIdx === -1 ? '' : hashBody.slice(qIdx + 1));
  const slug = params.get('cat') || 'all';
  const q = params.get('q') || '';

  const [postData, sidebarAd, bannerAd] = await Promise.all([
    api(`/api/posts?category=${encodeURIComponent(slug)}&q=${encodeURIComponent(q)}`),
    api('/api/ads/serve?position=sidebar'),
    api('/api/ads/serve?position=banner'),
  ]);
  trackImpression();

  const catBar = state.categories.map((c) =>
    `<button class="cat-chip ${c.slug === slug ? 'active' : ''}" data-cat="${c.slug}">${esc(c.name)}</button>`).join('');

  const posts = postData.posts.length
    ? postData.posts.map(postCardHTML).join('')
    : `<div class="empty"><div class="empty-emoji">🍃</div>这里还很安静，发个帖子吧</div>`;

  const sidebarExtra = state.user
    ? walletSidebar(state.user)
    : `<div class="card login-cta"><p>登录后发帖、评论、解锁付费内容</p>
        <button class="btn btn-primary" onclick="App.showAuth('login')">登录 / 注册</button></div>`;

  $app.innerHTML = `
    <div class="grid-home">
      <div>
        ${bannerAdHTML(bannerAd.ad)}
        <div class="toolbar">
          <div class="search-box"><input class="input" id="search-input" placeholder="搜索帖子、作者…" value="${esc(q)}" /></div>
          <button class="btn btn-teal" id="go-new">＋ 发帖</button>
        </div>
        <div class="cat-bar">${catBar}</div>
        <div class="post-list">${posts}</div>
      </div>
      <aside class="sidebar-col">
        ${sidebarExtra}
        ${sidebarAd.ad ? `<div class="card card-pad">${sidebarAdHTML(sidebarAd.ad)}</div>` : ''}
      </aside>
    </div>`;

  $app.querySelectorAll('[data-cat]').forEach((b) =>
    b.addEventListener('click', () => { location.hash = '#/?cat=' + b.dataset.cat; }));
  document.getElementById('go-new').addEventListener('click', () => { location.hash = '#/new'; });
  document.getElementById('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const v = e.target.value.trim();
      location.hash = v ? `#/?q=${encodeURIComponent(v)}` : '#/';
    }
  });
  onAdClicks($app);
  // 分类视图同步为 SEO 友好路径 /c/:slug（搜索时保留 /?q=）
  if (!q) syncPath(slug === 'all' ? '/' : '/c/' + slug);
};

function postCardHTML(p) {
  const priceBadge = p.price > 0
    ? `<span class="badge-price ${p.unlocked ? 'your' : ''}">${p.price > 0 && !p.unlocked ? '🔒' : '已购/'}¥${p.price}</span>`
    : '';
  const memberTagHtml = memberTag(p.author_membership);
  return `<article class="card post-item">
    <div class="post-top">
      ${avatarHTML({ avatar: p.author_avatar, username: p.author })}
      <div style="flex:1">
        <h3 class="post-title"><a href="#/post/${p.id}">${esc(p.title)}</a></h3>
        <div class="post-meta">
          <span class="badge-cat" style="background:${esc(p.category_color)}">${esc(p.category)}</span>
          ${priceBadge}
          <span>${esc(p.author)} ${memberTagHtml}</span>
          <span>👁 ${p.views}</span>
          <span>💬 ${p.reply_count}</span>
          <span>👍 ${p.like_count}</span>
          <span>${fmtRel(p.created_at)}</span>
        </div>
      </div>
    </div>
  </article>`;
}

// ---------- 帖子详情 ----------
App.post = async function (id) {
  await refreshCategories();
  let d;
  try {
    d = await api(`/api/posts/${id}`);
  } catch (err) {
    $app.innerHTML = `<div class="empty"><div class="empty-emoji">🫥</div>${esc(err.message)}</div>`;
    return;
  }
  const p = d.post;
  const unlocked = p.unlocked;

  // 用更可信的详情接口刷新会员标签
  const authorTag = memberTag(p.author_membership);

  const unlockBox = !unlocked && p.price > 0 && state.user && !d.isAuthor
    ? `<div class="unlock-box">
        <div class="unlock-price">¥${p.price}</div>
        <div class="unlock-desc">解锁后查看完整内容，支持独立开发者</div>
        <button class="btn btn-primary btn-sm" id="unlock-btn">立即解锁</button>
      </div>`
    : '';

  const paywallNote = (unlocked || p.price === 0)
    ? ''
    : (d.isAuthor ? '<p class="hint">这是你的付费帖</p>' : '<p class="unlock-desc">付费内容（预览）</p>');

  const replies = d.replies.length
    ? d.replies.map((r) => `
        <div class="reply-item">
          ${avatarHTML({ avatar: r.avatar, username: r.username })}
          <div style="flex:1">
            <div class="reply-meta"><strong>${esc(r.username)}</strong> ${memberTag(r.membership)} <span>${fmtRel(r.created_at)}</span></div>
            <div class="reply-content">${esc(r.content)}</div>
          </div>
        </div>`).join('')
    : `<div class="empty" style="padding:30px"><div class="empty-emoji">💬</div>还没有评论，来抢沙发</div>`;

  const replyForm = state.user
    ? `<div class="card card-pad" style="margin-top:16px">
        <textarea class="textarea" id="reply-input" placeholder="友好地表达你的看法…"></textarea>
        <div style="margin-top:10px;text-align:right"><button class="btn btn-primary btn-sm" id="reply-btn">发表评论</button></div>
      </div>`
    : `<div class="card card-pad" style="margin-top:16px;text-align:center;">
        <button class="btn btn-teal" onclick="App.showAuth('login')">登录后可评论</button>
      </div>`;

  $app.innerHTML = `
    <div class="card detail-head">
      <div class="post-meta" style="margin-top:0">
        <span class="badge-cat" style="background:${esc(p.category_color)}">${esc(p.category)}</span>
        ${p.price > 0 ? `<span class="badge-price ${unlocked ? 'your' : ''}">${unlocked ? '已解锁' : '付费'} ¥${p.price}</span>` : ''}
        <span>👁 ${p.views}</span><span>创建于 ${fmtRel(p.created_at)}</span>
      </div>
      <h1 class="detail-title">${esc(p.title)}</h1>
      <div class="post-meta" style="margin-top:6px">
        <span>作者 ${esc(p.author)} ${authorTag}</span>
      </div>
      <div class="detail-content ${unlocked ? '' : 'paywall'}" style="margin-top:16px">${esc(p.content)}${paywallNote}</div>
      <div class="detail-actions">
        <button class="btn ${d.liked ? 'btn-primary' : 'btn-outline'}" id="like-btn">${d.liked ? '已赞 👍' : '点赞 👍'} ${p.like_count}</button>
        ${d.isAuthor && p.price > 0 ? `<span class="hint">你的付费帖，收入已入账订单</span>` : ''}
      </div>
      ${unlockBox}
      ${renderBreadcrumb()}
    </div>
    <div class="replies">
      <div class="section-title" style="margin-top:8px">评论（${d.replies.length}）</div>
      ${replies}
      ${replyForm}
    </div>`;

  document.getElementById('like-btn').addEventListener('click', async (e) => {
    if (!state.user) { toast('请先登录', 'error'); return App.showAuth('login'); }
    e.target.disabled = true;
    try {
      const r = await api(`/api/posts/${id}/like`, { method: 'POST', body: '{}' });
      App.post(id);
    } catch (err) { toast(err.message, 'error'); e.target.disabled = false; }
  });
  const replyBtn = document.getElementById('reply-btn');
  if (replyBtn) replyBtn.addEventListener('click', async () => {
    const v = document.getElementById('reply-input').value.trim();
    if (!v) return toast('评论不能为空', 'error');
    try { await api(`/api/posts/${id}/reply`, { method: 'POST', body: JSON.stringify({ content: v }) }); App.post(id); }
    catch (err) { toast(err.message, 'error'); }
  });
  const unlockBtn = document.getElementById('unlock-btn');
  if (unlockBtn) unlockBtn.addEventListener('click', async () => {
    try {
      const r = await api(`/api/posts/${id}/unlock`, { method: 'POST', body: '{}' });
      await refreshMe();
      toast('解锁成功 ✨');
      App.post(id);
    } catch (err) {
      toast(err.message, 'error');
      if (err.status === 402) setTimeout(() => App.showCharge(), 300);
    }
  });
  onAdClicks($app);
};

function renderBreadcrumb() {
  return `<div style="margin-top:14px"><a href="#/">← 返回广场</a></div>`;
}

// ---------- 发帖 ----------
App.newPost = async function () {
  await refreshCategories();
  const catOptions = state.categories.filter((c) => c.id !== 0)
    .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $app.innerHTML = `
    <div class="card-pad card">
      <h2 class="form-title">发布新帖</h2>
      <p class="form-sub">选一个分类，写点真诚的内容。</p>
      <form id="new-post-form">
        <div class="field"><label>分类</label><select class="input" name="category_id" required>${catOptions}</select></div>
        <div class="field"><label>标题</label><input class="input" name="title" maxlength="80" required placeholder="一句话说清楚主题" /></div>
        <div class="field"><label>内容</label><textarea class="textarea" name="content" required placeholder="展开聊聊…"></textarea></div>
        <div class="field">
          <label>设置付费价格（¥，0=免费）</label>
          <input class="input" type="number" name="price" min="0" max="999" step="0.01" value="0" />
          <p class="hint">设为 >0 时，其他用户需付费解锁完整内容；你自己的帖子始终可见。</p>
        </div>
        <div class="field"><button class="btn btn-primary btn-block" type="submit">发布</button></div>
      </form>
    </div>`;
  document.getElementById('new-post-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.user) { toast('请先登录', 'error'); return App.showAuth('login'); }
    const fd = new FormData(e.target);
    fd.set('category_id', Number(fd.get('category_id')));
    fd.set('price', Number(fd.get('price')));
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const r = await api('/api/posts', { method: 'POST', body: JSON.stringify(Object.fromEntries(fd)) });
      toast('发布成功 🎉');
      location.hash = `#/post/${r.id}`;
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  });
};

// ---------- 我的账户（余额/会员/订单） ----------
App.account = async function () {
  if (!state.user) { toast('请先登录', 'error'); return App.showAuth('login'); }
  let d;
  try { d = await api('/api/account'); } catch (err) { toast(err.message, 'error'); return App.showAuth('login'); }
  const u = d.user;
  const charge = () => App.showCharge();

  const tiers = [
    { key: 'bronze', name: '青铜会员', price: 18, perks: ['金色昵称徽章', '支持社区运营'] },
    { key: 'silver', name: '白银会员', price: 38, perks: ['金色徽章', '优先回复展示'] },
    { key: 'gold', name: '黄金会员', price: 88, perks: ['金色徽章', '专属配色', '免广告'] },
  ].map((t) => {
    const isCurrent = u.membership === t.key;
    return `<div class="tier-card ${t.key === 'gold' ? 'highlight' : ''}">
      ${isCurrent ? '<span class="current-badge">当前</span>' : ''}
      <div class="tier-name">${t.name}</div>
      <div class="tier-price">¥${t.price}<span style="font-size:13px;color:var(--muted)"> / 30天</span></div>
      <ul class="tier-perks">${t.perks.map((p) => `<li>✓ ${p}</li>`).join('')}</ul>
      ${isCurrent ? '' : `<button class="btn btn-sm btn-outline btn-block" style="margin-top:12px" data-buy="${t.key}">开通月卡</button>`}
    </div>`;
  }).join('');

  const orders = d.orders.length
    ? d.orders.map((o) => `
      <tr><td>${fmtRel(o.created_at)}</td><td>${orderTypeName(o.type)}</td><td>${esc(o.item)}</td><td style="color:${o.amount>0?'var(--teal)':'inherit'};font-weight:700">${o.amount>0?'+':''}¥${o.amount}</td></tr>`).join('')
    : `<tr><td colspan="4" class="empty" style="padding:24px">暂无记录</td></tr>`;

  $app.innerHTML = `
    <div class="grid-home">
      <div>
        <div class="profile-head">
          ${avatarHTML(u, '')}
          <div>
            <h2 style="font-family:var(--serif);font-size:22px">${esc(u.username)} ${memberTag(u.membership)}</h2>
            <p class="bio">${esc(u.bio || '这里空空如也。')}</p>
          </div>
        </div>

        <div class="stat-grid">
          <div class="stat-card"><div class="stat-num">¥${u.balance}</div><div class="stat-label">账户余额</div></div>
          <div class="stat-card"><div class="stat-num">${d.purchases.length}</div><div class="stat-label">已购内容</div></div>
          <div class="stat-card"><div class="stat-num">${u.role === 'admin' ? '管理员' : '普通用户'}</div><div class="stat-label">身份</div></div>
        </div>

        <button class="btn btn-primary" onclick="App.showCharge()">积分充值</button>
        <a href="#/advertise" class="btn btn-outline">投放广告</a>

        <h3 class="section-title">开通会员</h3>
        <div class="tier-grid">${tiers}</div>

        <h3 class="section-title">订单记录</h3>
        <div class="card"><div class="table-wrap">
          <table class="table">
            <thead><tr><th>时间</th><th>类型</th><th>说明</th><th>金额</th></tr></thead>
            <tbody>${orders}</tbody>
          </table>
        </div></div>
      </div>
      <aside class="sidebar-col">${walletSidebar(u)}</aside>
    </div>`;

  $app.querySelectorAll('[data-buy]').forEach((b) =>
    b.addEventListener('click', () => {
      showPayModal({ type: 'membership', tier: b.dataset.buy, onAfter: 'refreshAccount' });
    }));
};

function orderTypeName(t) {
  return { recharge: '充值', membership: '会员', post: '解锁内容', ad_recharge: '广告投放', ad_slot: '广告位' }[t] || t;
}

App.showCharge = async function () {
  if (!state.user) { toast('请先登录', 'error'); return App.showAuth('login'); }
  const presets = [10, 20, 50, 100];
  openModal(`
    <div class="modal-pad">
      <button class="modal-close" data-close-modal>&times;</button>
      <h2 class="form-title">充值</h2>
      <p class="form-sub">余额用于解锁付费帖、开通会员、投放广告。支持人民币（支付宝/微信）或美元（Stripe）。</p>
      <div class="tier-grid" style="grid-template-columns:repeat(4,1fr);gap:8px;margin-top:6px">
        ${presets.map((p) => `<button class="btn btn-outline" data-p="${p}">¥${p}</button>`).join('')}
      </div>
      <div class="field" style="margin-top:16px"><label>充值金额（1-10000 元）</label><input class="input" type="number" id="charge-amount" min="1" max="10000" placeholder="10" /></div>
      <button class="btn btn-primary btn-block" id="charge-confirm">前往收银台</button>
    </div>`);
  document.getElementById('modal-root').querySelectorAll('[data-p]').forEach((b) =>
    b.addEventListener('click', () => { document.getElementById('charge-amount').value = b.dataset.p; }));
  document.getElementById('charge-confirm').addEventListener('click', async () => {
    const amount = Number(document.getElementById('charge-amount').value);
    if (!amount || amount < 1) return toast('请输入金额', 'error');
    closeModal();
    showPayModal({ type: 'recharge', amount, onAfter: 'refreshAccount' });
  });
};

// ---------- 侧栏钱包 ----------
function walletSidebar(u) {
  const memberNames = { bronze: '青铜会员', silver: '白银会员', gold: '黄金会员', none: '未开通' };
  return `<div class="wallet-card">
    <div style="font-size:12px;opacity:.8">账户余额</div>
    <div class="wallet-balance">¥${u.balance}</div>
    <div style="font-size:12.5px;opacity:.85;margin-bottom:12px">${memberNames[u.membership] || '未开通会员'}</div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary btn-sm" onclick="App.showCharge()" style="flex:1">充值</button>
      <a class="btn btn-outline btn-sm" href="#/account" style="flex:1;background:rgba(255,255,255,.9)">会员</a>
    </div>
  </div>`;
}

// ---------- 广告主面板 ----------
App.advertise = async function () {
  if (!state.user) { toast('请先登录', 'error'); return App.showAuth('login'); }
  let d;
  try { d = await api('/api/ads/my'); } catch (err) { toast(err.message, 'error'); return; }

  const rows = d.ads.length
    ? d.ads.map((a) => `
      <tr>
        <td>${esc(a.title)}</td>
        <td>${a.position === 'banner' ? '顶部横幅' : '侧边栏'}</td>
        <td><span class="badge-status ${a.status}">${statusNames[a.status]}</span></td>
        <td>¥${a.budget}</td>
        <td>¥${a.spent}</td>
        <td>${a.impressions}</td>
        <td>${a.clicks}</td>
        <td>${a.cpc}</td>
      </tr>`).join('')
    : `<tr><td colspan="8" class="empty" style="padding:24px">还没有投放广告</td></tr>`;

  $app.innerHTML = `
    <div class="grid-home">
      <div>
        <h2 class="form-title" style="font-family:var(--serif)">广告主面板</h2>
        <p class="form-sub">创建广告，审核通过后展示在首页，按点击计费（CPC），收入计入账户余额。</p>
        <div class="stat-grid">
          <div class="stat-card"><div class="stat-num">${d.ads.length}</div><div class="stat-label">广告</div></div>
          <div class="stat-card"><div class="stat-num">${d.impressions}</div><div class="stat-label">展示</div></div>
          <div class="stat-card"><div class="stat-num">${d.clicks}</div><div class="stat-label">点击</div></div>
          <div class="stat-card"><div class="stat-num">¥${d.spent}</div><div class="stat-label">已消耗预算</div></div>
        </div>
        <div class="card card-pad" id="ad-form-card">
          <h3 style="margin-bottom:14px">＋ 创建广告</h3>
          <form id="ad-form">
            <div class="field"><label>广告标题</label><input class="input" name="title" maxlength="40" required /></div>
            <div class="field"><label>广告位</label><select class="input" name="position">
              <option value="sidebar">侧边栏</option><option value="banner">顶部横幅</option></select></div>
            <div class="field"><label>图片地址（留空则用标题文字）</label><input class="input" name="image_url" placeholder="https://…" /></div>
            <div class="field"><label>目标链接（http/https）</label><input class="input" name="link_url" placeholder="https://…" required /></div>
            <div class="tier-grid" style="grid-template-columns:1fr 1fr;gap:12px;margin-top:0">
              <div class="field"><label>预算（¥，≥10）</label><input class="input" type="number" name="budget" min="10" value="50" /></div>
              <div class="field"><label>单次点击 CPC（¥）</label><input class="input" type="number" name="cpc" min="0.1" step="0.1" value="0.5" /></div>
            </div>
            <button class="btn btn-primary btn-block" type="submit">提交并支付预算（审核通过后投放）</button>
          </form>
        </div>
        <h3 class="section-title">我投放的广告</h3>
        <div class="card"><div class="table-wrap">
          <table class="table">
            <thead><tr><th>标题</th><th>位置</th><th>状态</th><th>预算</th><th>已消耗</th><th>展示</th><th>点击</th><th>CPC</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div></div>
      </div>
      <aside class="sidebar-col">${state.user ? walletSidebar(state.user) : ''}</aside>
    </div>`;

  document.getElementById('ad-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const intent = {
      type: 'ad',
      title: fd.get('title'),
      link_url: fd.get('link_url'),
      image_url: fd.get('image_url'),
      position: fd.get('position'),
      budget: Number(fd.get('budget')),
      cpc: Number(fd.get('cpc')),
      onAfter: 'refreshAdvertise',
    };
    showPayModal(intent);
  });
};

const statusNames = { running: '投放中', pending: '待审核', paused: '已暂停', rejected: '已拒绝', exhausted: '预算耗尽' };

// ---------- 广告位（出售给广告主的页面） ----------
App.adSlots = async function () {
  await refreshCategories();
  const [slotsData, myData] = await Promise.all([
    api('/api/ad-slots').catch(() => ({ slots: [] })),
    state.user ? api('/api/slots/my').catch(() => ({ purchases: [] })) : Promise.resolve({ purchases: [] }),
  ]);
  const posName = (p) => (p === 'banner' ? '顶部横幅' : '侧边栏');

  const cards = slotsData.slots.map((s) => `
    <div class="card slot-card">
      <div class="slot-pos">${posName(s.position)}</div>
      <div class="slot-name">${esc(s.name)}</div>
      <p class="slot-desc">${esc(s.description || '')}</p>
      <div class="slot-meta">
        <span>⏱ ${s.duration_days} 天</span>
        <span>📦 已售 ${s.sold}</span>
      </div>
      <div class="slot-price">¥${s.price}</div>
      ${s.available
        ? `<button class="btn btn-primary btn-block" data-buy-slot="${s.id}">购买该广告位</button>`
        : `<button class="btn btn-block btn-outline" disabled>暂时停售</button>`}
    </div>`).join('') || '<div class="empty">暂无在售广告位，请联系站长。</div>';

  const myRows = myData.purchases.length
    ? myData.purchases.map((p) => `
      <tr>
        <td>${esc(p.slot_name)}</td>
        <td>${posName(p.position)}</td>
        <td>¥${p.amount}</td>
        <td>${p.start_at.slice(0, 10)} → ${p.end_at.slice(0, 10)}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="empty" style="padding:24px">还没有购买过广告位</td></tr>';

  $app.innerHTML = `
    <h2 class="form-title" style="font-family:var(--serif)">广告位</h2>
    <p class="form-sub">本站广告位公开出售，买断展示权益后，再到「广告主面板」创建并投放广告。</p>
    <div class="slot-grid">${cards}</div>
    ${state.user ? `
      <h3 class="section-title">我购买的广告位</h3>
      <div class="card"><div class="table-wrap">
        <table class="table">
          <thead><tr><th>广告位</th><th>位置</th><th>金额</th><th>展示期</th></tr></thead>
          <tbody>${myRows}</tbody>
        </table>
      </div></div>` : ''}
  `;

  $app.querySelectorAll('[data-buy-slot]').forEach((b) =>
    b.addEventListener('click', () => {
      const slot = slotsData.slots.find((s) => s.id === Number(b.dataset.buySlot));
      showPayModal({ type: 'ad_slot', slot_id: slot.id, amount: slot.price, onAfter: 'refreshAdSlots' });
    }));
};

// ---------- 图表（内联 SVG，零依赖） ----------
function svgLine(series) {
  if (!series.length) return '<div class="empty" style="padding:20px">暂无数据</div>';
  const W = 560, H = 150, pad = 18;
  const max = Math.max(...series.map((s) => s.count), 1);
  const stepX = (W - pad * 2) / (series.length - 1 || 1);
  const pts = series.map((s, i) => {
    const x = pad + i * stepX;
    const y = H - pad - (s.count / max) * (H - pad * 2);
    return { x, y, s };
  });
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const dots = pts.map((p) =>
    `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="var(--teal)"><title>${p.s.date} · ${p.s.count}</title></circle>`).join('');
  const labels = pts.filter((_, i) => i % 2 === 0).map((p) =>
    `<text x="${p.x}" y="${H - 2}" font-size="8" fill="#8a8377" text-anchor="middle">${p.s.date.slice(5)}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="日活趋势">
    ${labels}<path d="${path}" fill="none" stroke="var(--teal)" stroke-width="2"/>${dots}</svg>`;
}
function svgBars(series) {
  if (!series.length) return '<div class="empty" style="padding:20px">暂无数据</div>';
  const W = 560, H = 150, pad = 18;
  const max = Math.max(...series.map((s) => s.amount), 1);
  const bw = (W - pad * 2) / series.length;
  const bars = series.map((s, i) => {
    const h = Math.max(2, (s.amount / max) * (H - pad * 2));
    const x = pad + i * bw + bw * 0.2;
    const w = bw * 0.6;
    const y = H - pad - h;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="var(--gold)"><title>${s.date} · ¥${s.amount}</title></rect>`;
  }).join('');
  const labels = series.filter((_, i) => i % 2 === 0).map((s, i) => {
    const x = pad + i * bw * 2 + bw * 0.2 + bw * 0.3;
    return `<text x="${x.toFixed(1)}" y="${H - 2}" font-size="8" fill="#8a8377" text-anchor="middle">${s.date.slice(5)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="营收柱状图">${labels}${bars}</svg>`;
}
const revTypeName = { recharge: '充值', membership: '会员', post: '付费帖', ad_recharge: '广告投放', ad_slot: '广告位', '': '—' };

// ---------- 管理后台（站长中心） ----------
App.admin = async function () {
  if (!state.user) { toast('请先登录', 'error'); return App.showAuth('login'); }
  if (state.user.role !== 'admin') { toast('仅管理员可访问', 'error'); return location.hash = '#/'; }
  const [stats, ads, dash, slotsData, posts] = await Promise.all([
    api('/api/admin/stats'),
    api('/api/admin/ads'),
    api('/api/admin/dashboard'),
    api('/api/admin/slots'),
    api('/api/posts'),
  ]);

  const adRows = ads.ads.map((a) => `
      <tr>
        <td><strong>${esc(a.title)}</strong><div style="font-size:12px;color:var(--muted)">作者：${esc(a.owner)} · ${a.position === 'banner' ? '横幅' : '侧栏'}</div></td>
        <td><span class="badge-status ${a.status}">${statusNames[a.status]}</span></td>
        <td>¥${a.budget} / 耗 ¥${a.spent}</td>
        <td>${a.impressions} 展示 · ${a.clicks} 点击</td>
        <td>
          ${a.status === 'pending' ? `<button class="btn btn-sm btn-teal" data-ad-approve="${a.id}">通过</button>` : ''}
          ${a.status === 'running' ? `<button class="btn btn-sm btn-outline" data-ad-status="${a.id}|paused">暂停</button>` : ''}
          ${a.status === 'paused' ? `<button class="btn btn-sm btn-teal" data-ad-status="${a.id}|running">恢复</button>` : ''}
          ${a.status === 'pending' ? `<button class="btn btn-sm btn-danger" data-ad-status="${a.id}|rejected">拒绝</button>` : ''}
        </td>
      </tr>`).join('');

  const postRows = posts.posts.map((p) => `
      <tr>
        <td><a href="#/post/${p.id}"><strong>${esc(p.title)}</strong></a></td>
        <td>${esc(p.author)}</td>
        <td><span class="badge-cat" style="background:${esc(p.category_color)}">${esc(p.category)}</span></td>
        <td style="color:${p.status === 'hidden' ? 'var(--danger)' : 'inherit'}">${p.status === 'hidden' ? '已隐藏' : '正常'}</td>
        <td><button class="btn btn-sm btn-outline btn-danger" data-hide-post="${p.id}">${p.status === 'hidden' ? '恢复' : '隐藏'}</button></td>
      </tr>`).join('');

  const slotRows = (slotsData.slots || []).map((s) => `
      <tr>
        <td><strong>${esc(s.name)}</strong><div style="font-size:12px;color:var(--muted)">${s.position === 'banner' ? '顶部横幅' : '侧边栏'} · 已售 ${s.sold} / 预约 ${s.booking_count}</div></td>
        <td>¥${s.price} / ${s.duration_days}天</td>
        <td><span class="badge-status ${s.available ? 'running' : 'exhausted'}">${s.available ? '在售' : '停售'}</span></td>
        <td>
          <button class="btn btn-sm btn-outline" data-slot-price="${s.id}">调价</button>
          <button class="btn btn-sm ${s.available ? 'btn-danger' : 'btn-teal'}" data-slot-toggle="${s.id}">${s.available ? '下架' : '上架'}</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="4" class="empty" style="padding:24px">暂无广告位套餐</td></tr>';

  const revByType = (dash.revenueByType || []).map((r) => {
    const pct = dash.revenue.reduce((t, x) => t + x.amount, 0) > 0
      ? Math.round((r.s / dash.revenue.reduce((t, x) => t + x.amount, 0)) * 100) : 0;
    return `<div class="rev-item"><span>${revTypeName[r.type] || r.type}</span><b>¥${r.s}</b><small>${r.n} 笔 · ${pct}%</small></div>`;
  }).join('');

  $app.innerHTML = `
    <h2 class="form-title" style="font-family:var(--serif)">站长中心</h2>
    <p class="form-sub">查看用户日活与收入，审核广告、管理帖子、维护可售广告位。</p>

    <div class="tabs" role="tablist">
      <button class="tab active" data-tab="data">📊 运营数据</button>
      <button class="tab" data-tab="ads">📢 广告审核 (${dash.todayDau})</button>
      <button class="tab" data-tab="posts">📝 帖子管理</button>
      <button class="tab" data-tab="slots">🛒 广告位库存</button>
    </div>

    <div class="tab-panel active" data-panel="data">
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-num">${dash.todayDau}</div><div class="stat-label">今日日活</div></div>
        <div class="stat-card"><div class="stat-num">${dash.peakDau}</div><div class="stat-label">近14天峰值日活</div></div>
        <div class="stat-card"><div class="stat-num">¥${dash.todayRevenue}</div><div class="stat-label">今日收入</div></div>
        <div class="stat-card"><div class="stat-num">¥${stats.adSpent}</div><div class="stat-label">广告累计消耗</div></div>
        <div class="stat-card"><div class="stat-num">${stats.users}</div><div class="stat-label">注册用户</div></div>
        <div class="stat-card"><div class="stat-num">${stats.posts}</div><div class="stat-label">帖子</div></div>
      </div>
      <div class="chart-card"><div class="chart-title">近 14 天用户日活</div>${svgLine(dash.dau)}</div>
      <div class="chart-card"><div class="chart-title">近 14 天收入（元）</div>${svgBars(dash.revenue)}</div>
      <div class="chart-card"><div class="chart-title">收入构成</div><div class="rev-list">${revByType || '<div class="empty">暂无收入</div>'}</div></div>
    </div>

    <div class="tab-panel" data-panel="ads">
      <h3 class="section-title">广告审核</h3>
      <div class="card"><div class="table-wrap">
        <table class="table">
          <thead><tr><th>广告</th><th>状态</th><th>预算/消耗</th><th>数据</th><th>操作</th></tr></thead>
          <tbody>${adRows || `<tr><td colspan="5" class="empty" style="padding:24px">没有广告</td></tr>`}</tbody>
        </table>
      </div></div>
    </div>

    <div class="tab-panel" data-panel="posts">
      <h3 class="section-title">帖子管理</h3>
      <div class="card"><div class="table-wrap">
        <table class="table">
          <thead><tr><th>标题</th><th>作者</th><th>分类</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>${postRows || `<tr><td colspan="5" class="empty" style="padding:24px">没有帖子</td></tr>`}</tbody>
        </table>
      </div></div>
    </div>

    <div class="tab-panel" data-panel="slots">
      <div class="card card-pad" style="margin-bottom:16px">
        <h3 style="margin-bottom:12px">＋ 新增广告位套餐</h3>
        <form id="slot-form" class="slot-form">
          <input class="input" name="name" placeholder="套餐名，如：首页横幅月卡" required />
          <select class="input" name="position"><option value="sidebar">侧边栏</option><option value="banner">顶部横幅</option></select>
          <input class="input" type="number" name="price" min="1" placeholder="价格 ¥" required />
          <input class="input" type="number" name="duration_days" min="1" value="7" placeholder="天数" />
          <input class="input" name="description" placeholder="一句话描述" />
          <button class="btn btn-primary" type="submit">新增</button>
        </form>
      </div>
      <h3 class="section-title">广告位库存</h3>
      <div class="card"><div class="table-wrap">
        <table class="table">
          <thead><tr><th>套餐</th><th>售价</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>${slotRows}</tbody>
        </table>
      </div></div>
    </div>`;

  // tabs
  $app.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      $app.querySelectorAll('[data-tab]').forEach((x) => x.classList.remove('active'));
      $app.querySelectorAll('[data-panel]').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      $app.querySelector(`[data-panel="${b.dataset.tab}"]`).classList.add('active');
    }));

  // 广告审核操作
  $app.querySelectorAll('[data-ad-approve]').forEach((b) =>
    b.addEventListener('click', async () => {
      try { await api(`/api/admin/ads/${b.dataset.adApprove}/status`, { method: 'POST', body: JSON.stringify({ status: 'running' }) }); toast('已通过并投放'); App.admin(); }
      catch (err) { toast(err.message, 'error'); }
    }));
  $app.querySelectorAll('[data-ad-status]').forEach((b) =>
    b.addEventListener('click', async () => {
      const [id, st] = b.dataset.adStatus.split('|');
      try { await api(`/api/admin/ads/${id}/status`, { method: 'POST', body: JSON.stringify({ status: st }) }); toast('已更新'); App.admin(); }
      catch (err) { toast(err.message, 'error'); }
    }));
  $app.querySelectorAll('[data-hide-post]').forEach((b) =>
    b.addEventListener('click', async () => {
      try { await api(`/api/posts/${b.dataset.hidePost}/hide`, { method: 'POST', body: '{}' }); toast('已操作'); App.admin(); }
      catch (err) { toast(err.message, 'error'); }
    }));

  // 广告位：调价 / 上架 / 下架
  $app.querySelectorAll('[data-slot-toggle]').forEach((b) =>
    b.addEventListener('click', async () => {
      const slot = (slotsData.slots || []).find((s) => s.id === Number(b.dataset.slotToggle));
      try {
        await api(`/api/admin/slots/${slot.id}`, { method: 'POST', body: JSON.stringify({ available: slot.available ? 0 : 1 }) });
        toast('已更新'); App.admin();
      } catch (err) { toast(err.message, 'error'); }
    }));
  $app.querySelectorAll('[data-slot-price]').forEach((b) =>
    b.addEventListener('click', () => {
      const slot = (slotsData.slots || []).find((s) => s.id === Number(b.dataset.slotPrice));
      const p = prompt(`设置「${slot.name}」的价格（¥）：`, slot.price);
      if (p === null) return;
      api(`/api/admin/slots/${slot.id}`, { method: 'POST', body: JSON.stringify({ price: Number(p) }) })
        .then(() => { toast('已调价'); App.admin(); })
        .catch((err) => toast(err.message, 'error'));
    }));
  const slotForm = document.getElementById('slot-form');
  if (slotForm) slotForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = { name: fd.get('name'), position: fd.get('position'), price: Number(fd.get('price')), duration_days: Number(fd.get('duration_days') || 7), description: fd.get('description') };
    try { await api('/api/admin/slots', { method: 'POST', body: JSON.stringify(body) }); toast('已新增套餐'); App.admin(); }
    catch (err) { toast(err.message, 'error'); }
  });
};

// ---------- 支付结果页（Stripe 回跳后轮询到账） ----------
App.payResult = async function () {
  const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const orderNo = params.get('order') || '';
  const initStatus = params.get('status');
  $app.innerHTML = `
    <div class="card card-pad" style="max-width:520px;margin:40px auto;text-align:center">
      <div class="empty-emoji" id="pay-emoji">⏳</div>
      <h2 class="form-title" id="pay-title">正在确认支付结果…</h2>
      <p class="form-sub" id="pay-desc">订单 ${esc(orderNo)}</p>
      <button class="btn btn-primary hidden" id="pay-go-account">查看我的账户</button>
      <button class="btn btn-outline hidden" id="pay-retry">刷新状态</button>
    </div>`;
  if (initStatus === 'cancel') {
    document.getElementById('pay-emoji').textContent = '😶';
    document.getElementById('pay-title').textContent = '支付已取消';
    document.getElementById('pay-desc').textContent = '订单未支付，可稍后在账户页重新发起。';
    document.getElementById('pay-go-account').classList.remove('hidden');
    document.getElementById('pay-go-account').addEventListener('click', () => location.hash = '#/account');
    return;
  }
  // 最多轮询 ~10 秒
  let tries = 0;
  const timer = setInterval(async () => {
    tries++;
    let orders = [];
    try { orders = (await api('/api/pay/my')).orders; } catch {}
    const hit = orders.find((o) => o.order_no === orderNo);
    if (hit && hit.status === 'paid') {
      clearInterval(timer);
      await refreshMe();
      document.getElementById('pay-emoji').textContent = '✅';
      document.getElementById('pay-title').textContent = '支付成功';
      document.getElementById('pay-desc').textContent = '权益已到账。';
      document.getElementById('pay-go-account').classList.remove('hidden');
      document.getElementById('pay-go-account').addEventListener('click', () => location.hash = '#/account');
    } else if (tries > 20) {
      clearInterval(timer);
      document.getElementById('pay-emoji').textContent = '⏳';
      document.getElementById('pay-title').textContent = '还在等待支付确认';
      document.getElementById('pay-desc').textContent = '若已完成付款，点下方刷新。';
      document.getElementById('pay-retry').classList.remove('hidden');
      document.getElementById('pay-retry').addEventListener('click', () => App.payResult());
    }
  }, 500);
};

// =========================================================
// 路由 / 启动
// =========================================================
async function refreshCategories() {
  try {
    const d = await api('/api/categories');
    state.categories = d.categories;
  } catch {}
}

function trackPage() {
  const hash = window.location.hash.slice(1) || '/';
  const page = hash.split('?')[0] || '/';
  fetch(`/api/track?page=${encodeURIComponent(page)}`, { method: 'POST', body: '{}' })
    .catch(() => {});
}

function onRouteChange() { trackPage(); router(); }

// 把真实路径（服务端预渲染后的 SEO URL）同步成页面地址，不触发跳转；
// 顺带清掉冗余 hash，保证硬刷新后地址栏保持干净的 /post/:id、/c/:slug
function syncPath(p) {
  if (location.pathname === p && !location.hash) return;
  history.replaceState(null, '', p);
}

// 首屏进入时把 SEO 路径收敛到 hash 路由：/post/:id、/c/:slug、/?q=…
// 返回 true 表示已设置 hash（将由 hashchange 触发渲染）；false 表示无需处理
function adaptSeoPath() {
  if (location.hash) return false;
  const path = location.pathname;
  const pm = path.match(/^\/post\/(\d+)/);
  const cm = path.match(/^\/c\/([\w-]+)/);
  const q = new URLSearchParams(location.search).get('q');
  if (pm) { location.hash = `#/post/${pm[1]}`; return true; }
  if (cm) { location.hash = `#/?cat=${cm[1]}`; return true; }
  if (q) { location.hash = `#/?q=${encodeURIComponent(q)}`; return true; }
  if (path !== '/' && path !== '/index.html') history.replaceState(null, '', '/');
  return false;
}

function router() {
  const hash = window.location.hash.slice(1) || '/';
  const [path, query] = hash.split('?');
  $app.innerHTML = '';
  if (path === '' || path === '/') { App.home(); syncPath('/'); }
  else if (path === '/new') App.newPost();
  else if (path === '/account') App.account();
  else if (path === '/advertise') App.advertise();
  else if (path === '/ad-slots') App.adSlots();
  else if (path === '/pay-result') App.payResult();
  else if (path === '/admin') App.admin();
  else if (path.startsWith('/post/')) {
    const id = Number(path.split('/')[2]);
    if (Number.isInteger(id)) { App.post(id); syncPath('/post/' + id); }
    else location.hash = '#/';
  } else location.hash = '#/';
}

window.addEventListener('hashchange', onRouteChange);

(async function init() {
  const adapted = adaptSeoPath();
  await refreshMe();
  // 已把 SEO 路径转为 hash 时，交由 hashchange 事件触发渲染，避免重复请求
  if (adapted) return;
  await refreshCategories();
  trackPage();
  router();
})();