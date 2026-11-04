'use strict';
/* ===================== Epic Gift — db.js (Supabase / Postgres) =====================
 * Hamma ma'lumot Supabase Postgres da saqlanadi (Render qayta ishga tushsa ham o'chmaydi).
 * Tranzaksiya ichida chaqirilgan so'rovlar avtomatik shu tranzaksiyaga ulanadi (AsyncLocalStorage).
 */
const { AsyncLocalStorage } = require('async_hooks');
const { Pool, types } = require('pg');

// BIGINT / NUMERIC ni satr emas, son qilib qaytaramiz
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));

const als = new AsyncLocalStorage();
let pool = null;

function connect(url) {
  pool = new Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX) || 8,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  });
  pool.on('error', (e) => console.error('[pg] pool xatosi:', e.message));
  return pool;
}

const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
const exec = (sql, params = []) => (als.getStore() || pool).query(toPg(sql), params);
const all = async (sql, params) => (await exec(sql, params)).rows;
const one = async (sql, params) => (await exec(sql, params)).rows[0] || null;
const run = async (sql, params) => ({ changes: (await exec(sql, params)).rowCount });
// INSERT ... RETURNING id
const insert = async (sql, params) => (await exec(`${sql} RETURNING id`, params)).rows[0].id;

async function tx(fn) {
  if (als.getStore()) return fn(); // ichma-ich: tashqi tranzaksiyaga qo'shiladi
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const res = await als.run(c, fn);
    await c.query('COMMIT');
    return res;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (e2) { /* ignore */ }
    throw e;
  } finally {
    c.release();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id BIGINT PRIMARY KEY, first_name TEXT, username TEXT, photo_url TEXT,
  balance BIGINT NOT NULL DEFAULT 0, referrer BIGINT, created_at BIGINT
);
CREATE TABLE IF NOT EXISTS keys_items(
  id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, emoji TEXT DEFAULT '🔑',
  price BIGINT NOT NULL, active INTEGER DEFAULT 1, cooldown_hours INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS key_rewards(
  id BIGSERIAL PRIMARY KEY, key_id BIGINT NOT NULL, name TEXT NOT NULL,
  value BIGINT NOT NULL, chance DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS gifts(
  id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, emoji TEXT DEFAULT '🎁',
  price BIGINT NOT NULL, active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rocket_bets(
  id BIGSERIAL PRIMARY KEY, user_id BIGINT, bet BIGINT, target DOUBLE PRECISION,
  crash DOUBLE PRECISION, win BIGINT, created_at BIGINT, status TEXT DEFAULT 'done',
  started_ms BIGINT, gift_id BIGINT
);
CREATE TABLE IF NOT EXISTS mines_games(
  id BIGSERIAL PRIMARY KEY, user_id BIGINT, bet BIGINT, mines_count INTEGER,
  mines TEXT, opened TEXT DEFAULT '[]', status TEXT DEFAULT 'active', win BIGINT DEFAULT 0,
  created_at BIGINT, gift_id BIGINT
);
CREATE TABLE IF NOT EXISTS contest_scores(user_id BIGINT PRIMARY KEY, score BIGINT DEFAULT 0);
CREATE TABLE IF NOT EXISTS payments(
  id BIGSERIAL PRIMARY KEY, user_id BIGINT, amount BIGINT,
  charge_id TEXT UNIQUE, payload TEXT, created_at BIGINT
);
CREATE TABLE IF NOT EXISTS user_gifts(
  id BIGSERIAL PRIMARY KEY, owner_id BIGINT, owned_gift_id TEXT, connection_id TEXT,
  base_name TEXT, name TEXT, value BIGINT NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'owned',
  created_at BIGINT, lost_at BIGINT, model TEXT, backdrop TEXT, symbol TEXT, image TEXT,
  number BIGINT, source TEXT
);
CREATE TABLE IF NOT EXISTS gift_values(base_name TEXT PRIMARY KEY, value BIGINT NOT NULL, image TEXT);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS plinko_games(
  id BIGSERIAL PRIMARY KEY, user_id BIGINT, bet BIGINT, rows INTEGER, risk TEXT,
  slot INTEGER, mult DOUBLE PRECISION, win BIGINT, gift_id BIGINT, created_at BIGINT
);
CREATE TABLE IF NOT EXISTS upgrade_games(
  id BIGSERIAL PRIMARY KEY, user_id BIGINT, stake BIGINT, target TEXT, target_value BIGINT,
  chance DOUBLE PRECISION, roll DOUBLE PRECISION, win INTEGER, gift_id BIGINT, created_at BIGINT
);
CREATE TABLE IF NOT EXISTS pvp_rounds(
  id BIGSERIAL PRIMARY KEY, status TEXT NOT NULL DEFAULT 'waiting', seed TEXT, hash TEXT,
  roll DOUBLE PRECISION, start_at BIGINT, total BIGINT DEFAULT 0, winner_id BIGINT,
  payout BIGINT DEFAULT 0, created_at BIGINT, finished_at BIGINT
);
CREATE TABLE IF NOT EXISTS pvp_entries(
  id BIGSERIAL PRIMARY KEY, round_id BIGINT, user_id BIGINT, stake BIGINT,
  created_at BIGINT, seen INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS key_cooldowns(
  user_id BIGINT, key_id BIGINT, last_open BIGINT, PRIMARY KEY(user_id, key_id)
);
CREATE TABLE IF NOT EXISTS promo_codes(
  code TEXT PRIMARY KEY, stars BIGINT DEFAULT 0, gift_name TEXT DEFAULT '', max_uses INTEGER DEFAULT 0,
  used INTEGER DEFAULT 0, expires_at BIGINT DEFAULT 0, active INTEGER DEFAULT 1, created_at BIGINT
);
CREATE TABLE IF NOT EXISTS promo_uses(code TEXT, user_id BIGINT, created_at BIGINT, PRIMARY KEY(code, user_id));

-- Hamma narsani yozib borish: balans harakatlari, admin amallari va muhim voqealar
CREATE TABLE IF NOT EXISTS balance_log(
  id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, delta BIGINT NOT NULL,
  balance_after BIGINT, reason TEXT, ref TEXT, created_at BIGINT
);
CREATE TABLE IF NOT EXISTS admin_log(
  id BIGSERIAL PRIMARY KEY, admin_id BIGINT, action TEXT, detail TEXT, created_at BIGINT
);
CREATE TABLE IF NOT EXISTS events(
  id BIGSERIAL PRIMARY KEY, kind TEXT, user_id BIGINT, data TEXT, created_at BIGINT
);

CREATE INDEX IF NOT EXISTS ix_user_gifts_owner ON user_gifts(owner_id, status);
CREATE INDEX IF NOT EXISTS ix_user_gifts_owned_id ON user_gifts(owned_gift_id);
CREATE INDEX IF NOT EXISTS ix_user_gifts_base ON user_gifts(base_name);
CREATE INDEX IF NOT EXISTS ix_rocket_user ON rocket_bets(user_id, status);
CREATE INDEX IF NOT EXISTS ix_mines_user ON mines_games(user_id, status);
CREATE INDEX IF NOT EXISTS ix_plinko_user ON plinko_games(user_id);
CREATE INDEX IF NOT EXISTS ix_upgrade_user ON upgrade_games(user_id);
CREATE INDEX IF NOT EXISTS ix_pvp_entries_round ON pvp_entries(round_id, user_id);
CREATE INDEX IF NOT EXISTS ix_pvp_rounds_status ON pvp_rounds(status);
CREATE INDEX IF NOT EXISTS ix_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS ix_balance_log_user ON balance_log(user_id, id);
CREATE INDEX IF NOT EXISTS ix_events_kind ON events(kind, id);
`;

async function initSchema() {
  // bir vaqtda bir nechta nusxa ishga tushsa, jadval yaratish to'qnashmasligi uchun
  await tx(async () => {
    await exec('SELECT pg_advisory_xact_lock(424242)');
    await exec(SCHEMA);
  });
  // Xavfsizlik: Supabase ochiq API (anon kalit) orqali balans/gift jadvallariga kirib bo'lmasin.
  // Server "postgres" roli bilan ulanadi va RLS ni chetlab o'tadi, shuning uchun ishlashga ta'sir qilmaydi.
  for (const m of SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)) {
    try { await exec(`ALTER TABLE ${m[1]} ENABLE ROW LEVEL SECURITY`); } catch (e) { console.error(`[db] RLS yoqilmadi (${m[1]}):`, e.message); }
  }
}

module.exports = { connect, exec, all, one, run, insert, tx, initSchema, close: () => pool && pool.end() };
