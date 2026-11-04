'use strict';
/* ===================== Epic Gift — server.js (PaxtaGram + Supabase Postgres) ===================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- oddiy .env o'qish (qo'shimcha kutubxonasiz) ----
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) { /* .env yo'q bo'lishi mumkin */ }

const express = require('express');
const D = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('XATO: BOT_TOKEN topilmadi. Render → Environment ga BOT_TOKEN yozing.');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('XATO: DATABASE_URL topilmadi. Supabase → Connect → Session pooler havolasini DATABASE_URL ga yozing.');
  process.exit(1);
}
const API_BASE = (process.env.API_BASE || 'https://paxta.online').replace(/\/$/, '');
const WEBAPP_URL = process.env.WEBAPP_URL || process.env.RENDER_EXTERNAL_URL || '';
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
// PaxtaGram profil havolasi: https://paxta.online/u/<username>
const INVITE_BASE = process.env.INVITE_BASE || API_BASE + '/u/';
let BOT_USERNAME = '';

const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { all, one, run, insert, tx } = D;
D.connect(process.env.DATABASE_URL);

/* ===================== SOZLAMALAR (xotirada keshlanadi) ===================== */
const DEFAULTS = {
  rocket_rtp: '95', mines_rtp: '95', min_bet: '50', max_bet: '1000000000',
  ref_bonus: '5', contest_prize: '100', pvp_fee: '5', gift_to_balance: '0', gift_credit_pct: '100', plinko_rtp: '95', gift_withdraw_fee: '150', pvp_bot: '1', pvp_bot_max: '500', pvp_countdown: '10', key_nft_mult: '0.3', key_nft_min: '400', upgrade_rtp: '95',
};
let S = {};
async function loadSettings() {
  const rows = await all('SELECT key, value FROM settings');
  S = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
}
const getS = (k) => S[k];
const allS = () => ({ ...S });

/* ===================== YOZIB BORISH: balans, hodisa, admin ===================== */
async function logEvent(kind, uid, data) {
  try {
    await run('INSERT INTO events(kind,user_id,data,created_at) VALUES(?,?,?,?)',
      [kind, uid == null ? null : uid, typeof data === 'string' ? data.slice(0, 2000) : JSON.stringify(data).slice(0, 2000), now()]);
  } catch (e) { console.error('[events]', e.message); }
}
const auditAdmin = (adminId, action, detail) => run('INSERT INTO admin_log(admin_id,action,detail,created_at) VALUES(?,?,?,?)',
  [adminId, action, typeof detail === 'string' ? detail : JSON.stringify(detail || {}), now()]).catch((e) => console.error('[admin_log]', e.message));

const fail = (msg, status = 400) => { const e = new Error(msg); e.status = status; throw e; };

async function addBal(id, d, reason = '', ref = '') {
  if (!d) return;
  const r = await one('UPDATE users SET balance = balance + ? WHERE id=? RETURNING balance', [d, id]);
  if (!r) fail('Foydalanuvchi topilmadi', 404);
  await run('INSERT INTO balance_log(user_id,delta,balance_after,reason,ref,created_at) VALUES(?,?,?,?,?,?)', [id, d, r.balance, reason, String(ref), now()]);
}
// Balansdan atomik yechish: yetarli bo'lmasa xato (ikki marta bosib "ko'paytirish" mumkin emas)
async function debit(id, amount, reason = '', ref = '') {
  if (!(amount > 0)) return;
  const r = await one('UPDATE users SET balance = balance - ? WHERE id=? AND balance >= ? RETURNING balance', [amount, id, amount]);
  if (!r) fail('Balans yetarli emas');
  await run('INSERT INTO balance_log(user_id,delta,balance_after,reason,ref,created_at) VALUES(?,?,?,?,?,?)', [id, -amount, r.balance, reason, String(ref), now()]);
}
const getBal = async (id) => { const r = await one('SELECT balance FROM users WHERE id=?', [id]); return r ? r.balance : 0; };
const lockUser = (id) => one('SELECT id FROM users WHERE id=? FOR UPDATE', [id]);
const addScore = (id, n) => run(
  'INSERT INTO contest_scores(user_id,score) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET score = contest_scores.score + excluded.score', [id, n]);

