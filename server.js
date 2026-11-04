'use strict';
/* ===================== Epic Gift — server.js ===================== */
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
const Database = require('better-sqlite3');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('XATO: BOT_TOKEN topilmadi. .env faylga BOT_TOKEN=... yozing.');
  process.exit(1);
}
const API_BASE = (process.env.API_BASE || 'https://paxta.online').replace(/\/$/, '');
const WEBAPP_URL = process.env.WEBAPP_URL || '';
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
const INVITE_BASE = process.env.INVITE_BASE || API_BASE + '/';
let BOT_USERNAME = '';

const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ===================== BAZA ===================== */
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'epicgift.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, first_name TEXT, username TEXT, photo_url TEXT,
  balance INTEGER NOT NULL DEFAULT 0, referrer INTEGER, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS keys_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, emoji TEXT DEFAULT '🔑',
  price INTEGER NOT NULL, active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS key_rewards(
  id INTEGER PRIMARY KEY AUTOINCREMENT, key_id INTEGER NOT NULL, name TEXT NOT NULL,
  value INTEGER NOT NULL, chance REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS gifts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, emoji TEXT DEFAULT '🎁',
  price INTEGER NOT NULL, active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rocket_bets(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, bet INTEGER, target REAL,
  crash REAL, win INTEGER, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS mines_games(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, bet INTEGER, mines_count INTEGER,
  mines TEXT, opened TEXT DEFAULT '[]', status TEXT DEFAULT 'active', win INTEGER DEFAULT 0,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS contest_scores(user_id INTEGER PRIMARY KEY, score INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, amount INTEGER,
  charge_id TEXT UNIQUE, payload TEXT, created_at INTEGER
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS user_gifts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER, owned_gift_id TEXT, connection_id TEXT,
  base_name TEXT, name TEXT, value INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'owned',
  created_at INTEGER, lost_at INTEGER
);
CREATE TABLE IF NOT EXISTS gift_values(base_name TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS plinko_games(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, bet INTEGER, rows INTEGER, risk TEXT,
  slot INTEGER, mult REAL, win INTEGER, gift_id INTEGER, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS upgrade_games(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, stake INTEGER, target TEXT, target_value INTEGER,
  chance REAL, roll REAL, win INTEGER, gift_id INTEGER, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS pvp_rounds(
  id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL DEFAULT 'waiting', seed TEXT, hash TEXT, roll REAL,
  start_at INTEGER, total INTEGER DEFAULT 0, winner_id INTEGER, payout INTEGER DEFAULT 0, created_at INTEGER, finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS pvp_entries(
  id INTEGER PRIMARY KEY AUTOINCREMENT, round_id INTEGER, user_id INTEGER, stake INTEGER, created_at INTEGER, seen INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS key_cooldowns(user_id INTEGER, key_id INTEGER, last_open INTEGER, PRIMARY KEY(user_id,key_id));
CREATE TABLE IF NOT EXISTS promo_codes(
  code TEXT PRIMARY KEY, stars INTEGER DEFAULT 0, gift_name TEXT DEFAULT '', max_uses INTEGER DEFAULT 0,
  used INTEGER DEFAULT 0, expires_at INTEGER DEFAULT 0, active INTEGER DEFAULT 1, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS promo_uses(code TEXT, user_id INTEGER, created_at INTEGER, PRIMARY KEY(code,user_id));
CREATE TABLE IF NOT EXISTS pvp_games(
  id INTEGER PRIMARY KEY AUTOINCREMENT, creator_id INTEGER, opponent_id INTEGER, stake INTEGER,
  status TEXT DEFAULT 'open', winner_id INTEGER, payout INTEGER DEFAULT 0, created_at INTEGER, finished_at INTEGER
);
`);
function addCol(table, col, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addCol('rocket_bets', 'status', "TEXT DEFAULT 'done'");
addCol('rocket_bets', 'started_ms', 'INTEGER');
addCol('rocket_bets', 'gift_id', 'INTEGER');
addCol('mines_games', 'gift_id', 'INTEGER');
['model', 'backdrop', 'symbol', 'image'].forEach((c) => addCol('user_gifts', c, 'TEXT'));
addCol('user_gifts', 'number', 'INTEGER');
addCol('gift_values', 'image', 'TEXT');
addCol('pvp_games', 'opp_stake', 'INTEGER');
addCol('pvp_games', 'roll', 'REAL');
addCol('pvp_games', 'is_bot', 'INTEGER DEFAULT 0');
addCol('pvp_games', 'seen', 'INTEGER DEFAULT 1');
addCol('keys_items', 'cooldown_hours', 'INTEGER DEFAULT 0');
addCol('user_gifts', 'source', 'TEXT');

const DEFAULTS = {
  rocket_rtp: '95', mines_rtp: '95', min_bet: '50', max_bet: '1000000000',
  ref_bonus: '5', contest_prize: '100', pvp_fee: '5', gift_to_balance: '0', gift_credit_pct: '100', plinko_rtp: '95', gift_withdraw_fee: '150', pvp_bot: '1', pvp_bot_max: '500', pvp_countdown: '10', key_nft_mult: '0.3', key_nft_min: '400', upgrade_rtp: '95',
};
const insSetting = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
Object.entries(DEFAULTS).forEach(([k, v]) => insSetting.run(k, v));

// Bir martalik: giftlar endi inventarga tushadi (balansga avto emas)
if (!db.prepare("SELECT 1 FROM kv WHERE key='mig_inv_v1'").get()) {
  db.prepare("UPDATE settings SET value='0' WHERE key='gift_to_balance'").run();
  db.prepare("INSERT INTO kv(key,value) VALUES('mig_inv_v1','1')").run();
}
// Bir martalik: minimal stavka 50⭐, maksimal cheksiz
if (!db.prepare("SELECT 1 FROM kv WHERE key='mig_minmax_v1'").get()) {
  db.prepare("UPDATE settings SET value='50' WHERE key='min_bet'").run();
  db.prepare("UPDATE settings SET value='1000000000' WHERE key='max_bet'").run();
  db.prepare("UPDATE settings SET value='500' WHERE key='pvp_bot_max'").run();
  db.prepare("INSERT INTO kv(key,value) VALUES('mig_minmax_v1','1')").run();
}
// Gift katalogi (Paxta Market narxlari, ⭐). Admin paneldan o'zgartiriladi
[['Maple Leaf', 50], ['Money Tree', 75], ['Cake', 100], ['B-Day Candle', 498], ['Lol Pop', 570], ['Star Notepad', 1500], ['Precious Peach', 8000], ['Scared Cat', 27777], ['Swiss Watch', 28999], ['Mask', 0], ['Resistance Dog', 0]]
  .forEach(([n, v]) => db.prepare("INSERT OR IGNORE INTO gift_values(base_name,value,image) VALUES(?,?,'')").run(n, v));

// Namuna keyslar. Eski namuna keyslar bir marta yangisiga almashtiriladi
function seedKeys() {
  const addKey = (name, emoji, price, cd, rewards) => {
    const id = db.prepare('INSERT INTO keys_items(name,emoji,price,cooldown_hours) VALUES(?,?,?,?)').run(name, emoji, price, cd).lastInsertRowid;
    const ins = db.prepare('INSERT INTO key_rewards(key_id,name,value,chance) VALUES(?,?,?,?)');
    rewards.forEach((r) => ins.run(id, ...r));
  };
  addKey('Free Key', '🎁', 0, 24, [['Maple Leaf', 50, 70], ['Money Tree', 75, 25], ['Cake', 100, 5]]);
  addKey('Silver Key', '🔑', 100, 0, [['Maple Leaf', 50, 50], ['Money Tree', 75, 30], ['Cake', 100, 15], ['B-Day Candle', 498, 4], ['Lol Pop', 570, 0.8], ['Star Notepad', 1500, 0.2]]);
  addKey('Gold Key', '🗝️', 500, 0, [['Cake', 100, 45.5], ['B-Day Candle', 498, 30], ['Lol Pop', 570, 18], ['Star Notepad', 1500, 6], ['Precious Peach', 8000, 0.5]]);
}
if (!db.prepare("SELECT 1 FROM kv WHERE key='mig_keys_v2'").get()) {
  db.prepare("SELECT id FROM keys_items WHERE name IN ('Oddiy Key','Oltin Key')").all().forEach((k) => {
    db.prepare('DELETE FROM key_rewards WHERE key_id=?').run(k.id);
    db.prepare('DELETE FROM keys_items WHERE id=?').run(k.id);
  });
  if (!db.prepare("SELECT 1 FROM keys_items WHERE name='Free Key'").get()) seedKeys();
  db.prepare("INSERT INTO kv(key,value) VALUES('mig_keys_v2','1')").run();
}

const getS = (k) => Number(db.prepare('SELECT value FROM settings WHERE key=?').get(k).value);
const allS = () => Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((r) => [r.key, Number(r.value)]));
const addBal = (id, d) => db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(d, id);
const getBal = (id) => db.prepare('SELECT balance FROM users WHERE id=?').get(id).balance;
const addScore = (id, n) => db.prepare(
  'INSERT INTO contest_scores(user_id,score) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET score = score + excluded.score'
).run(id, n);

/* ===================== BOT API ===================== */
async function bot(method, params = {}) {
  try {
    const r = await fetch(`${API_BASE}/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
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

function ensureUser(u, ref) {
  let row = db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
  if (!row) {
    let referrer = null;
    if (ref && ref !== u.id && db.prepare('SELECT 1 FROM users WHERE id=?').get(ref)) referrer = ref;
    db.prepare('INSERT INTO users(id,first_name,username,photo_url,referrer,created_at) VALUES(?,?,?,?,?,?)')
      .run(u.id, u.first_name || '', u.username || '', u.photo_url || '', referrer, now());
    if (referrer) addBal(referrer, getS('ref_bonus'));
  } else {
    db.prepare('UPDATE users SET first_name=?, username=?, photo_url=? WHERE id=?')
      .run(u.first_name || row.first_name, u.username || '', u.photo_url || row.photo_url || '', u.id);
  }
  return db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
}

function auth(req, res, next) {
  try {
    const u = verifyInitData(req.get('x-init-data'));
    if (!u || !u.id) return res.status(401).json({ error: 'Avtorizatsiya xatosi' });
    req.user = ensureUser(u);
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

const fail = (msg, status = 400) => { const e = new Error(msg); e.status = status; throw e; };
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
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---- /api/me ---- */
const activeMines = (uid) => db.prepare("SELECT * FROM mines_games WHERE user_id=? AND status='active'").get(uid);

app.get('/api/me', auth, wrap((req) => {
  const u = req.user;
  const s = allS();
  const g = activeMines(u.id);
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
app.get('/api/live', auth, wrap(() => {
  const a = db.prepare(`SELECT u.first_name n, r.win w, r.id i FROM rocket_bets r JOIN users u ON u.id=r.user_id
    WHERE r.win>0 ORDER BY r.id DESC LIMIT 8`).all().map((x) => ({ e: '🚀', n: x.n, w: x.w }));
  const b = db.prepare(`SELECT u.first_name n, m.win w FROM mines_games m JOIN users u ON u.id=m.user_id
    WHERE m.status='won' ORDER BY m.id DESC LIMIT 8`).all().map((x) => ({ e: '💎', n: x.n, w: x.w }));
  const c = db.prepare(`SELECT u.first_name n, p.win w FROM plinko_games p JOIN users u ON u.id=p.user_id
    WHERE p.win>p.bet ORDER BY p.id DESC LIMIT 8`).all().map((x) => ({ e: '🔮', n: x.n, w: x.w }));
  return { items: [...a, ...b, ...c].slice(0, 16) };
}));

/* ---- Keys (gift mukofotli, bepul kunlik key bilan) ---- */
function rewardInfo(r) {
  const cat = db.prepare("SELECT base_name n, value v, COALESCE(image,'') img FROM gift_values WHERE lower(replace(base_name,' ',''))=lower(replace(?,' ',''))").get(r.name);
  if (cat && cat.v > 0) return { name: cat.n, value: cat.v, gift: true, image: cat.img };
  return { name: r.name, value: r.value, gift: false, image: '' };
}
function keyFreeIn(uid, k) {
  if (!(k.cooldown_hours > 0)) return 0;
  const last = db.prepare('SELECT last_open FROM key_cooldowns WHERE user_id=? AND key_id=?').get(uid, k.id);
  return last ? Math.max(0, last.last_open + k.cooldown_hours * 3600 - now()) : 0;
}
app.get('/api/keys', auth, wrap((req) => {
  const keys = db.prepare('SELECT id,name,emoji,price,cooldown_hours FROM keys_items WHERE active=1 ORDER BY cooldown_hours DESC, price').all();
  const rw = db.prepare('SELECT name,value FROM key_rewards WHERE key_id=?');
  return {
    keys: keys.map((k) => ({
      ...k,
      free_in: keyFreeIn(req.user.id, k),
      rewards: rw.all(k.id).map(rewardInfo).sort((a, b) => a.value - b.value),
    })),
  };
}));

app.post('/api/keys/:id/open', auth, wrap((req) => {
  const id = Number(req.params.id);
  const uid = req.user.id;
  const tx = db.transaction(() => {
    const key = db.prepare('SELECT * FROM keys_items WHERE id=? AND active=1').get(id);
    if (!key) fail('Key topilmadi', 404);
    const rw = db.prepare('SELECT * FROM key_rewards WHERE key_id=?').all(id);
    if (!rw.length) fail('Bu keysda mukofot yo\'q');
    const free = key.cooldown_hours > 0;
    if (free) {
      const left = keyFreeIn(uid, key);
      if (left > 0) fail(`Bepul keys ${Math.floor(left / 3600)} soat ${Math.floor((left % 3600) / 60)} daqiqadan keyin ochiladi`);
      db.prepare('INSERT INTO key_cooldowns(user_id,key_id,last_open) VALUES(?,?,?) ON CONFLICT(user_id,key_id) DO UPDATE SET last_open=excluded.last_open').run(uid, id, now());
    } else {
      if (getBal(uid) < key.price) fail('Balans yetarli emas');
      addBal(uid, -key.price);
      addScore(uid, key.price);
    }
    // Qimmat (NFT) giftlarning tushish shansi key_nft_mult ga ko'paytiriladi
    const mult = getS('key_nft_mult');
    const minV = getS('key_nft_min');
    let w = rw.map((r) => { const i = rewardInfo(r); return r.chance * (i.gift && i.value >= minV ? mult : 1); });
    if (!(w.reduce((a, b) => a + b, 0) > 0)) w = rw.map((r) => r.chance);
    const total = w.reduce((a, b) => a + b, 0);
    let x = (crypto.randomInt(0, 1e9) / 1e9) * total;
    let pick = rw[rw.length - 1];
    for (let i = 0; i < rw.length; i++) { if (x < w[i]) { pick = rw[i]; break; } x -= w[i]; }
    const info = rewardInfo(pick);
    let giftId = null;
    if (info.gift) {
      giftId = db.prepare("INSERT INTO user_gifts(owner_id,owned_gift_id,connection_id,base_name,name,value,status,created_at,image,source) VALUES(?,?,?,?,?,?,?,?,?,'key')")
        .run(uid, '', '', info.name, info.name, info.value, 'owned', now(), info.image).lastInsertRowid;
    } else addBal(uid, info.value);
    return { reward: info, gift_id: giftId, balance: getBal(uid), free_in: free ? key.cooldown_hours * 3600 : 0 };
  });
  return tx();
}));

/* ---- Gifts (sotib olish) ---- */
app.get('/api/gifts', auth, wrap(() => ({
  gifts: db.prepare('SELECT id,name,emoji,price FROM gifts WHERE active=1 ORDER BY price').all(),
})));

app.post('/api/gifts/:id/buy', auth, wrap(async (req) => {
  const id = Number(req.params.id);
  const uid = req.user.id;
  const tx = db.transaction(() => {
    const g = db.prepare('SELECT * FROM gifts WHERE id=? AND active=1').get(id);
    if (!g) fail('Gift topilmadi', 404);
    if (getBal(uid) < g.price) fail('Balans yetarli emas');
    addBal(uid, -g.price);
    return g;
  });
  const g = tx();
  const who = req.user.username ? '@' + req.user.username : req.user.first_name;
  for (const a of ADMIN_IDS) {
    await tell(a, `🎁 Yangi gift buyurtma: ${g.emoji} ${g.name} (${g.price}⭐)\nFoydalanuvchi: ${who} (ID ${uid})`);
  }
  return { ok: true, balance: getBal(uid) };
}));

/* ---- NFT havolalari: nom, rasm, model avtomatik olinadi ---- */
const NFT_BASE = (process.env.NFT_BASE || 'https://paxta.online/nft').replace(/\/$/, '');
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
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`${NFT_BASE}/${slug}`, { signal: ctrl.signal });
    clearTimeout(t);
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
function catalogUpsert(name, image, value, force) {
  const ex = db.prepare("SELECT base_name FROM gift_values WHERE lower(replace(base_name,' ',''))=lower(replace(?,' ',''))").get(name);
  if (!ex) {
    db.prepare('INSERT INTO gift_values(base_name,value,image) VALUES(?,?,?)').run(name, value || 0, image || '');
    return name;
  }
  if (image) db.prepare(force ? 'UPDATE gift_values SET image=? WHERE base_name=?' : "UPDATE gift_values SET image=? WHERE base_name=? AND COALESCE(image,'')=''").run(image, ex.base_name);
  if (value != null) db.prepare('UPDATE gift_values SET value=? WHERE base_name=?').run(value, ex.base_name);
  return ex.base_name;
}
const NFT_SEED = ['LolPop-648', 'Mask-404', 'PreciousPeach-144', 'StarNotepad-520', 'Mask-345', 'ResistanceDog-24'];
async function seedNft() {
  for (const slug of NFT_SEED) {
    const i = await nftInfo(slug);
    catalogUpsert(i.name, i.image, null, false);
  }
}

/* ---- Gift yordamchilari ---- */
const giftValue = (base) => { const r = db.prepare("SELECT value FROM gift_values WHERE lower(replace(base_name,' ',''))=lower(replace(?,' ',''))").get(base); return r ? r.value : 0; };
const giftOf = (id) => (id ? db.prepare('SELECT * FROM user_gifts WHERE id=?').get(id) : null);
const kvGet = (k) => { const r = db.prepare('SELECT value FROM kv WHERE key=?').get(k); return r ? r.value : ''; };
const getConn = () => kvGet('bc_id') || process.env.BUSINESS_CONNECTION_ID || '';
let lastConnWarn = 0;
const kvSet = (k, v) => db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

// Narxi ma'lum gift: balansga o'tkazadi (yoki inventarda qoldiradi). { credit, gift } yoki null qaytaradi
function settleGiftDeposit(giftId) {
  return db.transaction(() => {
    const g = db.prepare("SELECT * FROM user_gifts WHERE id=? AND status IN ('pending','owned')").get(giftId);
    if (!g || g.value < 1) return null;
    if (!getS('gift_to_balance')) {
      db.prepare("UPDATE user_gifts SET status='owned' WHERE id=?").run(g.id);
      return { credit: 0, gift: g };
    }
    const credit = Math.floor((g.value * getS('gift_credit_pct')) / 100);
    db.prepare("UPDATE user_gifts SET status='credited' WHERE id=?").run(g.id);
    if (credit > 0) {
      addBal(g.owner_id, credit);
      db.prepare('INSERT OR IGNORE INTO payments(user_id,amount,charge_id,payload,created_at) VALUES(?,?,?,?,?)')
        .run(g.owner_id, credit, 'gift:' + g.id, 'gift:' + g.name, now());
    }
    return { credit, gift: g };
  })();
}
function lockGift(uid, giftId) {
  const g = db.prepare("SELECT * FROM user_gifts WHERE id=? AND owner_id=? AND status='owned'").get(giftId, uid);
  if (!g) fail('Gift topilmadi yoki band');
  if (g.value < 1) fail('Bu giftga narx belgilanmagan (admin belgilaydi)');
  db.prepare("UPDATE user_gifts SET status='bet' WHERE id=?").run(g.id);
  return g;
}
// mult>0: gift sotiladi va narx*mult Stars to'lanadi; mult==0: gift adminga o'tadi
function resolveGiftStake(gid, uid, stake, mult) {
  if (mult > 0) {
    const win = Math.floor(stake * mult);
    db.prepare("UPDATE user_gifts SET status='sold', lost_at=? WHERE id=?").run(now(), gid);
    if (win > 0) addBal(uid, win);
    return { win, lostGift: null };
  }
  db.prepare("UPDATE user_gifts SET status='lost', lost_at=? WHERE id=?").run(now(), gid);
  return { win: 0, lostGift: giftOf(gid) };
}
function notifyLost(g, uid) {
  const u = db.prepare('SELECT first_name,username FROM users WHERE id=?').get(uid) || {};
  const who = u.username ? '@' + u.username : u.first_name;
  ADMIN_IDS.forEach((a) => tell(a, `🎁 Yutqazilgan gift adminga o'tdi: ${g.name} (${g.value}⭐)\nFoydalanuvchi: ${who} (ID ${uid})`));
}

app.get('/api/mygifts', auth, wrap((req) => ({
  gifts: db.prepare("SELECT id,name,base_name,value,status,model,backdrop,symbol,number,image,source FROM user_gifts WHERE owner_id=? AND status IN ('owned','bet','pending') ORDER BY id DESC").all(req.user.id),
})));

app.get('/api/giftdeposit', auth, wrap(() => {
  const relayer = process.env.RELAYER_USERNAME || 'AVTOGIFT';
  return {
    relayer,
    relayer_url: process.env.RELAYER_URL || `https://paxta.online/${relayer}`,
    to_balance: !!getS('gift_to_balance'),
    pct: getS('gift_credit_pct'),
    withdraw_fee: getS('gift_withdraw_fee'),
    prices: db.prepare(`SELECT v.base_name n, v.value v, COALESCE(v.image,'') img,
      (SELECT COUNT(*) FROM user_gifts g WHERE lower(g.base_name)=lower(v.base_name)) c
      FROM gift_values v WHERE v.value>0 ORDER BY v.value ASC LIMIT 60`).all(),
  };
}));

app.post('/api/mygifts/:id/sell', auth, wrap((req) => {
  const uid = req.user.id;
  const id = Number(req.params.id);
  return db.transaction(() => {
    const g = db.prepare("SELECT * FROM user_gifts WHERE id=? AND owner_id=? AND status='owned'").get(id, uid);
    if (!g) fail('Gift topilmadi yoki band', 404);
    if (g.value < 1) fail('Bu giftga narx belgilanmagan');
    const credit = Math.floor((g.value * getS('gift_credit_pct')) / 100);
    db.prepare("UPDATE user_gifts SET status='sold', lost_at=? WHERE id=?").run(now(), g.id);
    addBal(uid, credit);
    db.prepare('INSERT OR IGNORE INTO payments(user_id,amount,charge_id,payload,created_at) VALUES(?,?,?,?,?)')
      .run(uid, credit, 'sell:' + g.id, 'gift:' + g.name, now());
    return { credit, balance: getBal(uid) };
  })();
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
  const g = db.transaction(() => {
    const row = db.prepare("SELECT * FROM user_gifts WHERE id=? AND owner_id=? AND status='owned'").get(id, uid);
    if (!row) fail('Gift topilmadi yoki band', 404);
    if (row.source === 'key') fee = 0; // keys yutug'ini chiqarish bepul
    const conn = row.connection_id || getConn();
    if (!conn) {
      if (Date.now() - lastConnWarn > 3600000) {
        lastConnWarn = Date.now();
        ADMIN_IDS.forEach((a) => tell(a, '⚠️ Relayer connection ID topilmadi, giftlarni chiqarib bo\'lmayapti. Render → Environment ga BUSINESS_CONNECTION_ID yozing yoki admin panelda kiriting.'));
      }
      fail('Chiqarish vaqtincha ishlamayapti. Admin xabardor qilindi, keyinroq urinib ko\'ring');
    }
    if (getBal(uid) < fee) fail(`Chiqarish uchun balansda kamida ${fee}⭐ bo'lishi kerak`);
    if (fee > 0) addBal(uid, -fee);
    db.prepare("UPDATE user_gifts SET status='withdrawing' WHERE id=?").run(row.id);
    return { ...row, connection_id: conn };
  })();
  const undo = (msg, code) => {
    db.transaction(() => {
      db.prepare("UPDATE user_gifts SET status='owned' WHERE id=?").run(g.id);
      if (fee > 0) addBal(uid, fee);
    })();
    fail(msg + (fee > 0 ? ' (komissiya qaytarildi)' : ''), code || 502);
  };
  let ownedId = g.owned_gift_id;
  if (!ownedId) {
    // Virtual gift (keys/upgrade yutug'i): @relayer omboridan shu turdagi gift topiladi
    const st = await relayerGifts(g.connection_id);
    if (!st.ok) undo('Ombor o\'qilmadi: ' + (st.description || 'noma\'lum xato'));
    const used = new Set(db.prepare("SELECT owned_gift_id id FROM user_gifts WHERE status IN ('owned','bet','pending','withdrawing') AND owned_gift_id<>''").all().map((x) => x.id));
    const found = st.gifts.find((x) => x.owned_gift_id && !used.has(String(x.owned_gift_id)) && x.can_be_transferred !== false && normName(stockBase(x)) === normName(g.base_name));
    if (!found) undo('Hozircha omborda bu gift yo\'q, keyinroq urinib ko\'ring yoki admin bilan bog\'laning', 409);
    ownedId = String(found.owned_gift_id);
  }
  const r = await bot('transferGift', { business_connection_id: g.connection_id, owned_gift_id: ownedId, new_owner_chat_id: uid });
  if (!r.ok) undo('Chiqarib bo\'lmadi: ' + (r.description || 'noma\'lum xato'));
  db.prepare("UPDATE user_gifts SET status='withdrawn', lost_at=?, owned_gift_id=? WHERE id=?").run(now(), ownedId, g.id);
  ADMIN_IDS.forEach((a) => tell(a, `📤 Gift chiqarildi: ${g.name} → ID ${uid} (${fee > 0 ? 'komissiya ' + fee + '⭐' : 'bepul, keys yutug\'i'})`));
  return { balance: getBal(uid), fee };
}));

/* ---- Rocket (jonli raund) ---- */
const ROCKET_K = 0.18; // o'sish tezligi: koeffitsient = e^(K * soniya)
const rocketMult = (ms) => Math.floor(Math.exp((ROCKET_K * ms) / 1000) * 100) / 100;
const rocketTime = (x) => (Math.log(x) / ROCKET_K) * 1000;
const activeRocket = (uid) => db.prepare("SELECT * FROM rocket_bets WHERE user_id=? AND status='active'").get(uid);

app.get('/api/rocket', auth, wrap(() => {
  const s = allS();
  return { min_bet: s.min_bet, max_bet: s.max_bet, min_target: 1.01, max_target: 1000 };
}));

// mult > 0 — yutuq (shu koeffitsientda yechildi), 0 — portladi
function settleRocket(r, mult) {
  let win = 0;
  let lostGift = null;
  if (r.gift_id) {
    const x = resolveGiftStake(r.gift_id, r.user_id, r.bet, mult > 0 ? mult : 0);
    win = x.win; lostGift = x.lostGift;
  } else if (mult > 0) {
    win = Math.floor(r.bet * mult);
    if (win > 0) addBal(r.user_id, win);
  }
  db.prepare("UPDATE rocket_bets SET status='done', win=? WHERE id=?").run(win, r.id);
  return { win, lostGift };
}
function finishRocket(r, mult) {
  const s = db.transaction(() => settleRocket(r, mult))();
  if (s.lostGift) notifyLost(s.lostGift, r.user_id);
  return { status: mult > 0 ? 'won' : 'lost', mult, win: s.win, crash: r.crash, gift: !!r.gift_id, balance: getBal(r.user_id) };
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

app.post('/api/rocket/bet', auth, wrap((req) => {
  const uid = req.user.id;
  const raw = req.body.target;
  const target = raw === undefined || raw === null || raw === '' ? 0 : Math.round(Number(raw) * 100) / 100;
  if (target && !(target >= 1.01 && target <= 1000)) fail('Avto yechish koeffitsienti 1.01 dan 1000 gacha bo\'lsin');
  const giftId = Number(req.body.gift_id) || 0;
  const bet = giftId ? 0 : parseBet(req.body.bet);
  const out = db.transaction(() => {
    const cur = activeRocket(uid);
    if (cur) return { resumed: true, id: cur.id };
    let stake = bet;
    let gid = null;
    if (giftId) { const g = lockGift(uid, giftId); stake = g.value; gid = g.id; }
    else { if (getBal(uid) < bet) fail('Balans yetarli emas'); addBal(uid, -bet); }
    const rtp = getS('rocket_rtp') / 100;
    const rnd = crypto.randomInt(0, 1e9) / 1e9;
    const crash = Math.min(1000, Math.max(1, Math.floor((rtp / (1 - rnd)) * 100) / 100));
    const info = db.prepare('INSERT INTO rocket_bets(user_id,bet,target,crash,win,created_at,status,started_ms,gift_id) VALUES(?,?,?,?,0,?,?,?,?)')
      .run(uid, stake, target || null, crash, now(), 'active', Date.now(), gid);
    addScore(uid, stake);
    return { resumed: false, id: info.lastInsertRowid };
  })();
  const r = db.prepare('SELECT * FROM rocket_bets WHERE id=?').get(out.id);
  return { ...rocketView(r), resumed: out.resumed, balance: getBal(uid) };
}));

app.get('/api/rocket/state', auth, wrap((req) => {
  const r = activeRocket(req.user.id);
  if (!r) return { status: 'none', balance: getBal(req.user.id) };
  const res = resolveRocket(r);
  if (res) return finishRocket(r, res.mult);
  return rocketView(r);
}));

app.post('/api/rocket/cashout', auth, wrap((req) => {
  const r = activeRocket(req.user.id);
  if (!r) return { status: 'none', balance: getBal(req.user.id) };
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
function minesCashout(g) {
  const st = minesState(g);
  db.prepare("UPDATE mines_games SET status='won', win=? WHERE id=?").run(st.win_now, g.id);
  if (g.gift_id) return resolveGiftStake(g.gift_id, g.user_id, g.bet, st.multiplier).win;
  if (st.win_now > 0) addBal(g.user_id, st.win_now);
  return st.win_now;
}

app.post('/api/mines/start', auth, wrap((req) => {
  const giftId = Number(req.body.gift_id) || 0;
  const bet = giftId ? 0 : parseBet(req.body.bet);
  const mc = Number(req.body.mines);
  if (!Number.isInteger(mc) || mc < 1 || mc > 24) fail('Minalar soni 1 dan 24 gacha');
  const uid = req.user.id;
  const tx = db.transaction(() => {
    const act = activeMines(uid);
    if (act) return { resumed: true, game: minesState(act) };
    let stake = bet;
    let gid = null;
    if (giftId) { const g = lockGift(uid, giftId); stake = g.value; gid = g.id; }
    else { if (getBal(uid) < bet) fail('Balans yetarli emas'); addBal(uid, -bet); }
    const info = db.prepare('INSERT INTO mines_games(user_id,bet,mines_count,mines,created_at,gift_id) VALUES(?,?,?,?,?,?)')
      .run(uid, stake, mc, JSON.stringify(pickMines(mc)), now(), gid);
    addScore(uid, stake);
    return { resumed: false, game: minesState(db.prepare('SELECT * FROM mines_games WHERE id=?').get(info.lastInsertRowid)) };
  });
  const r = tx();
  r.balance = getBal(uid);
  return r;
}));

app.post('/api/mines/click', auth, wrap((req) => {
  const cell = Number(req.body.cell);
  if (!Number.isInteger(cell) || cell < 0 || cell >= MINES_N) fail('Katak noto\'g\'ri');
  const uid = req.user.id;
  const tx = db.transaction(() => {
    const g = activeMines(uid);
    if (!g) fail('Faol o\'yin yo\'q');
    const mines = JSON.parse(g.mines);
    const opened = JSON.parse(g.opened);
    if (opened.includes(cell)) fail('Bu katak allaqachon ochilgan');
    if (mines.includes(cell)) {
      db.prepare("UPDATE mines_games SET status='lost' WHERE id=?").run(g.id);
      let lg = null;
      if (g.gift_id) {
        db.prepare("UPDATE user_gifts SET status='lost', lost_at=? WHERE id=?").run(now(), g.gift_id);
        lg = giftOf(g.gift_id);
      }
      return { status: 'lost', mines, cell, gift: !!g.gift_id, _lg: lg };
    }
    opened.push(cell);
    g.opened = JSON.stringify(opened);
    db.prepare('UPDATE mines_games SET opened=? WHERE id=?').run(g.opened, g.id);
    if (opened.length >= MINES_N - g.mines_count) {
      const win = minesCashout(g);
      return { status: 'won', win, mines, opened, gift: !!g.gift_id };
    }
    return { status: 'safe', game: minesState(g) };
  });
  const r = tx();
  if (r._lg) { notifyLost(r._lg, uid); delete r._lg; }
  r.balance = getBal(uid);
  return r;
}));

app.post('/api/mines/cashout', auth, wrap((req) => {
  const uid = req.user.id;
  const tx = db.transaction(() => {
    const g = activeMines(uid);
    if (!g) fail('Faol o\'yin yo\'q');
    if (JSON.parse(g.opened).length === 0) fail('Avval kamida bitta katakni oching');
    const win = minesCashout(g);
    return { status: 'won', win, mines: JSON.parse(g.mines), opened: JSON.parse(g.opened), gift: !!g.gift_id };
  });
  const r = tx();
  r.balance = getBal(uid);
  return r;
}));

/* ---- PVP duel xonasi: ko'p o'yinchi, 10 soniya, g'ildirak va to'p ---- */
const BOT_ID = -1;
db.prepare('INSERT OR IGNORE INTO users(id,first_name,username,photo_url,balance,created_at) VALUES(?,?,?,?,0,?)').run(BOT_ID, 'Epic bot', 'epic_bot', '', now());
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');

function addEntry(roundId, uid, stake) {
  db.prepare('INSERT INTO pvp_entries(round_id,user_id,stake,created_at,seen) VALUES(?,?,?,?,?)').run(roundId, uid, stake, now(), uid === BOT_ID ? 1 : 0);
  db.prepare('UPDATE pvp_rounds SET total = total + ? WHERE id=?').run(stake, roundId);
}
function roundPlayers(roundId) {
  const rows = db.prepare(`SELECT e.user_id uid, SUM(e.stake) stake, MIN(e.id) first, u.first_name n, u.photo_url p
    FROM pvp_entries e JOIN users u ON u.id=e.user_id WHERE e.round_id=? GROUP BY e.user_id ORDER BY first`).all(roundId);
  const total = rows.reduce((a, r) => a + r.stake, 0);
  return rows.map((r) => ({ id: r.uid, name: r.n, photo: r.p, bot: r.uid === BOT_ID, stake: r.stake, pct: total ? Math.round((r.stake / total) * 1000) / 10 : 0 }));
}
function startCountdownIfReady(roundId) {
  const r = db.prepare('SELECT * FROM pvp_rounds WHERE id=?').get(roundId);
  if (r.status !== 'waiting') return;
  const distinct = db.prepare('SELECT COUNT(DISTINCT user_id) c FROM pvp_entries WHERE round_id=?').get(roundId).c;
  if (distinct >= 2) db.prepare("UPDATE pvp_rounds SET status='countdown', start_at=? WHERE id=?").run(Date.now() + getS('pvp_countdown') * 1000, roundId);
}
function botJoin(roundId) {
  const min = getS('min_bet');
  const max = Math.max(min, Math.min(getS('max_bet'), getS('pvp_bot_max')));
  addEntry(roundId, BOT_ID, min + crypto.randomInt(0, max - min + 1));
  startCountdownIfReady(roundId);
}
function newRound() {
  const seed = crypto.randomBytes(16).toString('hex');
  const roll = parseInt(sha(seed + ':roll').slice(0, 12), 16) / 2 ** 48;
  const id = db.prepare("INSERT INTO pvp_rounds(status,seed,hash,roll,created_at) VALUES('waiting',?,?,?,?)").run(seed, sha(seed), roll, now()).lastInsertRowid;
  if (getS('pvp_bot')) botJoin(id);
  return id;
}
const openRound = () => db.prepare("SELECT * FROM pvp_rounds WHERE status IN ('waiting','countdown') ORDER BY id DESC LIMIT 1").get();
function currentRound() {
  let r = openRound();
  if (!r) { newRound(); r = openRound(); }
  return r;
}
function finishRound(r) {
  const players = roundPlayers(r.id);
  const total = players.reduce((a, p) => a + p.stake, 0);
  if (players.length < 2) { // raqib yo'q: stavkalar qaytariladi
    players.forEach((p) => { if (p.id !== BOT_ID) addBal(p.id, p.stake); });
    db.prepare("UPDATE pvp_rounds SET status='cancelled', finished_at=? WHERE id=?").run(now(), r.id);
    return null;
  }
  const t = r.roll * total;
  let cum = 0;
  let winner = players[players.length - 1];
  for (const p of players) { cum += p.stake; if (t < cum) { winner = p; break; } }
  const payout = Math.floor(total * (1 - getS('pvp_fee') / 100));
  if (winner.id !== BOT_ID) addBal(winner.id, payout);
  db.prepare("UPDATE pvp_rounds SET status='done', winner_id=?, payout=?, total=?, finished_at=? WHERE id=?").run(winner.id, payout, total, now(), r.id);
  db.prepare('UPDATE pvp_entries SET seen=0 WHERE round_id=? AND user_id>0').run(r.id);
  return { winner, payout, players };
}
function pvpTick() {
  const r = openRound();
  if (!r) { newRound(); return; }
  if (r.status === 'waiting' && getS('pvp_bot') && !db.prepare('SELECT 1 FROM pvp_entries WHERE round_id=? AND user_id=?').get(r.id, BOT_ID)) botJoin(r.id);
  const cur = openRound();
  if (cur.status === 'countdown' && Date.now() >= cur.start_at) {
    const res = db.transaction(() => finishRound(cur))();
    newRound();
    if (res && res.winner.id !== BOT_ID) tell(res.winner.id, `🏆 PVP #${cur.id}: siz yutdingiz! +${res.payout}⭐`);
  }
}
function roundState(id) {
  const r = db.prepare('SELECT * FROM pvp_rounds WHERE id=?').get(id);
  const players = roundPlayers(id);
  return { id, status: r.status, hash: r.hash, start_at: r.start_at, total: players.reduce((a, p) => a + p.stake, 0), players };
}
function roundView(r, viewerId) {
  const players = roundPlayers(r.id);
  const winner = players.find((p) => p.id === r.winner_id) || players[0];
  return {
    id: r.id, hash: r.hash, seed: r.seed, roll: r.roll, total: r.total, payout: r.payout, players, winner,
    finished_ago: Math.max(0, now() - (r.finished_at || now())),
    mine: players.some((p) => p.id === viewerId), won: r.winner_id === viewerId,
  };
}

app.get('/api/pvp', auth, wrap((req) => {
  pvpTick();
  const uid = req.user.id;
  const cur = currentRound();
  const last = db.prepare("SELECT * FROM pvp_rounds WHERE status='done' ORDER BY id DESC LIMIT 1").get();
  const top = db.prepare(`SELECT r.payout p, u.first_name n FROM pvp_rounds r JOIN users u ON u.id=r.winner_id
    WHERE r.status='done' ORDER BY r.payout DESC LIMIT 1`).get();
  const unseen = db.prepare(`SELECT r.* FROM pvp_rounds r WHERE r.status='done'
    AND EXISTS(SELECT 1 FROM pvp_entries e WHERE e.round_id=r.id AND e.user_id=? AND e.seen=0) ORDER BY r.id LIMIT 1`).get(uid);
  let play = null;
  if (unseen) play = roundView(unseen, uid);
  else if (last && now() - last.finished_at <= 12) play = roundView(last, uid);
  const s = allS();
  return {
    now: Date.now(), round: roundState(cur.id), top: top || null, last: last ? { ...roundView(last, uid) } : null, play,
    fee: s.pvp_fee, min_bet: s.min_bet, max_bet: s.max_bet, countdown: s.pvp_countdown, bot: !!s.pvp_bot,
  };
}));

app.post('/api/pvp/bet', auth, wrap((req) => {
  pvpTick();
  const uid = req.user.id;
  const stake = parseBet(req.body.stake);
  const rid = db.transaction(() => {
    const r = currentRound();
    if (r.status === 'countdown' && Date.now() >= r.start_at) fail('Raund boshlandi. Keyingi raundni kuting');
    if (getBal(uid) < stake) fail('Balans yetarli emas');
    addBal(uid, -stake);
    addEntry(r.id, uid, stake);
    addScore(uid, stake);
    startCountdownIfReady(r.id);
    return r.id;
  })();
  return { round: roundState(rid), balance: getBal(uid) };
}));

app.post('/api/pvp/cancel', auth, wrap((req) => {
  const uid = req.user.id;
  return db.transaction(() => {
    const r = currentRound();
    if (r.status !== 'waiting') fail('Raund boshlangan, bekor qilib bo\'lmaydi');
    const mine = db.prepare('SELECT COALESCE(SUM(stake),0) s FROM pvp_entries WHERE round_id=? AND user_id=?').get(r.id, uid).s;
    if (!mine) fail('Bu raundda stavkangiz yo\'q', 404);
    db.prepare('DELETE FROM pvp_entries WHERE round_id=? AND user_id=?').run(r.id, uid);
    db.prepare('UPDATE pvp_rounds SET total = total - ? WHERE id=?').run(mine, r.id);
    addBal(uid, mine);
    return { balance: getBal(uid) };
  })();
}));

app.post('/api/pvp/:id/seen', auth, wrap((req) => {
  db.prepare('UPDATE pvp_entries SET seen=1 WHERE round_id=? AND user_id=?').run(Number(req.params.id), req.user.id);
}));

/* ---- UPGRADE: gift/Stars bilan qimmatroq giftga aylantirish ---- */
const upgradeCatalog = () => db.prepare("SELECT base_name n, value v, COALESCE(image,'') img FROM gift_values WHERE value>0 ORDER BY value ASC").all();
app.get('/api/upgrade', auth, wrap(() => ({ rtp: getS('upgrade_rtp'), catalog: upgradeCatalog() })));
app.post('/api/upgrade', auth, wrap((req) => {
  const uid = req.user.id;
  const tname = String(req.body.target || '');
  const giftId = Number(req.body.gift_id) || 0;
  const bet = giftId ? 0 : parseBet(req.body.bet);
  const out = db.transaction(() => {
    const t = db.prepare("SELECT base_name n, value v, COALESCE(image,'') img FROM gift_values WHERE lower(base_name)=lower(?) AND value>0").get(tname);
    if (!t) fail('Orzu gifti topilmadi', 404);
    let stake = bet;
    let gid = null;
    if (giftId) { const g = lockGift(uid, giftId); stake = g.value; gid = g.id; }
    else { if (getBal(uid) < bet) fail('Balans yetarli emas'); addBal(uid, -bet); }
    if (stake >= t.v) fail('Orzu gifti stavkadan qimmatroq bo\'lishi kerak');
    const chance = Math.floor((stake / t.v) * getS('upgrade_rtp') * 100) / 10000;
    if (chance < 0.01) fail('Shans 1% dan past. Qimmatroq stavka yoki arzonroq gift tanlang');
    const roll = crypto.randomInt(0, 1e9) / 1e9;
    const win = roll < chance;
    let lostGift = null;
    if (gid) {
      if (win) db.prepare("UPDATE user_gifts SET status='sold', lost_at=? WHERE id=?").run(now(), gid);
      else { db.prepare("UPDATE user_gifts SET status='lost', lost_at=? WHERE id=?").run(now(), gid); lostGift = giftOf(gid); }
    }
    let newId = null;
    if (win) {
      newId = db.prepare('INSERT INTO user_gifts(owner_id,owned_gift_id,connection_id,base_name,name,value,status,created_at,image) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(uid, '', '', t.n, t.n, t.v, 'owned', now(), t.img).lastInsertRowid;
    }
    addScore(uid, stake);
    db.prepare('INSERT INTO upgrade_games(user_id,stake,target,target_value,chance,roll,win,gift_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(uid, stake, t.n, t.v, chance, roll, win ? 1 : 0, gid, now());
    return { win, chance, roll, target: t, gift: !!gid, new_gift_id: newId, lostGift };
  })();
  if (out.lostGift) { notifyLost(out.lostGift, uid); delete out.lostGift; }
  if (out.win) ADMIN_IDS.forEach((a) => tell(a, `⬆️ Upgrade yutuq: ID ${uid} → ${out.target.n} (${out.target.v}⭐). Jismoniy chiqarish kerak bo'lsa, qo'lda yuboring.`));
  out.balance = getBal(uid);
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
app.get('/api/plinko', auth, wrap(() => {
  const rtp = getS('plinko_rtp');
  const s = allS();
  const tables = {};
  PLINKO_ROWS.forEach((r) => {
    tables[r] = {};
    Object.keys(PLINKO_K).forEach((k) => { tables[r][k] = plinkoTable(r, k, rtp); });
  });
  return { rows: PLINKO_ROWS, tables, min_bet: s.min_bet, max_bet: s.max_bet };
}));
app.post('/api/plinko/drop', auth, wrap((req) => {
  const rows = Number(req.body.rows);
  const risk = String(req.body.risk || 'mid');
  if (!PLINKO_ROWS.includes(rows)) fail('Qatorlar soni noto\'g\'ri');
  if (!PLINKO_K[risk]) fail('Xavf darajasi noto\'g\'ri');
  const giftId = Number(req.body.gift_id) || 0;
  const bet = giftId ? 0 : parseBet(req.body.bet);
  const uid = req.user.id;
  const out = db.transaction(() => {
    let stake = bet;
    let gid = null;
    if (giftId) { const g = lockGift(uid, giftId); stake = g.value; gid = g.id; }
    else { if (getBal(uid) < bet) fail('Balans yetarli emas'); addBal(uid, -bet); }
    const path = Array.from({ length: rows }, () => crypto.randomInt(0, 2));
    const slot = path.reduce((a, b) => a + b, 0);
    const mult = plinkoTable(rows, risk, getS('plinko_rtp'))[slot];
    let win = 0;
    let lostGift = null;
    if (gid) { const x = resolveGiftStake(gid, uid, stake, mult); win = x.win; lostGift = x.lostGift; }
    else { win = Math.floor(stake * mult); if (win > 0) addBal(uid, win); }
    db.prepare('INSERT INTO plinko_games(user_id,bet,rows,risk,slot,mult,win,gift_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(uid, stake, rows, risk, slot, mult, win, gid, now());
    addScore(uid, stake);
    return { path, slot, mult, win, gift: !!gid, lostGift };
  })();
  if (out.lostGift) { notifyLost(out.lostGift, uid); delete out.lostGift; }
  out.balance = getBal(uid);
  return out;
}));

/* ---- Promo kod ---- */
const promoFails = new Map();
app.post('/api/promo/redeem', auth, wrap((req) => {
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
  const out = db.transaction(() => {
    const p = db.prepare('SELECT * FROM promo_codes WHERE code=?').get(code);
    if (!p || !p.active) bad('Bunday promo kod topilmadi');
    if (p.expires_at > 0 && now() > p.expires_at) bad('Promo kod muddati tugagan');
    if (p.max_uses > 0 && p.used >= p.max_uses) bad('Promo kod limiti tugagan');
    if (db.prepare('SELECT 1 FROM promo_uses WHERE code=? AND user_id=?').get(code, uid)) fail('Siz bu promo koddan allaqachon foydalangansiz');
    let gift = null;
    if (p.gift_name) {
      const cat = db.prepare("SELECT base_name n, value v, COALESCE(image,'') img FROM gift_values WHERE lower(replace(base_name,' ',''))=lower(replace(?,' ','')) AND value>0").get(p.gift_name);
      if (cat) {
        db.prepare("INSERT INTO user_gifts(owner_id,owned_gift_id,connection_id,base_name,name,value,status,created_at,image,source) VALUES(?,?,?,?,?,?,?,?,?,'promo')")
          .run(uid, '', '', cat.n, cat.n, cat.v, 'owned', now(), cat.img);
        gift = { name: cat.n, value: cat.v, image: cat.img };
      }
    }
    if (p.stars > 0) {
      addBal(uid, p.stars);
      db.prepare('INSERT OR IGNORE INTO payments(user_id,amount,charge_id,payload,created_at) VALUES(?,?,?,?,?)').run(uid, p.stars, `promo:${code}:${uid}`, 'promo:' + code, now());
    }
    db.prepare('INSERT INTO promo_uses(code,user_id,created_at) VALUES(?,?,?)').run(code, uid, now());
    db.prepare('UPDATE promo_codes SET used = used + 1 WHERE code=?').run(code);
    return { stars: p.stars, gift, balance: getBal(uid) };
  })();
  promoFails.delete(uid);
  return out;
}));

/* ---- Leaderboard / tarix ---- */
app.get('/api/leaderboard', auth, wrap((req) => {
  const top = db.prepare(`SELECT u.first_name n, u.username un, c.score s FROM contest_scores c
    JOIN users u ON u.id=c.user_id ORDER BY c.score DESC LIMIT 20`).all();
  const me = db.prepare('SELECT score FROM contest_scores WHERE user_id=?').get(req.user.id);
  return { top, my_score: me ? me.score : 0, prize: getS('contest_prize') };
}));

app.get('/api/history', auth, wrap((req) => {
  const uid = req.user.id;
  return {
    payments: db.prepare('SELECT amount, created_at FROM payments WHERE user_id=? ORDER BY id DESC LIMIT 15').all(uid),
    rocket: db.prepare("SELECT bet,target,crash,win,created_at FROM rocket_bets WHERE user_id=? AND status='done' ORDER BY id DESC LIMIT 10").all(uid),
    upgrade: db.prepare('SELECT stake,target,chance,win,created_at FROM upgrade_games WHERE user_id=? ORDER BY id DESC LIMIT 10').all(uid),
    plinko: db.prepare('SELECT bet,rows,risk,mult,win,created_at FROM plinko_games WHERE user_id=? ORDER BY id DESC LIMIT 10').all(uid),
    mines: db.prepare("SELECT bet,mines_count,win,status,created_at FROM mines_games WHERE user_id=? AND status!='active' ORDER BY id DESC LIMIT 10").all(uid),
  };
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

ADMIN.get('/data', wrap(() => {
  const rw = db.prepare('SELECT id,name,value,chance FROM key_rewards WHERE key_id=?');
  const keys = db.prepare('SELECT * FROM keys_items ORDER BY id').all().map((k) => ({ ...k, rewards: rw.all(k.id) }));
  return {
    settings: allS(),
    keys,
    gifts: db.prepare('SELECT * FROM gifts ORDER BY id').all(),
    contest: db.prepare(`SELECT u.id uid, u.first_name n, u.username un, c.score s FROM contest_scores c
      JOIN users u ON u.id=c.user_id ORDER BY c.score DESC LIMIT 10`).all(),
    users: db.prepare('SELECT COUNT(*) c FROM users WHERE id>0').get().c,
    promos: db.prepare('SELECT code,stars,gift_name,max_uses,used,expires_at FROM promo_codes ORDER BY created_at DESC LIMIT 50').all(),
    bc_id: getConn(),
    bc_env: !!process.env.BUSINESS_CONNECTION_ID,
    stock: (() => { try { return JSON.parse(kvGet('stock_json') || '{}'); } catch (e) { return {}; } })(),
    gift_types: db.prepare(`SELECT v.base_name b, v.value v, COALESCE(v.image,'') img,
      (SELECT COUNT(*) FROM user_gifts g WHERE g.base_name=v.base_name) c FROM gift_values v ORDER BY v.value`).all(),
    lost: db.prepare(`SELECT g.id, g.name, g.value, g.lost_at, g.status, u.first_name n FROM user_gifts g
      JOIN users u ON u.id=g.owner_id WHERE g.status IN ('lost','sold','taken') ORDER BY g.lost_at DESC LIMIT 30`).all(),
  };
}));

ADMIN.post('/settings', wrap((req) => {
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
  const up = db.prepare('UPDATE settings SET value=? WHERE key=?');
  db.transaction(() => { for (const k of Object.keys(DEFAULTS)) up.run(String(cur[k]), k); })();
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
const saveRewards = (keyId, rewards) => {
  db.prepare('DELETE FROM key_rewards WHERE key_id=?').run(keyId);
  const ins = db.prepare('INSERT INTO key_rewards(key_id,name,value,chance) VALUES(?,?,?,?)');
  rewards.forEach((r) => ins.run(keyId, r.name, r.value, r.chance));
};

ADMIN.post('/keys', wrap((req) => {
  const k = cleanKey(req.body || {});
  return db.transaction(() => {
    const id = db.prepare('INSERT INTO keys_items(name,emoji,price,cooldown_hours) VALUES(?,?,?,?)').run(k.name, k.emoji, k.price, k.cd).lastInsertRowid;
    saveRewards(id, k.rewards);
    return { id };
  })();
}));
ADMIN.put('/keys/:id', wrap((req) => {
  const id = Number(req.params.id);
  const k = cleanKey(req.body || {});
  const active = req.body.active === 0 || req.body.active === false ? 0 : 1;
  db.transaction(() => {
    const r = db.prepare('UPDATE keys_items SET name=?,emoji=?,price=?,cooldown_hours=?,active=? WHERE id=?').run(k.name, k.emoji, k.price, k.cd, active, id);
    if (!r.changes) fail('Key topilmadi', 404);
    saveRewards(id, k.rewards);
  })();
}));
ADMIN.delete('/keys/:id', wrap((req) => {
  const id = Number(req.params.id);
  db.transaction(() => {
    db.prepare('DELETE FROM key_rewards WHERE key_id=?').run(id);
    db.prepare('DELETE FROM keys_items WHERE id=?').run(id);
  })();
}));

function cleanGift(b) {
  const price = Number(b.price);
  if (!b.name || !Number.isInteger(price) || price < 1) fail('Gift nomi va narxi (butun son) kerak');
  return { name: String(b.name).slice(0, 40), emoji: String(b.emoji || '🎁').slice(0, 8), price };
}
ADMIN.post('/gifts', wrap((req) => {
  const g = cleanGift(req.body || {});
  return { id: db.prepare('INSERT INTO gifts(name,emoji,price) VALUES(?,?,?)').run(g.name, g.emoji, g.price).lastInsertRowid };
}));
ADMIN.put('/gifts/:id', wrap((req) => {
  const g = cleanGift(req.body || {});
  const active = req.body.active === 0 || req.body.active === false ? 0 : 1;
  const r = db.prepare('UPDATE gifts SET name=?,emoji=?,price=?,active=? WHERE id=?').run(g.name, g.emoji, g.price, active, Number(req.params.id));
  if (!r.changes) fail('Gift topilmadi', 404);
}));
ADMIN.delete('/gifts/:id', wrap((req) => {
  db.prepare('DELETE FROM gifts WHERE id=?').run(Number(req.params.id));
}));

ADMIN.post('/contest/finish', wrap(async () => {
  const prize = getS('contest_prize');
  const res = db.transaction(() => {
    const top = db.prepare(`SELECT u.id uid, u.first_name n, c.score s FROM contest_scores c
      JOIN users u ON u.id=c.user_id ORDER BY c.score DESC LIMIT 1`).get();
    if (!top) fail('Konkursda ishtirokchi yo\'q');
    addBal(top.uid, prize);
    db.prepare('DELETE FROM contest_scores').run();
    return top;
  })();
  await tell(res.uid, `🏆 Tabriklaymiz! Siz konkursda g'olib bo'ldingiz va ${prize}⭐ yutib oldingiz!`);
  return { winner: { id: res.uid, name: res.n, score: res.s }, prize };
}));

ADMIN.post('/balance', wrap(async (req) => {
  const uid = Number(req.body.user_id);
  const amount = Number(req.body.amount);
  if (!Number.isInteger(uid) || !Number.isInteger(amount) || amount === 0) fail('Foydalanuvchi ID va summa (butun son) kerak');
  if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(uid)) fail('Foydalanuvchi topilmadi', 404);
  if (amount < 0 && getBal(uid) + amount < 0) fail('Balans manfiy bo\'lib qoladi');
  addBal(uid, amount);
  await tell(uid, amount > 0 ? `🎁 Balansingizga +${amount}⭐ qo'shildi.` : `Balansingizdan ${-amount}⭐ ayirildi.`);
  return { balance: getBal(uid) };
}));

ADMIN.post('/giftvalue', wrap(async (req) => {
  const base = String(req.body.base_name || '').trim().slice(0, 80);
  const value = Number(req.body.value);
  const image = String(req.body.image || '').trim().slice(0, 500);
  if (!base || !Number.isInteger(value) || value < 0) fail('Gift nomi va qiymati (butun son) kerak');
  const pend = db.transaction(() => {
    const ex = db.prepare('SELECT base_name FROM gift_values WHERE lower(base_name)=lower(?)').get(base);
    const key = ex ? ex.base_name : base;
    db.prepare("INSERT INTO gift_values(base_name,value,image) VALUES(?,?,?) ON CONFLICT(base_name) DO UPDATE SET value=excluded.value, image=CASE WHEN excluded.image<>'' THEN excluded.image ELSE image END").run(key, value, image);
    db.prepare("UPDATE user_gifts SET value=? WHERE base_name=? AND status IN ('owned','pending')").run(value, key);
    return db.prepare("SELECT id FROM user_gifts WHERE base_name=? AND status='pending'").all(key);
  })();
  let credited = 0;
  if (value > 0) {
    for (const p of pend) {
      const r = settleGiftDeposit(p.id);
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
  const g = db.prepare("SELECT * FROM user_gifts WHERE id=? AND status IN ('lost','sold')").get(Number(req.params.id));
  if (!g) fail('Gift topilmadi', 404);
  if (!g.connection_id || !g.owned_gift_id) fail('Bu gift uchun ulanish ma\'lumoti yo\'q, qo\'lda oling');
  const r = await bot('transferGift', { business_connection_id: g.connection_id, owned_gift_id: g.owned_gift_id, new_owner_chat_id: req.user.id });
  if (!r.ok) fail('O\'tkazib bo\'lmadi: ' + (r.description || ''), 502);
  db.prepare("UPDATE user_gifts SET status='taken' WHERE id=?").run(g.id);
}));

ADMIN.post('/promos', wrap((req) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const stars = Number(req.body.stars) || 0;
  const maxUses = Number(req.body.max_uses) || 0;
  const hours = Number(req.body.expire_hours) || 0;
  const giftName = String(req.body.gift_name || '').trim().slice(0, 80);
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) fail('Kod 3-32 belgi: lotin harf, raqam, - yoki _');
  if (!Number.isInteger(stars) || stars < 0 || !Number.isInteger(maxUses) || maxUses < 0 || !Number.isInteger(hours) || hours < 0) fail('Stars, limit va muddat butun son bo\'lsin');
  if (!stars && !giftName) fail('Stars yoki gift kiriting');
  if (giftName && !db.prepare("SELECT 1 FROM gift_values WHERE lower(replace(base_name,' ',''))=lower(replace(?,' ','')) AND value>0").get(giftName)) fail('Gift katalogda topilmadi yoki narxsiz');
  if (db.prepare('SELECT 1 FROM promo_codes WHERE code=?').get(code)) fail('Bu kod allaqachon mavjud');
  db.prepare('INSERT INTO promo_codes(code,stars,gift_name,max_uses,expires_at,created_at) VALUES(?,?,?,?,?,?)')
    .run(code, stars, giftName, maxUses, hours > 0 ? now() + hours * 3600 : 0, now());
  return { code };
}));
ADMIN.delete('/promos/:code', wrap((req) => {
  db.prepare('DELETE FROM promo_codes WHERE code=?').run(String(req.params.code).toUpperCase());
}));
ADMIN.post('/connection', wrap((req) => {
  const id = String(req.body.id || '').trim().slice(0, 120);
  if (!id) fail('Connection ID ni kiriting');
  kvSet('bc_id', id);
  return { id };
}));

ADMIN.post('/nftlinks', wrap(async (req) => {
  const raw = Array.isArray(req.body.links) ? req.body.links : String(req.body.links || '').split(/[\s,]+/);
  const slugs = [...new Set(raw.map(slugOf).filter(Boolean))].slice(0, 30);
  if (!slugs.length) fail('To\'g\'ri NFT havolasi topilmadi (masalan https://paxta.online/nft/LolPop-648)');
  const price = req.body.price === undefined || req.body.price === '' ? null : Number(req.body.price);
  if (price !== null && (!Number.isInteger(price) || price < 0)) fail('Narx butun son bo\'lsin');
  const added = [];
  for (const slug of slugs) {
    const i = await nftInfo(slug);
    const name = catalogUpsert(i.name, i.image, price, true);
    added.push({ name, image: i.image, model: i.model, backdrop: i.backdrop, symbol: i.symbol, number: i.number });
  }
  return { added };
}));

ADMIN.post('/syncstock', wrap(async () => {
  const conn = getConn();
  if (!conn) fail('Relayer ulanishi hali kelmagan (business_connection). @PaxtaFather → /setrelayer ni qayta bajaring');
  const st = await relayerGifts(conn);
  if (!st.ok) fail('Ombor o\'qilmadi: ' + (st.description || 'noma\'lum xato'), 502);
  const counts = {};
  st.gifts.forEach((x) => {
    const base = stockBase(x);
    if (!base) return;
    const name = catalogUpsert(base.includes(' ') ? base : spaced(base), stockImage(x), null, false);
    counts[normName(name)] = (counts[normName(name)] || 0) + 1;
  });
  kvSet('stock_json', JSON.stringify(counts));
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
  if (String(m.from.id) === kvGet('relayer_id')) return; // relayer akkauntning o'z xabari
  ensureUser(m.from);
  if (gft.ownedId && db.prepare('SELECT 1 FROM user_gifts WHERE owned_gift_id=?').get(gft.ownedId)) return;
  const ex = db.prepare("SELECT base_name FROM gift_values WHERE lower(replace(base_name,' ',''))=lower(replace(?,' ',''))").get(gft.base);
  const key = ex ? ex.base_name : gft.base;
  db.prepare("INSERT INTO gift_values(base_name,value,image) VALUES(?,0,?) ON CONFLICT(base_name) DO UPDATE SET image=CASE WHEN COALESCE(image,'')='' THEN excluded.image ELSE image END").run(key, gft.image);
  const val = giftValue(key) || gft.star;
  const conn = m.business_connection_id || getConn();
  const id = db.prepare(`INSERT INTO user_gifts(owner_id,owned_gift_id,connection_id,base_name,name,value,status,created_at,model,backdrop,symbol,number,image)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(m.from.id, gft.ownedId, conn, key, gft.name, val, val > 0 ? 'owned' : 'pending', now(), gft.model, gft.backdrop, gft.symbol, gft.number, gft.image).lastInsertRowid;
  const chat = (m.chat && m.chat.id) || m.from.id;
  const info = [gft.model && `Model: ${gft.model}`, gft.backdrop && `Fon: ${gft.backdrop}`, gft.symbol && `Belgi: ${gft.symbol}`].filter(Boolean).join(' · ');
  let adminNote = '';
  if (val > 0) {
    const r = settleGiftDeposit(id);
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
    if (bc.id) kvSet('bc_id', bc.id);
    if (bc.user && bc.user.id) kvSet('relayer_id', bc.user.id);
    return;
  }
  if (u.business_message) {
    const bm = u.business_message;
    if (bm.business_connection_id && !getConn()) kvSet('bc_id', bm.business_connection_id);
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
    ensureUser(m.from);
    const amount = Number(sp.total_amount);
    const added = db.transaction(() => {
      const r = db.prepare('INSERT OR IGNORE INTO payments(user_id,amount,charge_id,payload,created_at) VALUES(?,?,?,?,?)')
        .run(m.from.id, amount, sp.telegram_payment_charge_id, sp.invoice_payload, now());
      if (!r.changes) return false;
      addBal(m.from.id, amount);
      return true;
    })();
    if (added) await tell(m.chat.id, `✅ To'lov qabul qilindi! Balansingizga +${amount}⭐ qo'shildi.`);
    if (added) for (const a of ADMIN_IDS) await tell(a, `💰 Yangi deposit: ID ${m.from.id} — ${amount}⭐`);
    return;
  }

  // /start
  if (m.text && m.text.startsWith('/start')) {
    const part = m.text.split(/\s+/)[1] || '';
    const ref = part.startsWith('ref_') ? Number(part.slice(4)) : 0;
    ensureUser(m.from, ref);
    if (!WEBAPP_URL) return tell(m.chat.id, 'Mini App manzili (WEBAPP_URL) sozlanmagan.');
    return bot('sendMessage', {
      chat_id: m.chat.id,
      text: '🎁 Epic Gift ga xush kelibsiz!\nO\'ynang, keys oching va Stars yutib oling.',
      reply_markup: { inline_keyboard: [[{ text: '🚀 Epic Gift ni ochish', web_app: { url: WEBAPP_URL } }]] },
    });
  }
}

async function poll() {
  await bot('deleteWebhook');
  const me = await bot('getMe');
  if (me.ok) { BOT_USERNAME = me.result.username; console.log('Bot @' + BOT_USERNAME + ' ishga tushdi'); }
  await bot('setMyCommands', { commands: [{ command: 'start', description: 'Boshlash' }] });
  if (WEBAPP_URL) {
    await bot('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Epic Gift', web_app: { url: WEBAPP_URL } } });
  }
  let offset = 0;
  for (;;) {
    const r = await bot('getUpdates', { offset, timeout: 25 });
    if (!r.ok) { await sleep(3000); continue; }
    for (const u of r.result) {
      offset = u.update_id + 1;
      try { await handleUpdate(u); } catch (e) { console.error('update xatosi:', e); }
    }
  }
}

app.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));
setInterval(() => { try { pvpTick(); } catch (e) { console.error('pvpTick:', e); } }, 1000);
seedNft().catch((e) => console.error('seedNft:', e.message));
poll().catch((e) => console.error('poll to\'xtadi:', e));
