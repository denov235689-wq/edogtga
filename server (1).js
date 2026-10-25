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

const DEFAULTS = {
  rocket_rtp: '95', mines_rtp: '95', min_bet: '1', max_bet: '1000',
  ref_bonus: '5', contest_prize: '100',
};
const insSetting = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
Object.entries(DEFAULTS).forEach(([k, v]) => insSetting.run(k, v));

// Birinchi ishga tushganda namuna keyslar
if (db.prepare('SELECT COUNT(*) c FROM keys_items').get().c === 0) {
  const k1 = db.prepare('INSERT INTO keys_items(name,emoji,price) VALUES(?,?,?)').run('Oddiy Key', '🔑', 10).lastInsertRowid;
  const k2 = db.prepare('INSERT INTO keys_items(name,emoji,price) VALUES(?,?,?)').run('Oltin Key', '🗝️', 50).lastInsertRowid;
  const insR = db.prepare('INSERT INTO key_rewards(key_id,name,value,chance) VALUES(?,?,?,?)');
  [['Mayda', 5, 50], ['Oz', 8, 30], ['Teng', 10, 12], ['Yaxshi', 25, 7], ['Jackpot', 100, 1]].forEach((r) => insR.run(k1, ...r));
  [['Mayda', 20, 50], ['Oz', 40, 30], ['Teng', 50, 12], ['Yaxshi', 120, 7], ['Jackpot', 500, 1]].forEach((r) => insR.run(k2, ...r));
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
  return { items: [...a, ...b].slice(0, 14) };
}));

/* ---- Keys ---- */
app.get('/api/keys', auth, wrap(() => {
  const keys = db.prepare('SELECT id,name,emoji,price FROM keys_items WHERE active=1 ORDER BY price').all();
  const rw = db.prepare('SELECT name,value FROM key_rewards WHERE key_id=? ORDER BY value');
  return { keys: keys.map((k) => ({ ...k, rewards: rw.all(k.id) })) };
}));

