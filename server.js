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
    for (const a of