const kvGet = async (k) => { const r = await one('SELECT value FROM kv WHERE key=?', [k]); return r ? r.value : ''; };
const kvSet = (k, v) => run('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [k, String(v)]);

/* ===================== BAZANI TAYYORLASH ===================== */
const BOT_ID = -1;
async function seedKeys() {
  const addKey = async (name, emoji, price, cd, rewards) => {
    const id = await insert('INSERT INTO keys_items(name,emoji,price,cooldown_hours) VALUES(?,?,?,?)', [name, emoji, price, cd]);
    for (const r of rewards) await run('INSERT INTO key_rewards(key_id,name,value,chance) VALUES(?,?,?,?)', [id, ...r]);
  };
  await addKey('Free Key', '🎁', 0, 24, [['Maple Leaf', 50, 70], ['Money Tree', 75, 25], ['Cake', 100, 5]]);
  await addKey('Silver Key', '🔑', 100, 0, [['Maple Leaf', 50, 50], ['Money Tree', 75, 30], ['Cake', 100, 15], ['B-Day Candle', 498, 4], ['Lol Pop', 570, 0.8], ['Star Notepad', 1500, 0.2]]);
  await addKey('Gold Key', '🗝️', 500, 0, [['Cake', 100, 45.5], ['B-Day Candle', 498, 30], ['Lol Pop', 570, 18], ['Star Notepad', 1500, 6], ['Precious Peach', 8000, 0.5]]);
}

async function initDb() {
  await D.initSchema();
  for (const [k, v] of Object.entries(DEFAULTS)) await run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING', [k, v]);

  // Bir martalik: giftlar inventarga tushadi (balansga avto emas)
  if (!(await one("SELECT 1 FROM kv WHERE key='mig_inv_v1'"))) {
    await run("UPDATE settings SET value='0' WHERE key='gift_to_balance'");
    await run("INSERT INTO kv(key,value) VALUES('mig_inv_v1','1') ON CONFLICT(key) DO NOTHING");
  }
  // Bir martalik: minimal stavka 50⭐, maksimal cheksiz
  if (!(await one("SELECT 1 FROM kv WHERE key='mig_minmax_v1'"))) {
    await run("UPDATE settings SET value='50' WHERE key='min_bet'");
    await run("UPDATE settings SET value='1000000000' WHERE key='max_bet'");
    await run("UPDATE settings SET value='500' WHERE key='pvp_bot_max'");
    await run("INSERT INTO kv(key,value) VALUES('mig_minmax_v1','1') ON CONFLICT(key) DO NOTHING");
  }
  // Gift katalogi (Paxta Market narxlari, ⭐). Admin paneldan o'zgartiriladi
  for (const [n, v] of [['Maple Leaf', 50], ['Money Tree', 75], ['Cake', 100], ['B-Day Candle', 498], ['Lol Pop', 570], ['Star Notepad', 1500], ['Precious Peach', 8000], ['Scared Cat', 27777], ['Swiss Watch', 28999], ['Mask', 0], ['Resistance Dog', 0]]) {
    await run("INSERT INTO gift_values(base_name,value,image) VALUES(?,?,'') ON CONFLICT(base_name) DO NOTHING", [n, v]);
  }
  // Namuna keyslar (faqat bir marta)
  if (!(await one("SELECT 1 FROM kv WHERE key='mig_keys_v2'"))) {
    if (!(await one("SELECT 1 FROM keys_items WHERE name='Free Key'"))) await seedKeys();
    await run("INSERT INTO kv(key,value) VALUES('mig_keys_v2','1') ON CONFLICT(key) DO NOTHING");
  }
  await run('INSERT INTO users(id,first_name,username,photo_url,balance,created_at) VALUES(?,?,?,?,0,?) ON CONFLICT(id) DO NOTHING',
    [BOT_ID, 'Epic bot', 'epic_bot', '', now()]);
  await loadSettings();
}

/* ===================== BOT API ===================== */
async function bot(method, params = {}) {
  try {
    const r = await fetch(`${API_BASE}/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(method === 'getUpdates' ? 40000 : 20000),
    });
    const j = await r.json();
    if (!j.ok) console.error(`[bot] ${method}:`, j.description);
    return j;
  } catch (e) {
    console.error(`[bot] ${method}:`, e.message);
    return { ok: false, description: e.message };
  }
}
const tell = (id, text) => bot('sendMessage', { chat_id: id, text });

/* ===================== XAVFSIZLIK: initData ===================== */
function verifyInitData(initData) {
  if (!initData || typeof initData !== 'string') return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  const a = Buffer.from(hash);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch (e) { return null; }
}

async function ensureUser(u, ref) {
  let referrer = null;
  if (ref && ref !== u.id && (await one('SELECT 1 FROM users WHERE id=?', [ref]))) referrer = ref;
  const fn = u.first_name || '';
  const un = u.username || '';
  const ph = u.photo_url || '';
  const row = await one(`INSERT INTO users(id,first_name,username,photo_url,referrer,created_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      first_name = COALESCE(NULLIF(excluded.first_name,''), users.first_name),
      username = excluded.username,
      photo_url = COALESCE(NULLIF(excluded.photo_url,''), users.photo_url)
    WHERE (users.first_name, users.username, users.photo_url) IS DISTINCT FROM
      (COALESCE(NULLIF(excluded.first_name,''), users.first_name), excluded.username, COALESCE(NULLIF(excluded.photo_url,''), users.photo_url))
    RETURNING *, (xmax = 0) AS inserted`, [u.id, fn, un, ph, referrer, now()]);
  if (row && row.inserted && referrer) await addBal(referrer, getS('ref_bonus'), 'referral', u.id);
  return row || (await one('SELECT * FROM users WHERE id=?', [u.id]));
}

async function auth(req, res, next) {
  try {
    const u = verifyInitData(req.get('x-init-data'));
    if (!u || !u.id) return res.status(401).json({ error: 'Avtorizatsiya xatosi' });
    req.user = await ensureUser(u);
    req.isAdmin = ADMIN_IDS.includes(u.id);
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server xatosi' });
  }
}
function adminOnly(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'Ruxsat yo\'q' });
  next();
}

const wrap = (fn) => (req, res) => Promise.resolve()
  .then(() => fn(req))
  .then((r) => res.json(r === undefined ? { ok: true } : r))
  .catch((e) => {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Server xatosi' });
  });

function parseBet(v) {
  const n = Number(v);
  if (!Number.isInteger(n)) fail('Stavka butun son bo\'lishi kerak');
  if (n < getS('min_bet')) fail(`Minimal stavka: ${getS('min_bet')}`);
  if (n > getS('max_bet')) fail(`Maksimal stavka: ${getS('max_bet')}`);
  return n;
}

/* ===================== EXPRESS ===================== */
const app = express();
app.disable('x-powered-by');
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---- /api/me ---- */
const activeMines = (uid) => one("SELECT * FROM mines_games WHERE user_id=? AND status='active'", [uid]);

app.get('/api/me', auth, wrap(async (req) => {
  const u = req.user;
  const s = allS();
  const g = await activeMines(u.id);
  return {
    id: u.id, first_name: u.first_name, username: u.username, photo_url: u.photo_url,
    balance: u.balance, is_admin: req.isAdmin,
    min_bet: s.min_bet, max_bet: s.max_bet,
    invite_link: `${INVITE_BASE}${BOT_USERNAME}?start=ref_${u.id}`,
    ref_bonus: s.ref_bonus,
    mines_active: g ? minesState(g) : null,
  };
}));

/* ---- Live bar ---- */
app.get('/api/live', auth, wrap(async () => {
  const [a, b, c] = await Promise.all([
    all(`SELECT u.first_name n, r.win w FROM rocket_bets r JOIN users u ON u.id=r.user_id WHERE r.win>0 ORDER BY r.id DESC LIMIT 8`),
    all(`SELECT u.first_name n, m.win w FROM mines_games m JOIN users u ON u.id=m.user_id WHERE m.status='won' ORDER BY m.id DESC LIMIT 8`),
    all(`SELECT u.first_name n, p.win w FROM plinko_games p JOIN users u ON u.id=p.user_id WHERE p.win>p.bet ORDER BY p.id DESC LIMIT 8`),
  ]);
  return { items: [...a.map((x) => ({ e: '🚀', n: x.n, w: x.w })), ...b.map((x) => ({ e: '💎', n: x.n, w: x.w })), ...c.map((x) => ({ e: '🔮', n: x.n, w: x.w }))].slice(0, 16) };
}));

/* ---- Keys (gift mukofotli, bepul kunlik key bilan) ---- */
const CAT_BY_NAME = "SELECT base_name n, value v, COALESCE(image,'') img FROM gift_values WHERE lower(replace(base_name,' ',''))=lower(replace(?,' ',''))";
async function rewardInfo(r) {
  const cat = await one(CAT_BY_NAME, [r.name]);
  if (cat && cat.v > 0) return { name: cat.n, value: cat.v, gift: true, image: cat.img };
  return { name: r.name, value: r.value, gift: false, image: '' };
}
async function keyFreeIn(uid, k) {
  if (!(k.cooldown_hours > 0)) return 0;
  const last = await one('SELECT last_open FROM key_cooldowns WHERE user_id=? AND key_id=?', [uid, k.id]);
  return last ? Math.max(0, last.last_open + k.cooldown_hours * 3600 - now()) : 0;
}
app.get('/api/keys', auth, wrap(async (req) => {
  const keys = await all('SELECT id,name,emoji,price,cooldown_hours FROM keys_items WHERE active=1 ORDER BY cooldown_hours DESC, price');
  const out = [];
  for (const k of keys) {
    const rws = await all('SELECT name,value FROM key_rewards WHERE key_id=?', [k.id]);
    const rewards = (await Promise.all(rws.map(rewardInfo))).sort((a, b) => a.value - b.value);
    out.push({ ...k, free_in: await keyFreeIn(req.user.id, k), rewards });
  }
  return { keys: out };
}));

app.post('/api/keys/:id/open', auth, wrap((req) => {
  const id = Number(req.params.id);
  const uid = req.user.id;
  return tx(async () => {
    await lockUser(uid);
    const key = await one('SELECT * FROM keys_items WHERE id=? AND active=1', [id]);
    if (!key) fail('Key topilmadi', 404);
    const rw = await all('SELECT * FROM key_rewards WHERE key_id=?', [id]);
    if (!rw.length) fail('Bu keysda mukofot yo\'q');
    const free = key.cooldown_hours > 0;
    if (free) {
      const left = await keyFreeIn(uid, key);
      if (left > 0) fail(`Bepul keys ${Math.floor(left / 3600)} soat ${Math.floor((left % 3600) / 60)} daqiqadan keyin ochiladi`);
      await run('INSERT INTO key_cooldowns(user_id,key_id,last_open) VALUES(?,?,?) ON CONFLICT(user_id,key_id) DO UPDATE SET last_open=excluded.last_open', [uid, id, now()]);
    } else {
      await debit(uid, key.price, 'key_open', id);
      await addScore(uid, key.price);
    }
    // Qimmat (NFT) giftlarning tushish shansi key_nft_mult ga ko'paytiriladi
    const mult = getS('key_nft_mult');
    const minV = getS('key_nft_min');
    const infos = await Promise.all(rw.map(rewardInfo));
    let w = rw.map((r, i) => r.chance * (infos[i].gift && infos[i].value >= minV ? mult : 1));
    if (!(w.reduce((a, b) => a + b, 0) > 0)) w = rw.map((r) => r.chance);
    const total = w.reduce((a, b) => a + b, 0);
    let x = (crypto.randomInt(0, 1e9) / 1e9) * total;
    let pi = rw.length - 1;
    for (let i = 0; i < rw.length; i++) { if (x < w[i]) { pi = i; break; } x -= w[i]; }
    const info = infos[pi];
    let giftId = null;
    if (info.gift) {
      giftId = await insert("INSERT INTO user_gifts(owner_id,owned_gift_id,connection_id,base_name,name,value,status,created_at,image,source) VALUES(?,?,?,?,?,?,?,?,?,'key')",
        [uid, '', '', info.name, info.name, info.value, 'owned', now(), info.image]);
    } else await addBal(uid, info.value, 'key_reward', id);
    return { reward: info, gift_id: giftId, balance: await getBal(uid), free_in: free ? key.cooldown_hours * 3600 : 0 };
  });
}));

/* ---- Gifts (sotib olish) ---- */
app.get('/api/gifts', auth, wrap(async () => ({
  gifts: await all('SELECT id,name,emoji,price FROM gifts WHERE active=1 ORDER BY price'),
})));

app.post('/api/gifts/:id/buy', auth, wrap(async (req) => {
  const id = Number(req.params.id);
  const uid = req.user.id;
  const g = await tx(async () => {
    await lockUser(uid);
    const row = await one('SELECT * FROM gifts WHERE id=? AND active=1', [id]);
    if (!row) fail('Gift topilmadi', 404);
    await debit(uid, row.price, 'gift_buy', id);
    return row;
  });
  const who = req.user.username ? '@' + req.user.username : req.user.first_name;
  await logEvent('gift_order', uid, { gift: g.name, price: g.price });
  for (const a of ADMIN_IDS) {
    await tell(a, `🎁 Yangi gift buyurtma: ${g.emoji} ${g.name} (${g.price}⭐)\nFoydalanuvchi: ${who} (ID ${uid})`);
  }
  return { ok: true, balance: await getBal(uid) };
}));

/* ---- NFT havolalari: nom, rasm, model avtomatik olinadi ---- */
const NFT_BASE = (process.env.NFT_BASE || `${API_BASE}/nft`).replace(/\/$/, '');
const normName = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const spaced = (x) => String(x).replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
const slugOf = (x) => { const m = /([A-Za-z0-9_]+-\d+)(?:\.png)?\/?(?:[?#].*)?$/.exec(String(x || '').trim()); return m ? m[1] : null; };
function metaTags(html) {
  const out = {};
  for (const m of String(html).matchAll(/<meta\s+([^>]*?)\/?>/gi)) {
    const at = {};
    for (const a of m[1].matchAll(/([\w:-]+)\s*=\s*"([^"]*)"|([\w:-]+)\s*=\s*'([^']*)'/g)) at[(a[1] || a[3]).toLowerCase()] = a[2] != null ? a[2] : a[4];
    const key = at.property || at.name;
    if (key && at.content != null) out[key.toLowerCase()] = at.content.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  }
  return out;
}
async function nftInfo(slug) {
  const info = { slug, name: spaced(slug.replace(/-\d+$/, '')), number: Number((/-(\d+)$/.exec(slug) || [])[1]) || null, image: `${NFT_BASE}/${slug}.png`, model: '', backdrop: '', symbol: '' };
  try {
    const r = await fetch(`${NFT_BASE}/${slug}`, { signal: AbortSignal.timeout(8000) });
    const meta = metaTags(await r.text());
    const tm = /^(.*?)\s*#(\d+)/.exec(meta['og:title'] || '');
    if (tm && tm[1]) { info.name = tm[1].trim(); info.number = Number(tm[2]); }
    if (meta['og:image']) info.image = meta['og:image'];
    const parts = String(meta['og:description'] || meta.description || '').split('·').map((x) => x.split(':').slice(1).join(':').trim());
    [info.model, info.backdrop, info.symbol] = [parts[0] || '', parts[1] || '', parts[2] || ''];
  } catch (e) { /* tarmoq xatosi: slug dan olingan ma'lumot qoladi */ }
  return info;
}
// Katalogga qo'shadi yoki yangilaydi. force=true bo'lsa rasm ustidan yoziladi
async function catalogUpsert(name, image, value, force) {
  const ex = await one(CAT_BY_NAME, [name]);
  if (!ex) {
    await run('INSERT INTO gift_values(base_name,value,image) VALUES(?,?,?) ON CONFLICT(base_name) DO NOTHING', [name, value || 0, image || '']);
    return name;
  }
  if (image) {
    await run(force ? 'UPDATE gift_values SET image=? WHERE base_name=?' : "UPDATE gift_values SET image=? WHERE base_name=? AND COALESCE(image,'')=''", [image, ex.n]);
  }
  if (value != null) await run('UPDATE gift_values SET value=? WHERE base_name=?', [value, ex.n]);
  return ex.n;
}
const NFT_SEED = ['LolPop-648', 'Mask-404', 'PreciousPeach-144', 'StarNotepad-520', 'Mask-345', 'ResistanceDog-24'];
async function seedNft() {
  for (const slug of NFT_SEED) {
    const i = await nftInfo(slug);
    await catalogUpsert(i.name, i.image, null, false);
  }
}

/* ---- Gift yordamchilari ---- */
const giftValue = async (base) => { const r = await one(CAT_BY_NAME, [base]); return r ? r.v : 0; };
const giftOf = (id) => (id ? one('SELECT * FROM user_gifts WHERE id=?', [id]) : null);
const getConn = async () => (await kvGet('bc_id')) || process.env.BUSINESS_CONNECTION_ID || '';
let lastConnWarn = 0;

// Narxi ma'lum gift: balansga o'tkazadi (yoki inventarda qoldiradi). { credit, gift } yoki null qaytaradi
function settleGiftDeposit(giftId) {
  return tx(async () => {
    const g = await one("SELECT * FROM user_gifts WHERE id=? AND status IN ('pending','owned') FOR UPDATE", [giftId]);
    if (!g || g.value < 1) return null;
    if (!getS('gift_to_balance')) {
      await run("UPDATE user_gifts SET status='owned' WHERE id=?", [g.id]);
      return { credit: 0, gift: g };
    }
    const credit = Math.floor((g.value * getS('gift_credit_pct')) / 100);
    await run("UPDATE user_gifts SET status='credited' WHERE id=?", [g.id]);
    if (credit > 0) {
      await addBal(g.owner_id, credit, 'gift_deposit', g.id);
      await run('INSERT INTO payments(user_id,amount,charge_id,payload,created_at) VALUES(?,?,?,?,?) ON CONFLICT(charge_id) DO NOTHING',
        [g.owner_id, credit, 'gift:' + g.id, 'gift:' + g.name, now()]);
    }
    return { credit, gift: g };
  });
}
async function lockGift(uid, giftId) {
  const g = await one("SELECT * FROM user_gifts WHERE id=? AND owner_id=? AND status='owned' FOR UPDATE", [giftId, uid]);
  if (!g) fail('Gift topilmadi yoki band');
  if (g.value < 1) fail('Bu giftga narx belgilanmagan (admin belgilaydi)');
  await run("UPDATE user_gifts SET status='bet' WHERE id=?", [g.id]);
  return g;
}
// mult>0: gift sotiladi va narx*mult Stars to'lanadi; mult==0: gift adminga o'tadi
async function resolveGiftStake(gid, uid, stake, mult) {
  if (mult > 0) {
    const win = Math.floor(stake * mult);
    await run("UPDATE user_gifts SET status='sold', lost_at=? WHERE id=?", [now(), gid]);
    if (win > 0) await addBal(uid, win, 'gift_stake_win', gid);
    return { win, lostGift: null };
  }
  await run("UPDATE user_gifts SET status='lost', lost_at=? WHERE id=?", [now(), gid]);
  return { win: 0, lostGift: await giftOf(gid) };
}
async function notifyLost(g, uid) {
  const u = (await one('SELECT first_name,username FROM users WHERE id=?', [uid])) || {};
  const who = u.username ? '@' + u.username : u.first_name;
  await logEvent('gift_lost', uid, { gift_id: g.id, name: g.name, value: g.value });
  ADMIN_IDS.forEach((a) => tell(a, `🎁 Yutqazilgan gift adminga o'tdi: ${g.name} (${g.value}⭐)\nFoydalanuvchi: ${who} (ID ${uid})`));
}

app.get('/api/mygifts', auth, wrap(async (req) => ({
  gifts: await all("SELECT id,name,base_name,value,status,model,backdrop,symbol,number,image,source FROM user_gifts WHERE owner_id=? AND status IN ('owned','bet','pending') ORDER BY id DESC", [req.user.id]),
})));

app.get('/api/giftdeposit', auth, wrap(async () => {
  const relayer = process.env.RELAYER_USERNAME || 'AVTOGIFT';
  return {
    relayer,
    relayer_url: process.env.RELAYER_URL || `${API_BASE}/u/${relayer}`,
    to_balance: !!getS('gift_to_balance'),
    pct: getS('gift_credit_pct'),
    withdraw_fee: getS('gift_withdraw_fee'),
    prices: await all(`SELECT v.base_name n, v.value v, COALESCE(v.image,'') img,
      (SELECT COUNT(*) FROM user_gifts g WHERE lower(g.base_name)=lower(v.base_name)) c
      FROM gift_values v WHERE v.value>0 ORDER BY v.value ASC LIMIT 60`),
  };
}));

app.post('/api/mygifts/:id/sell', auth, wrap((req) => {
  const uid = req.user.id;
  const id = Number(req.params.id);
  return tx(async () => {
    await lockUser(uid);
    const g = await one("SELECT * FROM user_gifts WHERE id=? AND owner_id=? AND status='owned' FOR UPDATE", [id, uid]);
    if (!g) fail('Gift topilmadi yoki band', 404);
    if (g.value < 1) fail('Bu giftga narx belgilanmagan');
    const credit = Math.floor((g.value * getS('gift_credit_pct')) / 100);
    await run("UPDATE user_gifts SET status='sold', lost_at=? WHERE id=?", [now(), g.id]);
    await addBal(uid, credit, 'gift_sell', g.id);
    await run('INSERT INTO payments(user_id,amount,charge_id,payload,created_at) VALUES(?,?,?,?,?) ON CONFLICT(charge_id) DO NOTHING',
      [uid, credit, 'sell:' + g.id, 'gift:' + g.name, now()]);
    return { credit, balance: await getBal(uid) };
  });
}));

const relayerGifts = async (conn) => {
  const out = [];
  let offset;
  for (let page = 0; page < 10; page++) {
    const r = await bot('getBusinessAccountGifts', { business_connection_id: conn, limit: 100, ...(offset ? { offset } : {}) });
    if (!r.ok) return { ok: false, description: r.description };
    const res = r.result || {};
    const list = res.gifts || [];
    out.push(...list);
    if (!res.next_offset || !list.length) break;
    offset = res.next_offset;
  }
  return { ok: true, gifts: out };
};
const stockBase = (x) => { const g = x.gift || x; return g.base_name || g.name || g.title || ''; };
const stockImage = (x) => { const g = x.gift || x; return (g.model && g.model.image_url) || g.preview_url || x.preview_url || ''; };

app.post('/api/mygifts/:id/withdraw', auth, wrap(async (req) => {
  const uid = req.user.id;
  const id = Number(req.params.id);
  let fee = getS('gift_withdraw_fee');
  const g = await tx(async () => {
    await lockUser(uid);
    const row = await one("SELECT * FROM user_gifts WHERE id=? AND owner_id=? AND status='owned' FOR UPDATE", [id, uid]);
    if (!row) fail('Gift topilmadi yoki band', 404);
    if (row.source === 'key') fee = 0; // keys yutug'ini chiqarish bepul
    const conn = row.connection_id || (await getConn());
    if (!conn) {
      if (Date.now() - lastConnWarn > 3600000) {
        lastConnWarn = Date.now();
        ADMIN_IDS.forEach((a) => tell(a, '⚠️ Relayer connection ID topilmadi, giftlarni chiqarib bo\'lmayapti. Render → Environment ga BUSINESS_CONNECTION_ID yozing yoki admin panelda kiriting.'));
      }
      fail('Chiqarish vaqtincha ishlamayapti. Admin xabardor qilindi, keyinroq urinib ko\'ring');
    }
    if ((await getBal(uid)) < fee) fail(`Chiqarish uchun balansda kamida ${fee}⭐ bo'lishi kerak`);
    await debit(uid, fee, 'gift_withdraw_fee', row.id);
    await run("UPDATE user_gifts SET status='withdrawing' WHERE id=?", [row.id]);
    return { ...row, connection_id: conn };
  });
  const undo = async (msg, code) => {
    await tx(async () => {
      await run("UPDATE user_gifts SET status='owned' WHERE id=?", [g.id]);
      if (fee > 0) await addBal(uid, fee, 'gift_withdraw_refund', g.id);
    });
    fail(msg + (fee > 0 ? ' (komissiya qaytarildi)' : ''), code || 502);
  };
  let ownedId = g.owned_gift_id;
  if (!ownedId) {
    // Virtual gift (keys/upgrade yutug'i): @relayer omboridan shu turdagi gift topiladi
    const st = await relayerGifts(g.connection_id);
    if (!st.ok) await undo('Ombor o\'qilmadi: ' + (st.description || 'noma\'lum xato'));
    const used = new Set((await all("SELECT owned_gift_id id FROM user_gifts WHERE status IN ('owned','bet','pending','withdrawing') AND owned_gift_id<>''")).map((x) => x.id));
    const found = st.gifts.find((x) => x.owned_gift_id && !used.has(String(x.owned_gift_id)) && x.can_be_transferred !== false && normName(stockBase(x)) === normName(g.base_name));
    if (!found) await undo('Hozircha omborda bu gift yo\'q, keyinroq urinib ko\'ring yoki admin bilan bog\'laning', 409);
    ownedId = String(found.owned_gift_id);
  }
  const r = await bot('transferGift', { business_connection_id: g.connection_id, owned_gift_id: ownedId, new_owner_chat_id: uid });
  if (!r.ok) await undo('Chiqarib bo\'lmadi: ' + (r.description || 'noma\'lum xato'));
  await run("UPDATE user_gifts SET status='withdrawn', lost_at=?, owned_gift_id=? WHERE id=?", [now(), ownedId, g.id]);
  await logEvent('gift_withdrawn', uid, { gift_id: g.id, name: g.name, fee });
  ADMIN_IDS.forEach((a) => tell(a, `📤 Gift chiqarildi: ${g.name} → ID ${uid} (${fee > 0 ? 'komissiya ' + fee + '⭐' : 'bepul, keys yutug\'i'})`));
  return { balance: await getBal(uid), fee };
}));

/* ---- Rocket (jonli raund) ---- */
const ROCKET_K = 0.18; // o'sish tezligi: koeffitsient = e^(K * soniya)
const rocketMult = (ms) => Math.floor(Math.exp((ROCKET_K * ms) / 1000) * 100) / 100;
const rocketTime = (x) => (Math.log(x) / ROCKET_K) * 1000;
const activeRocket = (uid) => one("SELECT * FROM rocket_bets WHERE user_id=? AND status='active'", [uid]);

app.get('/api/rocket', auth, wrap(async () => {
  const s = allS();
  return { min_bet: s.min_bet, max_bet: s.max_bet, min_target: 1.01, max_target: 1000 };
}));

// mult > 0 — yutuq (shu koeffitsientda yechildi), 0 — portladi
async function settleRocket(r, mult) {
  let win = 0;
  let lostGift = null;
  if (r.gift_id) {
    const x = await resolveGiftStake(r.gift_id, r.user_id, r.bet, mult > 0 ? mult : 0);
    win = x.win; lostGift = x.lostGift;
  } else if (mult > 0) {
    win = Math.floor(r.bet * mult);
    if (win > 0) await addBal(r.user_id, win, 'rocket_win', r.id);
  }
  await run("UPDATE rocket_bets SET status='done', win=? WHERE id=?", [win, r.id]);
  return { win, lostGift };
}
async function finishRocket(r, mult) {
  const s = await tx(async () => {
    await lockUser(r.user_id);
    const cur = await one('SELECT status FROM rocket_bets WHERE id=? FOR UPDATE', [r.id]);
    if (!cur || cur.status !== 'active') return null; // allaqachon yakunlangan
    return settleRocket(r, mult);
  });
  if (!s) return { status: 'none', balance: await getBal(r.user_id) };
  if (s.lostGift) await notifyLost(s.lostGift, r.user_id);
  return { status: mult > 0 ? 'won' : 'lost', mult, win: s.win, crash: r.crash, gift: !!r.gift_id, balance: await getBal(r.user_id) };
}
// Vaqti kelgan bo'lsa (portlash yoki avto-yechish) natijani qaytaradi, aks holda null
function resolveRocket(r) {
  const el = Date.now() - r.started_ms;
  const tgt = r.target || 0;
  if (tgt && r.crash >= tgt && el >= rocketTime(tgt)) return { mult: tgt };
  if (el >= rocketTime(r.crash)) return { mult: 0 };
  return null;
}
function rocketView(r) {
  const el = Date.now() - r.started_ms;
  return { status: 'active', round_id: r.id, elapsed_ms: el, k: ROCKET_K, bet: r.bet, gift: !!r.gift_id, target: r.target || null, mult: rocketMult(el) };
}

app.post('/api/rocket/bet', auth, wrap(async (req) => {
  const uid = req.user.id;
  const raw = req.body.target;
  const target = raw === undefined || raw === null || raw === '' ? 0 : Math.round(Number(raw) * 100) / 100;
  if (target && !(target >= 1.01 && target <= 1000)) fail('Avto yechish koeffitsienti 1.01 dan 1000 gacha bo\'lsin');
  const giftId = Number(req.body.gift_id) || 0;
  const bet = giftId ? 0 : parseBet(req.body.bet);
  const out = await tx(async () => {
    await lockUser(uid);
    const cur = await activeRocket(uid);
    if (cur) return { resumed: true, id: cur.id };
    let stake = bet;
    let gid = null;
    if (giftId) { const g = await lockGift(uid, giftId); stake = g.value; gid = g.id; }
    else await debit(uid, bet, 'rocket_bet');
    const rtp = getS('rocket_rtp') / 100;
    const rnd = crypto.randomInt(0, 1e9) / 1e9;
    const crash = Math.min(1000, Math.max(1, Math.floor((rtp / (1 - rnd)) * 100) / 100));
    const id = await insert('INSERT INTO rocket_bets(user_id,bet,target,crash,win,created_at,status,started_ms,gift_id) VALUES(?,?,?,?,0,?,?,?,?)',
      [uid, stake, target || null, crash, now(), 'active', Date.now(), gid]);
    await addScore(uid, stake);
    return { resumed: false, id };
  });
  const r = await one('SELECT * FROM rocket_bets WHERE id=?', [out.id]);
  return { ...rocketView(r), resumed: out.resumed, balance: await getBal(uid) };
}));

app.get('/api/rocket/state', auth, wrap(async (req) => {
  const r = await activeRocket(req.user.id);
  if (!r) return { status: 'none', balance: await getBal(req.user.id) };
  const res = resolveRocket(r);
  if (res) return finishRocket(r, res.mult);
  return rocketView(r);
}));

app.post('/api/rocket/cashout', auth, wrap(async (req) => {
  const r = await activeRocket(req.user.id);
  if (!r) return { status: 'none', balance: await getBal(req.user.id) };
  const res = resolveRocket(r);
  if (res) return finishRocket(r, res.mult);
  return finishRocket(r, Math.max(1, rocketMult(Date.now() - r.started_ms)));
}));

/* ---- Mines ---- */
const MINES_N = 25;
function minesMult(opened, mines, rtp) {
  if (!opened) return 1;
  let m = 1;
  for (let i = 0; i < opened; i++) m *= (MINES_N - i) / (MINES_N - mines - i);
  return Math.floor(m * rtp) / 100;
}
function minesState(g) {
  const opened = JSON.parse(g.opened);
  const rtp = getS('mines_rtp');
  const m = minesMult(opened.length, g.mines_count, rtp);
  const n = opened.length + 1 <= MINES_N - g.mines_count ? minesMult(opened.length + 1, g.mines_count, rtp) : m;
  return { id: g.id, bet: g.bet, gift: !!g.gift_id, mines_count: g.mines_count, opened, multiplier: m, next: n, win_now: Math.floor(g.bet * m) };
}
function pickMines(c) {
  const a = [...Array(MINES_N).keys()];
  for (let i = MINES_N - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, c);
}
// Qaytaradi: balansga tushgan summa (gift bo'lsa gift sotiladi va narx*x Stars to'lanadi)
async function minesCashout(g) {
  const st = minesState(g);
  await run("UPDATE mines_games SET status='won', win=? WHERE id=?", [st.win_now, g.id]);
  if (g.gift_id) return (await resolveGiftStake(g.gift_id, g.user_id, g.bet, st.multiplier)).win;
  if (st.win_now > 0) await addBal(g.user_id, st.win_now, 'mines_win', g.id);
  return st.win_now;
}

app.post('/api/mines/start', auth, wrap(async (req) => {
  const giftId = Number(req.body.gift_id) || 0;
  const bet = giftId ? 0 : parseBet(req.body.bet);
  const mc = Number(req.body.mines);
  if (!Number.isInteger(mc) || mc < 1 || mc > 24) fail('Minalar soni 1 dan 24 gacha');
  const uid = req.user.id;
  const r = await tx(async () => {
    await lockUser(uid);
    const act = await activeMines(uid);
    if (act) return { resumed: true, game: minesState(act) };
    let stake = bet;
    let gid = null;
    if (giftId) { const g = await lockGift(uid, giftId); stake = g.value; gid = g.id; }
    else await debit(uid, bet, 'mines_bet');
    const id = await insert('INSERT INTO mines_games(user_id,bet,mines_count,mines,created_at,gift_id) VALUES(?,?,?,?,?,?)',
      [uid, stake, mc, JSON.stringify(pickMines(mc)), now(), gid]);
    await addScore(uid, stake);
    return { resumed: false, game: minesState(await one('SELECT * FROM mines_games WHERE id=?', [id])) };
  });
  r.balance = await getBal(uid);
  return r;
}));

app.post('/api/mines/click', auth, wrap(async (req) => {
  const cell = Number(req.body.cell);
  if (!Number.isInteger(cell) || cell < 0 || cell >= MINES_N) fail('Katak noto\'g\'ri');
  const uid = req.user.id;
  const r = await tx(async () => {
    await lockUser(uid);
    const g = await activeMines(uid);
    if (!g) fail('Faol o\'yin yo\'q');
    const mines = JSON.parse(g.mines);
    const opened = JSON.parse(g.opened);
    if (opened.includes(cell)) fail('Bu katak allaqachon ochilgan');
    if (mines.includes(cell)) {
      await run("UPDATE mines_games SET status='lost' WHERE id=?", [g.id]);
      let lg = null;
      if (g.gift_id) {
        await run("UPDATE user_gifts SET status='lost', lost_at=? WHERE id=?", [now(), g.gift_id]);
        lg = await giftOf(g.gift_id);
      }
      return { status: 'lost', mines, cell, gift: !!g.gift_id, _lg: lg };
    }
    opened.push(cell);
    g.opened = JSON.stringify(opened);
    await run('UPDATE mines_games SET opened=? WHERE id=?', [g.opened, g.id]);
    if (opened.length >= MINES_N - g.mines_count) {
      const win = await minesCashout(g);
      return { status: 'won', win, mines, opened, gift: !!g.gift_id };
    }
    return { status: 'safe', game: minesState(g) };
  });
  if (r._lg) { await notifyLost(r._lg, uid); delete r._lg; }
  r.balance = await getBal(uid);
  return r;
}));

app.post('/api/mines/cashout', auth, wrap(async (req) => {
  const uid = req.user.id;
  const r = await tx(async () => {
    await lockUser(uid);
    const g = await activeMines(uid);
    if (!g) fail('Faol o\'yin yo\'q');
    if (JSON.parse(g.opened).length === 0) fail('Avval kamida bitta katakni oching');
    const win = await minesCashout(g);
    return { status: 'won', win, mines: JSON.parse(g.mines), opened: JSON.parse(g.opened), gift: !!g.gift_id };
  });
  r.balance = await getBal(uid);
  return r;
}));

/* ---- PVP duel xonasi: ko'p o'yinchi, 10 soniya, g'ildirak va to'p ---- */
// Barcha PVP amallari bitta advisory lock bilan ketma-ket bajariladi (tartib: pvpLock → lockUser)
const pvpLock = () => D.exec('SELECT pg_advisory_xact_lock(7001)');
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');

async function addEntry(roundId, uid, stake) {
  await run('INSERT INTO pvp_entries(round_id,user_id,stake,created_at,seen) VALUES(?,?,?,?,?)', [roundId, uid, stake, now(), uid === BOT_ID ? 1 : 0]);
  await run('UPDATE pvp_rounds SET total = total + ? WHERE id=?', [stake, roundId]);
}
async function roundPlayers(roundId) {
  const rows = await all(`SELECT e.user_id uid, SUM(e.stake) stake, MIN(e.id) first_id, u.first_name n, u.photo_url p
    FROM pvp_entries e JOIN users u ON u.id=e.user_id WHERE e.round_id=?
    GROUP BY e.user_id, u.first_name, u.photo_url ORDER BY first_id`, [roundId]);
  const total = rows.reduce((a, r) => a + r.stake, 0);
  return rows.map((r) => ({ id: r.uid, name: r.n, photo: r.p, bot: r.uid === BOT_ID, stake: r.stake, pct: total ? Math.round((r.stake / total) * 1000) / 10 : 0 }));
}
async function startCountdownIfReady(roundId) {
  const r = await one('SELECT * FROM pvp_rounds WHERE id=?', [roundId]);
  if (r.status !== 'waiting') return;
  const d = await one('SELECT COUNT(DISTINCT user_id) c FROM pvp_entries WHERE round_id=?', [roundId]);
  if (d.c >= 2) await run("UPDATE pvp_rounds SET status='countdown', start_at=? WHERE id=?", [Date.now() + getS('pvp_countdown') * 1000, roundId]);
}
async function botJoin(roundId) {
  const min = getS('min_bet');
  const max = Math.max(min, Math.min(getS('max_bet'), getS('pvp_bot_max')));
  await addEntry(roundId, BOT_ID, min + crypto.randomInt(0, max - min + 1));
  await startCountdownIfReady(roundId);
}
async function newRound() {
  const seed = crypto.randomBytes(16).toString('hex');
  const roll = parseInt(sha(seed + ':roll').slice(0, 12), 16) / 2 ** 48;
  const id = await insert("INSERT INTO pvp_rounds(status,seed,hash,roll,created_at) VALUES('waiting',?,?,?,?)", [seed, sha(seed), roll, now()]);
  if (getS('pvp_bot')) await botJoin(id);
  return id;
}
const openRound = () => one("SELECT * FROM pvp_rounds WHERE status IN ('waiting','countdown') ORDER BY id DESC LIMIT 1");
async function currentRound() {
  const r = await openRound();
  if (r) return r;
  return tx(async () => {
    await pvpLock();
    let x = await openRound();
    if (!x) { await newRound(); x = await openRound(); }
    return x;
  });
}
async function finishRound(r) {
  const players = await roundPlayers(r.id);
  const total = players.reduce((a, p) => a + p.stake, 0);
  if (players.length < 2) { // raqib yo'q: stavkalar qaytariladi
    for (const p of players) if (p.id !== BOT_ID) await addBal(p.id, p.stake, 'pvp_refund', r.id);
    await run("UPDATE pvp_rounds SET status='cancelled', finished_at=? WHERE id=?", [now(), r.id]);
    return null;
  }
  const t = r.roll * total;
  let cum = 0;
  let winner = players[players.length - 1];
  for (const p of players) { cum += p.stake; if (t < cum) { winner = p; break; } }
  const payout = Math.floor(total * (1 - getS('pvp_fee') / 100));
  if (winner.id !== BOT_ID) await addBal(winner.id, payout, 'pvp_win', r.id);
  await run("UPDATE pvp_rounds SET status='done', winner_id=?, payout=?, total=?, finished_at=? WHERE id=?", [winner.id, payout, total, now(), r.id]);
  await run('UPDATE pvp_entries SET seen=0 WHERE round_id=? AND user_id>0', [r.id]);
  return { winner, payout, players };
}
async function pvpTick() {
  // Oldindan yengil tekshiruv (blokirovkasiz): harakat kerak bo'lmasa tranzaksiya ochilmaydi
  const pre = await openRound();
  const needBot = pre && pre.status === 'waiting' && getS('pvp_bot')
    && !(await one('SELECT 1 FROM pvp_entries WHERE round_id=? AND user_id=?', [pre.id, BOT_ID]));
  const due = pre && pre.status === 'countdown' && Date.now() >= pre.start_at;
  if (pre && !needBot && !due) return;

  let res = null;
  let finished = null;
  await tx(async () => {
    await pvpLock();
    const r = await openRound();
    if (!r) { await newRound(); return; }
    if (r.status === 'waiting' && getS('pvp_bot') && !(await one('SELECT 1 FROM pvp_entries WHERE round_id=? AND user_id=?', [r.id, BOT_ID]))) await botJoin(r.id);
    const cur = await openRound();
    if (cur.status === 'countdown' && Date.now() >= cur.start_at) {
      res = await finishRound(cur);
      finished = cur;
      await newRound();
    }
  });
  if (res && res.winner.id !== BOT_ID) tell(res.winner.id, `🏆 PVP #${finished.id}: siz yutdingiz! +${res.payout}⭐`);
}
async function roundState(id) {
  const r = await one('SELECT * FROM pvp_rounds WHERE id=?', [id]);
  const players = await roundPlayers(id);
  return { id, status: r.status, hash: r.hash, start_at: r.start_at, total: players.reduce((a, p) => a + p.stake, 0), players };
}
async function roundView(r, viewerId) {
  const players = await roundPlayers(r.id);
  const winner = players.find((p) => p.id === r.winner_id) || players[0];
  return {
    id: r.id, hash: r.hash, seed: r.seed, roll: r.roll, total: r.total, payout: r.payout, players, winner,
    finished_ago: Math.max(0, now() - (r.finished_at || now())),
    mine: players.some((p) => p.id === viewerId), won: r.winner_id === viewerId,
  };
}

app.get('/api/pvp', auth, wrap(async (req) => {
  await pvpTick();
  const uid = req.user.id;
  const cur = await currentRound();
  const last = await one("SELECT * FROM pvp_rounds WHERE status='done' ORDER BY id DESC LIMIT 1");
  const top = await one(`SELECT r.payout p, u.first_name n FROM pvp_rounds r JOIN users u ON u.id=r.winner_id
    WHERE r.status='done' ORDER BY r.payout DESC LIMIT 1`);
  const unseen = await one(`SELECT r.* FROM pvp_rounds r WHERE r.status='done'
    AND EXISTS(SELECT 1 FROM pvp_entries e WHERE e.round_id=r.id AND e.user_id=? AND e.seen=0) ORDER BY r.id LIMIT 1`, [uid]);
  let play = null;
  if (unseen) play = await roundView(unseen, uid);
  else if (last && now() - last.finished_at <= 12) play = await roundView(last, uid);
  const s = allS();
  return {
    now: Date.now(), round: await roundState(cur.id), top: top || null, last: last ? await roundView(last, uid) : null, play,
    fee: s.pvp_fee, min_bet: s.min_bet, max_bet: s.max_bet, countdown: s.pvp_countdown, bot: !!s.pvp_bot,
  };
}));

app.post('/api/pvp/bet', auth, wrap(async (req) => {
  await pvpTick();
  const uid = req.user.id;
  const stake = parseBet(req.body.stake);
  const rid = await tx(async () => {
    await pvpLock();
    await lockUser(uid);
    const r = await currentRound();
    if (r.status === 'countdown' && Date.now() >= r.start_at) fail('Raund boshlandi. Keyingi raundni kuting');
    await debit(uid, stake, 'pvp_bet', r.id);
    await addEntry(r.id, uid, stake);
    await addScore(uid, stake);
    await startCountdownIfReady(r.id);
    return r.id;
  });
  return { round: await roundState(rid), balance: await getBal(uid) };
}));

app.post('/api/pvp/cancel', auth, wrap((req) => {
  const uid = req.user.id;
  return tx(async () => {
    await pvpLock();
    await lockUser(uid);
    const r = await currentRound();
    if (r.status !== 'waiting') fail('Raund boshlangan, bekor qilib bo\'lmaydi');
    const mine = (await one('SELECT COALESCE(SUM(stake),0) s FROM pvp_entries WHERE round_id=? AND user_id=?', [r.id, uid])).s;
    if (!mine) fail('Bu raundda stavkangiz yo\'q', 404);
    await run('DELETE FROM pvp_entries WHERE round_id=? AND user_id=?', [r.id, uid]);
    await run('UPDATE pvp_rounds SET total = total - ? WHERE id=?', [mine, r.id]);
    await addBal(uid, mine, 'pvp_cancel', r.id);
    return { balance: await getBal(uid) };
  });
}));

app.post('/api/pvp/:id/seen', auth, wrap(async (req) => {
  await run('UPDATE pvp_entries SET seen=1 WHERE round_id=? AND user_id=?', [Number(req.params.id), req.user.id]);
}));

/* ---- UPGRADE: gift/Stars bilan qimmatroq giftga aylantirish ---- */
const upgradeCatalog = () => all("SELECT base_name n, value v, COALESCE(image,'') img FROM gift_values WHERE value>0 ORDER BY value ASC");
app.get('/api/upgrade', auth, wrap(async () => ({ rtp: getS('upgrade_rtp'), catalog: await upgradeCatalog() })));
app.post('/api/upgrade', auth, wrap(async (req) => {
  const uid = req.user.id;
  const tname = String(req.body.target || '');
  const giftId = Number(req.body.gift_id) || 0;
  const bet = giftId ? 0 : parseBet(req.body.bet);
  const out = await tx(async () => {
    await lockUser(uid);
    const t = await one("SELECT base_name n, value v, COALESCE(image,'') img FROM gift_values WHERE lower(base_name)=lower(?) AND value>0", [tname]);
    if (!t) fail('Orzu gifti topilmadi', 404);
    let stake = bet;
    let gid = null;
    if (giftId) { const g = await lockGift(uid, giftId); stake = g.value; gid = g.id; }
    else await debit(uid, bet, 'upgrade_bet');
    if (stake >= t.v) fail('Orzu gifti stavkadan qimmatroq bo\'lishi kerak');
    const chance = Math.floor((stake / t.v) * getS('upgrade_rtp') * 100) / 10000;
    if (chance < 0.01) fail('Shans 1% dan past. Qimmatroq stavka yoki arzonroq gift tanlang');
    const roll = crypto.randomInt(0, 1e9) / 1e9;
    const win = roll < chance;
    let lostGift = null;
    if (gid) {
      if (win) await run("UPDATE user_gifts SET status='sold', lost_at=? WHERE id=?", [now(), gid]);
      else { await run("UPDATE user_gifts SET status='lost', lost_at=? WHERE id=?", [now(), gid]); lostGift = await giftOf(gid); }
    }
    let newId = null;
    if (win) {
      newId = await insert('INSERT INTO user_gifts(owner_id,owned_gift_id,connection_id,base_name,name,value,status,created_at,image) VALUES(?,?,?,?,?,?,?,?,?)',
        [uid, '', '', t.n, t.n, t.v, 'owned', now(), t.img]);
    }
    await addScore(uid, stake);
    await run('INSERT INTO upgrade_games(user_id,stake,target,target_value,chance,roll,win,gift_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [uid, stake, t.n, t.v, chance, roll, win ? 1 : 0, gid, now()]);
    return { win, chance, roll, target: t, gift: !!gid, new_gift_id: newId, lostGift };
  });
  if (out.lostGift) { await notifyLost(out.lostGift, uid); delete out.lostGift; }
  if (out.win) ADMIN_IDS.forEach((a) => tell(a, `⬆️ Upgrade yutuq: ID ${uid} → ${out.target.n} (${out.target.v}⭐). Jismoniy chiqarish kerak bo'lsa, qo'lda yuboring.`));
  out.balance = await getBal(uid);
  return out;
}));

/* ---- PLINKO ---- */
const PLINKO_ROWS = [8, 10, 12, 14, 16];
const PLINKO_K = { low: 2.0, mid: 3.4, high: 5.2 };
// Koeffitsientlar shunday masshtablanadiki, o'rtacha qaytish = plinko_rtp %
function plinkoTable(rows, risk, rtp) {
  const k = PLINKO_K[risk];
  const bin = (n, i) => { let r = 1; for (let j = 1; j <= i; j++) r = (r * (n - j + 1)) / j; return r; };
  const probs = [];
  const shape = [];
  for (let i = 0; i <= rows; i++) {
    probs.push(bin(rows, i) / 2 ** rows);
    shape.push(Math.exp((k * Math.abs(i - rows / 2)) / (rows / 2)));
  }
  const ev = probs.reduce((sum, p, i) => sum + p * shape[i], 0);
  const scale = rtp / 100 / ev;
  return shape.map((x) => Math.floor(x * scale * 100) / 100);
}
app.get('/api/plinko', auth, wrap(async () => {
  const rtp = getS('plinko_rtp');
  const s = allS();
  const tables = {};
  PLINKO_ROWS.forEach((r) => {
    tables[r] = {};
    Object.keys(PLINKO_K).forEach((k) => { tables[r][k] = plinkoTable(r, k, rtp); });
  });
  return { rows: PLINKO_ROWS, tables, min_bet: s.min_bet, max_bet: s.max_bet };
}));
app.post('/api/plinko/drop', auth, wrap(async (req) => {
  const rows = Number(req.body.rows);
  const risk = String(req.body.risk || 'mid');
  if (!PLINKO_ROWS.includes(rows)) fail('Qatorlar soni noto\'g\'ri');
  if (!PLINKO_K[risk]) fail('Xavf darajasi noto\'g\'ri');
  const giftId = Number(req.body.gift_id) || 0;
  const bet = giftId ? 0 : parseBet(req.body.bet);
  const uid = req.user.id;
  const out = await tx(async () => {
    await lockUser(uid);
    let stake = bet;
    let gid = null;
    if (giftId) { const g = await lockGift(uid, giftId); stake = g.value; gid = g.id; }
    else await debit(uid, bet, 'plinko_bet');
    const path = Array.from({ length: rows }, () => crypto.randomInt(0, 2));
    const slot = path.reduce((a, b) => a + b, 0);
    const mult = plinkoTable(rows, risk, getS('plinko_rtp'))[slot];
    let win = 0;
    let lostGift = null;
    if (gid) { const x = await resolveGiftStake(gid, uid, stake, mult); win = x.win; lostGift = x.lostGift; }
    else { win = Math.floor(stake * mult); if (win > 0) await addBal(uid, win, 'plinko_win'); }
    await run('INSERT INTO plinko_games(user_id,bet,rows,risk,slot,mult,win,gift_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      [uid, stake, rows, risk, slot, mult, win, gid, now()]);
    await addScore(uid, stake);
    return { path, slot, mult, win, gift: !!gid, lostGift };
  });
  if (out.lostGift) { await notifyLost(out.lostGift, uid); delete out.lostGift; }
  out.balance = await getBal(uid);
  return out;
}));

/* ---- Promo kod ---- */
const promoFails = new Map();
app.post('/api/promo/redeem', auth, wrap(async (req) => {
  const uid = req.user.id;
  const f = promoFails.get(uid);
  if (f && f.n >= 8 && Date.now() - f.t < 600000) fail('Juda ko\'p urinish. 10 daqiqadan keyin qayta urinib ko\'ring', 429);
  const bad = (msg) => {
    const x = promoFails.get(uid);
    promoFails.set(uid, { n: x && Date.now() - x.t < 600000 ? x.n + 1 : 1, t: Date.now() });
    fail(msg);
  };
  const code = String(req.body.code || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!code || code.length > 32) bad('Promo kodni kiriting');
  const out = await tx(async () => {
    await lockUser(uid);
    const p = await one('SELECT * FROM promo_codes WHERE code=? FOR UPDATE', [code]);
    if (!p || !p.active) bad('Bunday promo kod topilmadi');
    if (p.expires_at > 0 && now() > p.expires_at) bad('Promo kod muddati tugagan');
    if (p.max_uses > 0 && p.used >= p.max_uses) bad('Promo kod limiti tugagan');
    if (await one('SELECT 1 FROM promo_uses WHERE code=? AND user_id=?', [code, uid])) fail('Siz bu promo koddan allaqachon foydalangansiz');
    let gift = null;
    if (p.gift_name) {
      const cat = await one(`${CAT_BY_NAME} AND value>0`, [p.gift_name]);
      if (cat) {
        await run("INSERT INTO user_gifts(owner_id,owned_gift_id,connection_id,base_name,name,value,status,created_at,image,source) VALUES(?,?,?,?,?,?,?,?,?,'promo')",
          [uid, '', '', cat.n, cat.n, cat.v, 'owned', now(), cat.img]);
        gift = { name: cat.n, value: cat.v, image: cat.img };
      }
    }
    if (p.stars > 0) {
      await addBal(uid, p.stars, 'promo', code);
      await run('INSERT INTO payments(user_id,amount,charge_id,payload,created_at) VALUES(?,?,?,?,?) ON CONFLICT(charge_id) DO NOTHING',
        [uid, p.stars, `promo:${code}:${uid}`, 'promo:' + code, now()]);
    }
    await run('INSERT INTO promo_uses(code,user_id,created_at) VALUES(?,?,?)', [code, uid, now()]);
    await run('UPDATE promo_codes SET used = used + 1 WHERE code=?', [code]);
    return { stars: p.stars, gift, balance: await getBal(uid) };
  });
  promoFails.delete(uid);
  return out;
}));

/* ---- Leaderboard / tarix ---- */
app.get('/api/leaderboard', auth, wrap(async (req) => {
  const top = await all(`SELECT u.first_name n, u.username un, c.score s FROM contest_scores c
    JOIN users u ON u.id=c.user_id ORDER BY c.score DESC LIMIT 20`);
  const me = await one('SELECT score FROM contest_scores WHERE user_id=?', [req.user.id]);
  return { top, my_score: me ? me.score : 0, prize: getS('contest_prize') };
}));

app.get('/api/history', auth, wrap(async (req) => {
  const uid = req.user.id;
  const [payments, rocket, upgrade, plinko, mines] = await Promise.all([
    all('SELECT amount, created_at FROM payments WHERE user_id=? ORDER BY id DESC LIMIT 15', [uid]),
    all("SELECT bet,target,crash,win,created_at FROM rocket_bets WHERE user_id=? AND status='done' ORDER BY id DESC LIMIT 10", [uid]),
    all('SELECT stake,target,chance,win,created_at FROM upgrade_games WHERE user_id=? ORDER BY id DESC LIMIT 10', [uid]),
    all('SELECT bet,rows,risk,mult,win,created_at FROM plinko_games WHERE user_id=? ORDER BY id DESC LIMIT 10', [uid]),
    all("SELECT bet,mines_count,win,status,created_at FROM mines_games WHERE user_id=? AND status!='active' ORDER BY id DESC LIMIT 10", [uid]),
  ]);
  return { payments, rocket, upgrade, plinko, mines };
}));

/* ---- Stars bilan balans to'ldirish ---- */
app.post('/api/topup/link', auth, wrap(async (req) => {
  const amount = Number(req.body.amount);
  if (!Number.isInteger(amount) || amount < 1 || amount > 10000) fail('Summa 1 dan 10000 gacha bo\'lsin');
  const r = await bot('createInvoiceLink', {
    title: 'Balans to\'ldirish',
    description: `Epic Gift balansiga ${amount} Stars`,
    payload: `topup:${req.user.id}:${amount}`,
    currency: 'XTR',
    prices: [{ label: `${amount} Stars`, amount }],
  });
  if (!r.ok) fail('Hisob-faktura yaratib bo\'lmadi: ' + (r.description || ''), 502);
  return { link: r.result };
}));

/* ===================== ADMIN ===================== */
const ADMIN = express.Router();
ADMIN.use(auth, adminOnly);

ADMIN.get('/data', wrap(async () => {
  const keyRows = await all('SELECT * FROM keys_items ORDER BY id');
  const keys = [];
  for (const k of keyRows) keys.push({ ...k, rewards: await all('SELECT id,name,value,chance FROM key_rewards WHERE key_id=?', [k.id]) });
  const stockRaw = await kvGet('stock_json');
  let stock = {};
  try { stock = JSON.parse(stockRaw || '{}'); } catch (e) { /* bo'sh */ }
  return {
    settings: allS(),
    keys,
    gifts: await all('SELECT * FROM gifts ORDER BY id'),
    contest: await all(`SELECT u.id uid, u.first_name n, u.username un, c.score s FROM contest_scores c
      JOIN users u ON u.id=c.user_id ORDER BY c.score DESC LIMIT 10`),
    users: (await one('SELECT COUNT(*) c FROM users WHERE id>0')).c,
    promos: await all('SELECT code,stars,gift_name,max_uses,used,expires_at FROM promo_codes ORDER BY created_at DESC LIMIT 50'),
    bc_id: await getConn(),
    bc_env: !!process.env.BUSINESS_CONNECTION_ID,
    stock,
    gift_types: await all(`SELECT v.base_name b, v.value v, COALESCE(v.image,'') img,
      (SELECT COUNT(*) FROM user_gifts g WHERE g.base_name=v.base_name) c FROM gift_values v ORDER BY v.value`),
    lost: await all(`SELECT g.id, g.name, g.value, g.lost_at, g.status, u.first_name n FROM user_gifts g
      JOIN users u ON u.id=g.owner_id WHERE g.status IN ('lost','sold','taken') ORDER BY g.lost_at DESC NULLS LAST LIMIT 30`),
  };
}));

// Balans harakatlari tarixi (audit): ?user_id=123&limit=100
ADMIN.get('/balance-log', wrap(async (req) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const uid = Number(req.query.user_id);
  const rows = Number.isInteger(uid) && req.query.user_id
    ? await all('SELECT * FROM balance_log WHERE user_id=? ORDER BY id DESC LIMIT ?', [uid, limit])
    : await all('SELECT * FROM balance_log ORDER BY id DESC LIMIT ?', [limit]);
  return { rows };
}));

ADMIN.post('/settings', wrap(async (req) => {
  const b = req.body || {};
  const cur = allS();
  for (const k of Object.keys(DEFAULTS)) {
    if (!(k in b)) continue;
    const v = Number(b[k]);
    if (!Number.isFinite(v) || v < 0) fail(`${k} noto'g'ri`);
    if (['rocket_rtp', 'mines_rtp', 'plinko_rtp', 'upgrade_rtp'].includes(k) && (v < 1 || v > 100)) fail('RTP 1 dan 100 gacha bo\'lsin');
    if (k === 'key_nft_mult' && v > 1) fail('Koeffitsient 0 dan 1 gacha bo\'lsin');
    if (k === 'key_nft_min' && (!Number.isInteger(v) || v < 1)) fail('Qimmat gift chegarasi butun son (>=1) bo\'lsin');
    if (k === 'pvp_countdown' && (!Number.isInteger(v) || v < 3 || v > 120)) fail('Hisoblagich 3 dan 120 soniyagacha bo\'lsin');
    if (k === 'pvp_bot_max' && (!Number.isInteger(v) || v < 1)) fail('Bot stavkasi butun son (>=1) bo\'lsin');
    if (k === 'gift_withdraw_fee' && !Number.isInteger(v)) fail('Chiqarish komissiyasi butun son bo\'lsin');
    if ((k === 'min_bet' || k === 'max_bet') && (!Number.isInteger(v) || v < 1)) fail('Stavka butun son (>=1) bo\'lsin');
    cur[k] = v;
  }
  if (cur.pvp_fee > 50) fail('PVP komissiya 50% dan oshmasin');
  if (cur.gift_to_balance !== 0 && cur.gift_to_balance !== 1) fail('gift_to_balance 0 yoki 1 bo\'lsin');
  if (cur.pvp_bot !== 0 && cur.pvp_bot !== 1) fail('pvp_bot 0 yoki 1 bo\'lsin');
  if (cur.gift_credit_pct < 1 || cur.gift_credit_pct > 100) fail('Gift foizi 1 dan 100 gacha bo\'lsin');
  if (cur.min_bet > cur.max_bet) fail('Minimal stavka maksimaldan katta bo\'lmasin');
  await tx(async () => { for (const k of Object.keys(DEFAULTS)) await run('UPDATE settings SET value=? WHERE key=?', [String(cur[k]), k]); });
  await loadSettings();
  await auditAdmin(req.user.id, 'settings', b);
  return { settings: allS() };
}));

function cleanRewards(r) {
  if (!Array.isArray(r) || !r.length) fail('Kamida bitta mukofot kerak');
  return r.map((x) => {
    const value = Number(x.value);
    const chance = Number(x.chance);
    if (!x.name || !Number.isInteger(value) || value < 0 || !(chance > 0)) fail('Mukofot ma\'lumoti noto\'g\'ri');
    return { name: String(x.name).slice(0, 40), value, chance };
  });
}
function cleanKey(b) {
  const cd = Number(b.cooldown_hours) || 0;
  if (!Number.isInteger(cd) || cd < 0 || cd > 720) fail('Bepul oraliq soatlarda (0 dan 720 gacha) bo\'lsin');
  const price = cd > 0 ? 0 : Number(b.price);
  if (!b.name || !Number.isInteger(price) || price < (cd > 0 ? 0 : 1)) fail('Key nomi va narxi (butun son) kerak');
  return { name: String(b.name).slice(0, 40), emoji: String(b.emoji || '🔑').slice(0, 8), price, cd, rewards: cleanRewards(b.rewards) };
}
async function saveRewards(keyId, rewards) {
  await run('DELETE FROM key_rewards WHERE key_id=?', [keyId]);
  for (const r of rewards) await run('INSERT INTO key_rewards(key_id,name,value,chance) VALUES(?,?,?,?)', [keyId, r.name, r.value, r.chance]);
}

ADMIN.post('/keys', wrap(async (req) => {
  const k = cleanKey(req.body || {});
  const out = await tx(async () => {
    const id = await insert('INSERT INTO keys_items(name,emoji,price,cooldown_hours) VALUES(?,?,?,?)', [k.name, k.emoji, k.price, k.cd]);
    await saveRewards(id, k.rewards);
    return { id };
  });
  await auditAdmin(req.user.id, 'key_create', { id: out.id, name: k.name });
  return out;
}));
ADMIN.put('/keys/:id', wrap(async (req) => {
  const id = Number(req.params.id);
  const k = cleanKey(req.body || {});
  const active = req.body.active === 0 || req.body.active === false ? 0 : 1;
  await tx(async () => {
    const r = await run('UPDATE keys_items SET name=?,emoji=?,price=?,cooldown_hours=?,active=? WHERE id=?', [k.name, k.emoji, k.price, k.cd, active, id]);
    if (!r.changes) fail('Key topilmadi', 404);
    await saveRewards(id, k.rewards);
  });
  await auditAdmin(req.user.id, 'key_update', { id, name: k.name });
}));
ADMIN.delete('/keys/:id', wrap(async (req) => {
  const id = Number(req.params.id);
  await tx(async () => {
    await run('DELETE FROM key_rewards WHERE key_id=?', [id]);
    await run('DELETE FROM keys_items WHERE id=?', [id]);
  });
  await auditAdmin(req.user.id, 'key_delete', { id });
}));

function cleanGift(b) {
  const price = Number(b.price);
  if (!b.name || !Number.isInteger(price) || price < 1) fail('Gift nomi va narxi (butun son) kerak');
  return { name: String(b.name).slice(0, 40), emoji: String(b.emoji || '🎁').slice(0, 8), price };
}
ADMIN.post('/gifts', wrap(async (req) => {
  const g = cleanGift(req.body || {});
  const id = await insert('INSERT INTO gifts(name,emoji,price) VALUES(?,?,?)', [g.name, g.emoji, g.price]);
  await auditAdmin(req.user.id, 'gift_create', { id, ...g });
  return { id };
}));
ADMIN.put('/gifts/:id', wrap(async (req) => {
  const g = cleanGift(req.body || {});
  const active = req.body.active === 0 || req.body.active === false ? 0 : 1;
  const r = await run('UPDATE gifts SET name=?,emoji=?,price=?,active=? WHERE id=?', [g.name, g.emoji, g.price, active, Number(req.params.id)]);
  if (!r.changes) fail('Gift topilmadi', 404);
  await auditAdmin(req.user.id, 'gift_update', { id: Number(req.params.id), ...g, active });
}));
ADMIN.delete('/gifts/:id', wrap(async (req) => {
  await run('DELETE FROM gifts WHERE id=?', [Number(req.params.id)]);
  await auditAdmin(req.user.id, 'gift_delete', { id: Number(req.params.id) });
}));

ADMIN.post('/contest/finish', wrap(async (req) => {
  const prize = getS('contest_prize');
  const res = await tx(async () => {
    await D.exec('SELECT pg_advisory_xact_lock(7002)');
    const top = await one(`SELECT u.id uid, u.first_name n, c.score s FROM contest_scores c
      JOIN users u ON u.id=c.user_id ORDER BY c.score DESC LIMIT 1`);
    if (!top) fail('Konkursda ishtirokchi yo\'q');
    await addBal(top.uid, prize, 'contest_prize');
    await run('DELETE FROM contest_scores');
    return top;
  });
  await auditAdmin(req.user.id, 'contest_finish', { winner: res.uid, score: res.s, prize });
  await tell(res.uid, `🏆 Tabriklaymiz! Siz konkursda g'olib bo'ldingiz va ${prize}⭐ yutib oldingiz!`);
  return { winner: { id: res.uid, name: res.n, score: res.s }, prize };
}));

ADMIN.post('/balance', wrap(async (req) => {
  const uid = Number(req.body.user_id);
  const amount = Number(req.body.amount);
  if (!Number.isInteger(uid) || !Number.isInteger(amount) || amount === 0) fail('Foydalanuvchi ID va summa (butun son) kerak');
  await tx(async () => {
    const u = await one('SELECT balance FROM users WHERE id=? FOR UPDATE', [uid]);
    if (!u) fail('Foydalanuvchi topilmadi', 404);
    if (amount < 0 && u.balance + amount < 0) fail('Balans manfiy bo\'lib qoladi');
    await addBal(uid, amount, 'admin_adjust', req.user.id);
  });
  await auditAdmin(req.user.id, 'balance', { user_id: uid, amount });
  await tell(uid, amount > 0 ? `🎁 Balansingizga +${amount}⭐ qo'shildi.` : `Balansingizdan ${-amount}⭐ ayirildi.`);
  return { balance: await getBal(uid) };
}));

ADMIN.post('/giftvalue', wrap(async (req) => {
  const base = String(req.body.base_name || '').trim().slice(0, 80);
  const value = Number(req.body.value);
  const image = String(req.body.image || '').trim().slice(0, 500);
  if (!base || !Number.isInteger(value) || value < 0) fail('Gift nomi va qiymati (butun son) kerak');
  const pend = await tx(async () => {
    const ex = await one('SELECT base_name FROM gift_values WHERE lower(base_name)=lower(?)', [base]);
    const key = ex ? ex.base_name : base;
    await run("INSERT INTO gift_values(base_name,value,image) VALUES(?,?,?) ON CONFLICT(base_name) DO UPDATE SET value=excluded.value, image=CASE WHEN excluded.image<>'' THEN excluded.image ELSE gift_values.image END", [key, value, image]);
    await run("UPDATE user_gifts SET value=? WHERE base_name=? AND status IN ('owned','pending')", [value, key]);
    return all("SELECT id FROM user_gifts WHERE base_name=? AND status='pending'", [key]);
  });
  await auditAdmin(req.user.id, 'giftvalue', { base, value });
  let credited = 0;
  if (value > 0) {
    for (const p of pend) {
      const r = await settleGiftDeposit(p.id);
      if (r) {
        credited++;
        await tell(r.gift.owner_id, r.credit > 0
          ? `✅ Giftingiz (${r.gift.name}) hisoblandi: balansingizga +${r.credit}⭐ tushdi.`
          : `🎁 Giftingiz (${r.gift.name}) narxi belgilandi: ${value}⭐. Backpack'da tikish, sotish yoki chiqarish mumkin.`);
      }
    }
  }
  return { credited };
}));

ADMIN.post('/lostgifts/:id/transfer', wrap(async (req) => {
  const g = await one("SELECT * FROM user_gifts WHERE id=? AND status IN ('lost','sold')", [Number(req.params.id)]);
  if (!g) fail('Gift topilmadi', 404);
  if (!g.connection_id || !g.owned_gift_id) fail('Bu gift uchun ulanish ma\'lumoti yo\'q, qo\'lda oling');
  const r = await bot('transferGift', { business_connection_id: g.connection_id, owned_gift_id: g.owned_gift_id, new_owner_chat_id: req.user.id });
  if (!r.ok) fail('O\'tkazib bo\'lmadi: ' + (r.description || ''), 502);
  await run("UPDATE user_gifts SET status='taken' WHERE id=?", [g.id]);
  await auditAdmin(req.user.id, 'lostgift_transfer', { gift_id: g.id, name: g.name });
}));

ADMIN.post('/promos', wrap(async (req) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const stars = Number(req.body.stars) || 0;
  const maxUses = Number(req.body.max_uses) || 0;
  const hours = Number(req.body.expire_hours) || 0;
  const giftName = String(req.body.gift_name || '').trim().slice(0, 80);
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) fail('Kod 3-32 belgi: lotin harf, raqam, - yoki _');
  if (!Number.isInteger(stars) || stars < 0 || !Number.isInteger(maxUses) || maxUses < 0 || !Number.isInteger(hours) || hours < 0) fail('Stars, limit va muddat butun son bo\'lsin');
  if (!stars && !giftName) fail('Stars yoki gift kiriting');
  if (giftName && !(await one(`${CAT_BY_NAME} AND value>0`, [giftName]))) fail('Gift katalogda topilmadi yoki narxsiz');
  if (await one('SELECT 1 FROM promo_codes WHERE code=?', [code])) fail('Bu kod allaqachon mavjud');
  await run('INSERT INTO promo_codes(code,stars,gift_name,max_uses,expires_at,created_at) VALUES(?,?,?,?,?,?)',
    [code, stars, giftName, maxUses, hours > 0 ? now() + hours * 3600 : 0, now()]);
  await auditAdmin(req.user.id, 'promo_create', { code, stars, giftName, maxUses, hours });
  return { code };
}));
ADMIN.delete('/promos/:code', wrap(async (req) => {
  await run('DELETE FROM promo_codes WHERE code=?', [String(req.params.code).toUpperCase()]);
  await auditAdmin(req.user.id, 'promo_delete', { code: req.params.code });
}));
ADMIN.post('/connection', wrap(async (req) => {
  const id = String(req.body.id || '').trim().slice(0, 120);
  if (!id) fail('Connection ID ni kiriting');
  await kvSet('bc_id', id);
  await auditAdmin(req.user.id, 'connection', { id });
  return { id };
}));

ADMIN.post('/nftlinks', wrap(async (req) => {
  const raw = Array.isArray(req.body.links) ? req.body.links : String(req.body.links || '').split(/[\s,]+/);
  const slugs = [...new Set(raw.map(slugOf).filter(Boolean))].slice(0, 30);
  if (!slugs.length) fail(`To'g'ri NFT havolasi topilmadi (masalan ${NFT_BASE}/LolPop-648)`);
  const price = req.body.price === undefined || req.body.price === '' ? null : Number(req.body.price);
  if (price !== null && (!Number.isInteger(price) || price < 0)) fail('Narx butun son bo\'lsin');
  const added = [];
  for (const slug of slugs) {
    const i = await nftInfo(slug);
    const name = await catalogUpsert(i.name, i.image, price, true);
    added.push({ name, image: i.image, model: i.model, backdrop: i.backdrop, symbol: i.symbol, number: i.number });
  }
  await auditAdmin(req.user.id, 'nftlinks', { slugs, price });
  return { added };
}));

ADMIN.post('/syncstock', wrap(async () => {
  const conn = await getConn();
  if (!conn) fail('Relayer ulanishi hali kelmagan (business_connection). @PaxtaFather → /setrelayer ni qayta bajaring');
  const st = await relayerGifts(conn);
  if (!st.ok) fail('Ombor o\'qilmadi: ' + (st.description || 'noma\'lum xato'), 502);
  const counts = {};
  for (const x of st.gifts) {
    const base = stockBase(x);
    if (!base) continue;
    const name = await catalogUpsert(base.includes(' ') ? base : spaced(base), stockImage(x), null, false);
    counts[normName(name)] = (counts[normName(name)] || 0) + 1;
  }
  await kvSet('stock_json', JSON.stringify(counts));
  return { total: st.gifts.length, types: Object.keys(counts).length, counts };
}));

app.use('/api/admin', ADMIN);
app.use('/api', (req, res) => res.status(404).json({ error: 'Topilmadi' }));

/* ===================== BOT: UPDATE'LAR ===================== */
function parseGift(m) {
  const raw = m.unique_gift || m.gift;
  if (!raw) return null;
  const inner = raw.gift || raw;
  const base = String(inner.base_name || inner.name || inner.title || 'Gift').slice(0, 80);
  const name = String(inner.name || base).slice(0, 80);
  const star = Number(raw.star_count || inner.star_count || inner.stars || 0) || 0;
  const ownedId = String(m.owned_gift_id || raw.owned_gift_id || '');
  const nm = (o) => (o && typeof o === 'object' ? String(o.name || '') : String(o || '')).slice(0, 60);
  const slug = /^[A-Za-z0-9_]+-\d+$/.test(String(inner.name || '')) ? inner.name : '';
  const image = String((inner.model && inner.model.image_url) || inner.preview_url || raw.preview_url || inner.image_url || (slug ? `${NFT_BASE}/${slug}.png` : '')).slice(0, 500);
  const number = Number(inner.number) || null;
  return { base, name: number && !/#\d+$/.test(name) && slug ? `${base} #${number}` : name, star, ownedId, model: nm(inner.model), backdrop: nm(inner.backdrop), symbol: nm(inner.symbol), number, image };
}

async function onGift(m) {
  console.log('[gift] kelgan xabar:', JSON.stringify(m).slice(0, 900));
  const gft = parseGift(m);
  if (!gft) return;
  if (String(m.from.id) === (await kvGet('relayer_id'))) return; // relayer akkauntning o'z xabari
  await ensureUser(m.from);
  if (gft.ownedId && (await one('SELECT 1 FROM user_gifts WHERE owned_gift_id=?', [gft.ownedId]))) return;
  const ex = await one(CAT_BY_NAME, [gft.base]);
  const key = ex ? ex.n : gft.base;
  await run("INSERT INTO gift_values(base_name,value,image) VALUES(?,0,?) ON CONFLICT(base_name) DO UPDATE SET image=CASE WHEN COALESCE(gift_values.image,'')='' THEN excluded.image ELSE gift_values.image END", [key, gft.image]);
  const val = (await giftValue(key)) || gft.star;
  const conn = m.business_connection_id || (await getConn());
  const id = await insert(`INSERT INTO user_gifts(owner_id,owned_gift_id,connection_id,base_name,name,value,status,created_at,model,backdrop,symbol,number,image)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [m.from.id, gft.ownedId, conn, key, gft.name, val, val > 0 ? 'owned' : 'pending', now(), gft.model, gft.backdrop, gft.symbol, gft.number, gft.image]);
  await logEvent('gift_in', m.from.id, { gift_id: id, name: gft.name, value: val, owned_gift_id: gft.ownedId });
  const chat = (m.chat && m.chat.id) || m.from.id;
  const info = [gft.model && `Model: ${gft.model}`, gft.backdrop && `Fon: ${gft.backdrop}`, gft.symbol && `Belgi: ${gft.symbol}`].filter(Boolean).join(' · ');
  let adminNote = '';
  if (val > 0) {
    const r = await settleGiftDeposit(id);
    if (r && r.credit > 0) {
      await tell(chat, `✅ Gift qabul qilindi: ${gft.name}\n💰 Balansingizga +${r.credit}⭐ avtomatik tushdi.`);
      adminNote = ` → +${r.credit}⭐ balansga tushdi`;
    } else {
      await tell(chat, `🎁 Gift qabul qilindi: ${gft.name} (${val}⭐)${info ? '\n' + info : ''}\nMini App → Backpack: tikish, sotish yoki chiqarish mumkin.`);
      adminNote = ` (${val}⭐, inventarda)`;
    }
  } else {
    await tell(chat, `🎁 Gift qabul qilindi: ${gft.name}.\nNarxi admin tomonidan belgilangach hisobingizda ishlaydi.`);
    adminNote = '\n⚠️ Narx belgilanmagan! Admin panel → Gift katalogi';
  }
  for (const a of ADMIN_IDS) await tell(a, `🎁 Yangi gift: ${gft.name} ← ID ${m.from.id}${adminNote}`);
}

// PaxtaGram to'lov identifikatori (telegram_payment_charge_id nomi ham, paxtagram_... ham qo'llab-quvvatlanadi)
const chargeIdOf = (sp, m) => String(sp.paxtagram_payment_charge_id || sp.telegram_payment_charge_id || sp.provider_payment_charge_id || sp.charge_id
  || `${m.from.id}:${sp.invoice_payload}:${m.date || now()}`);

async function handleUpdate(u) {
  // To'lovni tasdiqlash (10 soniya ichida)
  if (u.pre_checkout_query) {
    const q = u.pre_checkout_query;
    const p = String(q.invoice_payload || '').split(':');
    const ok = q.currency === 'XTR' && p[0] === 'topup' && Number(p[1]) === q.from.id && Number(p[2]) === q.total_amount;
    return bot('answerPreCheckoutQuery', ok
      ? { pre_checkout_query_id: q.id, ok: true }
      : { pre_checkout_query_id: q.id, ok: false, error_message: 'To\'lov ma\'lumotlari noto\'g\'ri' });
  }

  if (u.business_connection) {
    const bc = u.business_connection;
    console.log('[business_connection]', JSON.stringify(bc));
    if (bc.id) await kvSet('bc_id', bc.id);
    if (bc.user && bc.user.id) await kvSet('relayer_id', bc.user.id);
    await logEvent('business_connection', bc.user && bc.user.id, { id: bc.id });
    return;
  }
  if (u.business_message) {
    const bm = u.business_message;
    if (bm.business_connection_id && !(await getConn())) await kvSet('bc_id', bm.business_connection_id);
    if (bm.from && (bm.unique_gift || bm.gift)) await onGift(bm);
    return;
  }
  const m = u.message;
  if (!m || !m.from) return;
  if (m.unique_gift || m.gift) return onGift(m);

  // Muvaffaqiyatli to'lov -> balans
  if (m.successful_payment) {
    const sp = m.successful_payment;
    const p = String(sp.invoice_payload || '').split(':');
    if (p[0] !== 'topup' || Number(p[1]) !== m.from.id) return;
    await ensureUser(m.from);
    const amount = Number(sp.total_amount);
    const charge = chargeIdOf(sp, m);
    const added = await tx(async () => {
      const r = await run('INSERT INTO payments(user_id,amount,charge_id,payload,created_at) VALUES(?,?,?,?,?) ON CONFLICT(charge_id) DO NOTHING',
        [m.from.id, amount, charge, sp.invoice_payload, now()]);
      if (!r.changes) return false;
      await addBal(m.from.id, amount, 'deposit', charge);
      return true;
    });
    await logEvent('payment', m.from.id, { amount, charge, added });
    if (added) await tell(m.chat.id, `✅ To'lov qabul qilindi! Balansingizga +${amount}⭐ qo'shildi.`);
    if (added) for (const a of ADMIN_IDS) await tell(a, `💰 Yangi deposit: ID ${m.from.id} — ${amount}⭐`);
    return;
  }

  // /start
  if (m.text && m.text.startsWith('/start')) {
    const part = m.text.split(/\s+/)[1] || '';
    const ref = part.startsWith('ref_') ? Number(part.slice(4)) : 0;
    await ensureUser(m.from, ref);
    if (!WEBAPP_URL) return tell(m.chat.id, 'Mini App manzili (WEBAPP_URL) sozlanmagan.');
    return bot('sendMessage', {
      chat_id: m.chat.id,
      text: '🎁 Epic Gift ga xush kelibsiz!\nO\'ynang, keys oching va Stars yutib oling.',
      reply_markup: { inline_keyboard: [[{ text: '🚀 Epic Gift ni ochish', web_app: { url: WEBAPP_URL } }]] },
    });
  }
}

// Xabarni qayta urinish bilan qayta ishlash: baza vaqtincha ishlamasa to'lov yoki gift yo'qolmasin
async function handleWithRetry(u) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { await handleUpdate(u); return; } catch (e) {
      console.error(`update xatosi (urinish ${attempt}/5):`, e.message);
      if (e.status) return; // mantiqiy xato — qayta urinish befoyda
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  console.error('[update_failed] qayta ishlanmadi:', JSON.stringify(u).slice(0, 3000));
  await logEvent('update_failed', u.message && u.message.from ? u.message.from.id : null, u);
}

async function poll() {
  await bot('deleteWebhook');
  const me = await bot('getMe');
  if (me.ok) { BOT_USERNAME = me.result.username; console.log('Bot @' + BOT_USERNAME + ' ishga tushdi'); }
  await bot('setMyCommands', { commands: [{ command: 'start', description: 'Boshlash' }] });
  if (WEBAPP_URL) {
    await bot('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Epic Gift', web_app: { url: WEBAPP_URL } } });
  }
  let offset = Number(await kvGet('update_offset')) || 0; // qayta ishga tushganda eski xabarlarni takrorlamaydi
  for (;;) {
    const r = await bot('getUpdates', { offset, timeout: 25 });
    if (!r.ok) { await sleep(3000); continue; }
    for (const u of r.result) {
      offset = u.update_id + 1;
      await handleWithRetry(u);
    }
    if (r.result.length) await kvSet('update_offset', offset).catch((e) => console.error('offset:', e.message));
  }
}

/* ===================== ISHGA TUSHIRISH ===================== */
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

(async () => {
  try {
    await initDb();
  } catch (e) {
    console.error('Bazaga ulanib bo\'lmadi:', e.message);
    console.error('Tekshiring: DATABASE_URL Supabase "Session pooler" havolasi bo\'lishi kerak (Render IPv6 ni qo\'llamaydi).');
    process.exit(1);
  }
  const server = app.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));

  let ticking = false;
  setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try { await pvpTick(); } catch (e) { console.error('pvpTick:', e.message); } finally { ticking = false; }
  }, 1000);

  // Render bepul rejasi uxlab qolmasligi uchun o'ziga ping (UptimeRobot ham tavsiya etiladi)
  if (process.env.RENDER_EXTERNAL_URL) {
    setInterval(() => { fetch(`${process.env.RENDER_EXTERNAL_URL}/healthz`).catch(() => {}); }, 10 * 60 * 1000);
  }

  seedNft().catch((e) => console.error('seedNft:', e.message));
  poll().catch((e) => { console.error('poll to\'xtadi:', e); process.exit(1); });

  const stop = () => { server.close(); D.close().finally(() => process.exit(0)); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
})();