app.post('/api/keys/:id/open', auth, wrap((req) => {
  const id = Number(req.params.id);
  const uid = req.user.id;
  const tx = db.transaction(() => {
    const key = db.prepare('SELECT * FROM keys_items WHERE id=? AND active=1').get(id);
    if (!key) fail('Key topilmadi', 404);
    const rw = db.prepare('SELECT * FROM key_rewards WHERE key_id=?').all(id);
    if (!rw.length) fail('Bu keysda mukofot yo\'q');
    if (getBal(uid) < key.price) fail('Balans yetarli emas');
    addBal(uid, -key.price);
    const total = rw.reduce((s, r) => s + r.chance, 0);
    let x = (crypto.randomInt(0, 1e9) / 1e9) * total;
    let pick = rw[rw.length - 1];
    for (const r of rw) { if (x < r.chance) { pick = r; break; } x -= r.chance; }
    addBal(uid, pick.value);
    addScore(uid, key.price);
    return { reward: { name: pick.name, value: pick.value }, balance: getBal(uid) };
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

/* ---- Rocket ---- */
app.get('/api/rocket', auth, wrap(() => {
  const s = allS();
  return { min_bet: s.min_bet, max_bet: s.max_bet, min_target: 1.01, max_target: 1000 };
}));

app.post('/api/rocket/bet', auth, wrap((req) => {
  const bet = parseBet(req.body.bet);
  const target = Math.round(Number(req.body.target) * 100) / 100;
  if (!(target >= 1.01 && target <= 1000)) fail('Koeffitsient 1.01 dan 1000 gacha bo\'lsin');
  const uid = req.user.id;
  const tx = db.transaction(() => {
    if (getBal(uid) < bet) fail('Balans yetarli emas');
    addBal(uid, -bet);
    const rtp = getS('rocket_rtp') / 100;
    const r = crypto.randomInt(0, 1e9) / 1e9;
    let crash = Math.floor((rtp / (1 - r)) * 100) / 100;
    crash = Math.min(1000, Math.max(1, crash));
    const win = crash >= target ? Math.floor(bet * target) : 0;
    if (win > 0) addBal(uid, win);
    db.prepare('INSERT INTO rocket_bets(user_id,bet,target,crash,win,created_at) VALUES(?,?,?,?,?,?)')
      .run(uid, bet, target, crash, win, now());
    addScore(uid, bet);
    return { crash, win, balance: getBal(uid) };
  });
  return tx();
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
  return { id: g.id, bet: g.bet, mines_count: g.mines_count, opened, multiplier: m, next: n, win_now: Math.floor(g.bet * m) };
}
function pickMines(c) {
  const a = [...Array(MINES_N).keys()];
  for (let i = MINES_N - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, c);
}
function minesCashout(g) {
  const win = minesState(g).win_now;
  db.prepare("UPDATE mines_games SET status='won', win=? WHERE id=?").run(win, g.id);
  addBal(g.user_id, win);
  return win;
}

app.post('/api/mines/start', auth, wrap((req) => {
  const bet = parseBet(req.body.bet);
  const mc = Number(req.body.mines);
  if (!Number.isInteger(mc) || mc < 1 || mc > 24) fail('Minalar soni 1 dan 24 gacha');
  const uid = req.user.id;
  const tx = db.transaction(() => {
    const act = activeMines(uid);
    if (act) return { resumed: true, game: minesState(act) };
    if (getBal(uid) < bet) fail('Balans yetarli emas');
    addBal(uid, -bet);
    const info = db.prepare('INSERT INTO mines_games(user_id,bet,mines_count,mines,created_at) VALUES(?,?,?,?,?)')
      .run(uid, bet, mc, JSON.stringify(pickMines(mc)), now());
    addScore(uid, bet);
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
      return { status: 'lost', mines, cell };
    }
    opened.push(cell);
    g.opened = JSON.stringify(opened);
    db.prepare('UPDATE mines_games SET opened=? WHERE id=?').run(g.opened, g.id);
    if (opened.length >= MINES_N - g.mines_count) {
      const win = minesCashout(g);
      return { status: 'won', win, mines, opened };
    }
    return { status: 'safe', game: minesState(g) };
  });
  const r = tx();
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
    return { status: 'won', win, mines: JSON.parse(g.mines), opened: JSON.parse(g.opened) };
  });
  const r = tx();
  r.balance = getBal(uid);
  return r;
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
    rocket: db.prepare('SELECT bet,target,crash,win,created_at FROM rocket_bets WHERE user_id=? ORDER BY id DESC LIMIT 10').all(uid),
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
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
  };
}));

ADMIN.post('/settings', wrap((req) => {
  const b = req.body || {};
  const cur = allS();
  for (const k of Object.keys(DEFAULTS)) {
    if (!(k in b)) continue;
    const v = Number(b[k]);
    if (!Number.isFinite(v) || v < 0) fail(`${k} noto'g'ri`);
    if ((k === 'rocket_rtp' || k === 'mines_rtp') && (v < 1 || v > 100)) fail('RTP 1 dan 100 gacha bo\'lsin');
    if ((k === 'min_bet' || k === 'max_bet') && (!Number.isInteger(v) || v < 1)) fail('Stavka butun son (>=1) bo\'lsin');
    cur[k] = v;
  }
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
  const price = Number(b.price);
  if (!b.name || !Number.isInteger(price) || price < 1) fail('Key nomi va narxi (butun son) kerak');
  return { name: String(b.name).slice(0, 40), emoji: String(b.emoji || '🔑').slice(0, 8), price, rewards: cleanRewards(b.rewards) };
}
const saveRewards = (keyId, rewards) => {
  db.prepare('DELETE FROM key_rewards WHERE key_id=?').run(keyId);
  const ins = db.prepare('INSERT INTO key_rewards(key_id,name,value,chance) VALUES(?,?,?,?)');
  rewards.forEach((r) => ins.run(keyId, r.name, r.value, r.chance));
};

ADMIN.post('/keys', wrap((req) => {
  const k = cleanKey(req.body || {});
  return db.transaction(() => {
    const id = db.prepare('INSERT INTO keys_items(name,emoji,price) VALUES(?,?,?)').run(k.name, k.emoji, k.price).lastInsertRowid;
    saveRewards(id, k.rewards);
    return { id };
  })();
}));
ADMIN.put('/keys/:id', wrap((req) => {
  const id = Number(req.params.id);
  const k = cleanKey(req.body || {});
  const active = req.body.active === 0 || req.body.active === false ? 0 : 1;
  db.transaction(() => {
    const r = db.prepare('UPDATE keys_items SET name=?,emoji=?,price=?,active=? WHERE id=?').run(k.name, k.emoji, k.price, active, id);
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

app.use('/api/admin', ADMIN);
app.use('/api', (req, res) => res.status(404).json({ error: 'Topilmadi' }));

/* ===================== BOT: UPDATE'LAR ===================== */
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

  const m = u.message;
  if (!m || !m.from) return;

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
poll().catch((e) => console.error('poll to\'xtadi:', e));
