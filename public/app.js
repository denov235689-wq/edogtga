(() => {
  'use strict';
  /* ============ Asosiy yordamchilar ============ */
  const tg = (window.PaxtaGram && window.PaxtaGram.WebApp) || (window.Telegram && window.Telegram.WebApp) || null;
  if (tg) { try { tg.ready(); if (tg.expand) tg.expand(); } catch (e) { /* ignore */ } }
  const initData = tg ? tg.initData : '';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtN = (n) => Number(n || 0).toLocaleString('en-US');
  const fmtMax = (v) => (Number(v) >= 1e9 ? 'cheksiz' : fmtN(v));
  const normN = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const fx = (m) => { m = Number(m); return m >= 100 ? m.toFixed(0) : m >= 10 ? m.toFixed(1) : m.toFixed(2); };
  const fmtDate = (t) => new Date(t * 1000).toLocaleString('uz-UZ', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);

  async function api(path, method = 'GET', body) {
    const r = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Init-Data': initData },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({ error: 'Javob o\'qilmadi' }));
    if (!r.ok) throw new Error(j.error || 'Xatolik');
    return j;
  }

  let toastT;
  function toast(msg, err) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show' + (err ? ' err' : '');
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.className = ''; }, 2800);
  }
  const fail = (e) => toast(e.message || 'Xatolik', true);

  function modal(html) {
    const m = $('#modal');
    m.innerHTML = `<div class="sheet">${html}<button class="btn ghost" id="mClose">Yopish</button></div>`;
    m.classList.add('show');
    $('#mClose').onclick = closeModal;
    m.onclick = (e) => { if (e.target === m) closeModal(); };
  }
  function closeModal() { $('#modal').classList.remove('show'); $('#modal').innerHTML = ''; }

  // Rasm yuklanmasa emoji ko'rsatiladi
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && t.dataset && t.dataset.fb) t.replaceWith(document.createTextNode(t.dataset.fb));
  }, true);

  /* ============ Holat ============ */
  let me = null;
  let minesGame = null;
  let minesBusy = false;
  let pvTimer = 0;
  let pvTimer2 = 0;
  let depTimer = 0;
  let current = 'home';

  function setBalance(b) {
    if (me) me.balance = b;
    $('#bal').textContent = fmtN(b);
  }
  function setMe(m) {
    me = m;
    setBalance(m.balance);
    const av = $('#avatar');
    if (m.photo_url) av.innerHTML = `<img src="${esc(m.photo_url)}" alt="">`;
    else av.textContent = (m.first_name || '?').trim().charAt(0).toUpperCase() || '?';
  }
  async function refreshMe() { setMe(await api('/me')); }

  /* ============ Gift yordamchilari ============ */
  const GE = { 'b-day candle': '🕯️', 'lol pop': '🍭', 'star notepad': '📓', 'precious peach': '🍑', 'scared cat': '🐱', 'swiss watch': '⌚', 'maple leaf': '🍁', 'money tree': '💰', 'cake': '🎂', 'mask': '🎭', 'resistance dog': '🐕' };
  const giftEmoji = (n) => GE[String(n || '').toLowerCase()] || '🎁';
  function gimg(g) {
    const e = giftEmoji(g.base_name || g.n || g.name);
    const url = g.image || g.img;
    return `<div class="gimg">${url ? `<img src="${esc(url)}" alt="" data-fb="${e}">` : e}</div>`;
  }
  function giftCard(g, fee, actions) {
    const info = [g.model && `Model: ${g.model}`, g.backdrop && `Fon: ${g.backdrop}`, g.symbol && `Belgi: ${g.symbol}`].filter(Boolean).map(esc).join('<br>');
    let st = '';
    if (g.status === 'bet') st = '<span class="st">🎲 stavkada</span>';
    else if (g.status === 'pending' || !g.value) st = '<span class="st">⏳ narx kutilmoqda</span>';
    else if (actions) st = `<div class="gbtn"><button class="s" data-gsell="${g.id}">Sotish</button><button data-gwd="${g.id}">${g.source === 'key' ? 'Chiqarish BEPUL' : 'Chiqarish ' + fmtN(fee) + '⭐'}</button></div>`;
    return `<div class="gcard">${gimg(g)}<b>${esc(g.name)}${g.number ? ' #' + g.number : ''}</b>${info ? `<small>${info}</small>` : ''}<div class="gp">⭐ ${g.value ? fmtN(g.value) : '—'}</div>${st}</div>`;
  }

  /* ============ Navigatsiya ============ */
  const loaders = {
    rocket: () => loadRocket(), plinko: () => loadPlinko(), upgrade: () => loadUpgrade(), pvp: () => loadPvp(), mines: () => loadMines(), keys: () => loadKeys(),
    backpack: () => loadBackpack(), invite: () => loadInvite(), leaderboard: () => loadLb(), earn: () => loadEarn(), deposit: () => loadDeposit(),
  };
  function show(name) {
    const prev = current;
    current = name;
    $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));
    $$('.bottom button').forEach((b) => b.classList.toggle('on', b.dataset.go === name));
    window.scrollTo(0, 0);
    if (prev === 'rocket' && name !== 'rocket') rsRun(false);
    if (prev === 'plinko' && name !== 'plinko') { plFlush(); plRun(false); }
    clearInterval(pvTimer);
    clearInterval(pvTimer2);
    clearInterval(depTimer);
    if (name === 'pvp') { pvTimer = setInterval(() => loadPvp().catch(() => {}), 1000); pvTimer2 = setInterval(() => pvHubUpdate(), 250); }
    if (name === 'deposit') depTimer = setInterval(() => pollDepGifts().catch(() => {}), 4000);
    if (loaders[name]) loaders[name]().catch(fail);
  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-go]');
    if (t) show(t.dataset.go);
  });
  $('#depBtn').onclick = () => show('deposit');

  /* ============ Live bar ============ */
  async function loadLive() {
    let items = [];
    try { items = (await api('/live')).items; } catch (e) { /* jim */ }
    if (!items.length) items = ['🎁', '🚀', '💎', '🔑', '🔮', '🎂', '⭐', '🍭'].map((e) => ({ e, w: 0 }));
    const tile = (x, i) => `<div class="lt c${i % 3}">${x.e}<small>${x.w ? '+' + (x.w >= 10000 ? Math.round(x.w / 1000) + 'k' : fmtN(x.w)) : ''}</small></div>`;
    const html = items.map(tile).join('');
    $('#liveTrack').innerHTML = html + html;
  }

  /* ============ Stavka turi (Stars / Gift) ============ */
  async function fillGifts(sel) {
    const { gifts } = await api('/mygifts');
    const ok = gifts.filter((g) => g.status === 'owned' && g.value > 0);
    sel.innerHTML = ok.length
      ? ok.map((g) => `<option value="${g.id}" data-v="${g.value}">${esc(g.name)} — ${fmtN(g.value)}⭐</option>`).join('')
      : '<option value="">Gift yo\'q yoki narxi belgilanmagan</option>';
  }
  function setupSeg(prefix) {
    const seg = document.querySelector(`[data-seg="${prefix}"]`);
    seg.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      const gift = b.dataset.mode === 'gift';
      $(`#${prefix}Stars`).hidden = gift;
      $(`#${prefix}Gift`).hidden = !gift;
      if (gift) fillGifts($(`#${prefix}GiftSel`)).then(() => { if (prefix === 'up') updateUpChance(); }).catch(fail);
      else if (prefix === 'up') updateUpChance();
    };
  }
  function stakeBody(prefix) {
    if (!$(`#${prefix}Gift`).hidden) {
      const id = Number($(`#${prefix}GiftSel`).value);
      if (!id) throw new Error('Avval gift tanlang');
      return { gift_id: id };
    }
    return { bet: Number($(`#${prefix}Bet`).value) };
  }
  setupSeg('rk'); setupSeg('m'); setupSeg('pl'); setupSeg('up');
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.quick button');
    if (!b) return;
    const inp = $('#' + b.parentElement.dataset.for);
    const mn = me ? me.min_bet : 1;
    const mx = me ? me.max_bet : 1000;
    let v = Number(inp.value) || mn;
    if (b.dataset.op === 'half') v = Math.max(mn, Math.floor(v / 2));
    else if (b.dataset.op === 'double') v = Math.min(mx, v * 2);
    else v = Math.max(mn, Math.min(mx, me ? me.balance : mx));
    inp.value = v;
  });

  /* ============ ROCKET: canvas sahna ============ */
  const RS = { cv: null, ctx: null, w: 340, h: 330, stars: [], parts: [], trail: [], state: 'idle', t: 0, last: 0, raf: 0, run: false, shake: 0, p: 0, m: 1, ex: 0, ey: 0, ea: 0, escT: 0 };
  const rk = { poll: 0, t0: 0, k: 0.18, stake: 0, gift: false, target: null, busy: false };

  function rsSetup() {
    RS.cv = $('#rkCanvas');
    RS.ctx = RS.cv.getContext('2d');
    if (!RS.stars.length) for (let i = 0; i < 90; i++) RS.stars.push({ x: Math.random(), y: Math.random(), r: rand(0.4, 1.9), tw: rand(0, 6) });
    rsResize();
  }
  function rsResize() {
    if (!RS.cv) return;
    const r = RS.cv.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    RS.w = Math.max(200, r.width || 340);
    RS.h = Math.max(200, r.height || 330);
    RS.cv.width = Math.round(RS.w * dpr);
    RS.cv.height = Math.round(RS.h * dpr);
    RS.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function rsRun(on) {
    if (on && !RS.run) { RS.run = true; RS.last = performance.now(); RS.raf = requestAnimationFrame(rsLoop); }
    else if (!on) { RS.run = false; cancelAnimationFrame(RS.raf); }
  }
  function rsLoop(ts) {
    if (!RS.run) return;
    const dt = Math.min(0.05, (ts - RS.last) / 1000);
    RS.last = ts;
    rsUpdate(dt);
    rsDraw();
    RS.raf = requestAnimationFrame(rsLoop);
  }
  function rsPos() {
    const p = RS.p;
    if (RS.state === 'idle') return { x: RS.w * 0.5, y: RS.h * 0.7 + Math.sin(RS.t * 2) * 3, a: 0 };
    if (RS.state === 'escape') return { x: RS.ex, y: RS.ey, a: RS.ea };
    return { x: RS.w * (0.3 + 0.4 * p) + Math.sin(RS.t * 3) * 2, y: RS.h * (0.74 - 0.38 * p) + Math.cos(RS.t * 4) * 2, a: 0.12 + 0.5 * p };
  }
  function rsFlame(x, y, a, power) {
    const sc = 0.95;
    const tx = x - Math.sin(a) * 28 * sc;
    const ty = y + Math.cos(a) * 28 * sc;
    for (let i = 0; i < 2; i++) {
      const sp = 70 + power * 160;
      RS.parts.push({ x: tx + rand(-3, 3), y: ty, vx: -Math.sin(a) * sp * 0.6 + rand(-25, 25), vy: Math.cos(a) * sp * 0.6 + rand(0, 40), life: 0.5, max: 0.5, r: rand(2.5, 5.5), c: `255,${120 + Math.floor(rand(0, 110))},40` });
    }
  }
  function rsCrash() {
    const { x, y } = rsPos();
    RS.state = 'crash';
    RS.shake = 1;
    for (let i = 0; i < 90; i++) {
      const a = rand(0, 6.283);
      const sp = rand(40, 320);
      const smoke = i % 3 === 0;
      RS.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.7, 1.5), max: 1.5, r: smoke ? rand(6, 14) : rand(2, 6), c: smoke ? '120,120,140' : `255,${150 + Math.floor(rand(0, 100))},${Math.floor(rand(0, 80))}` });
    }
  }
  function rsEscape() {
    const { x, y, a } = rsPos();
    RS.state = 'escape';
    RS.ex = x; RS.ey = y; RS.ea = a; RS.escT = 0;
  }
  function rsUpdate(dt) {
    RS.t += dt;
    if (RS.state === 'fly') {
      const m = Math.exp((rk.k * (performance.now() - rk.t0)) / 1000);
      RS.m = m;
      RS.p = Math.min(1, Math.log(Math.max(1, m)) / Math.log(10));
      rkTick(m);
    }
    const speed = RS.state === 'fly' ? 40 + 320 * RS.p : RS.state === 'escape' ? 700 : RS.state === 'idle' ? 14 : 0;
    RS.stars.forEach((s) => {
      s.y += (speed * dt * s.r) / RS.h;
      s.x -= (speed * 0.2 * dt * s.r) / RS.w;
      if (s.y > 1) { s.y = 0; s.x = Math.random(); }
      if (s.x < 0) s.x = 1;
    });
    if (RS.state === 'fly' || RS.state === 'idle') {
      const pos = rsPos();
      rsFlame(pos.x, pos.y, pos.a, RS.state === 'fly' ? 0.6 + RS.p : 0.25);
      if (RS.state === 'fly') RS.trail.push({ x: pos.x - Math.sin(pos.a) * 24, y: pos.y + Math.cos(pos.a) * 24, life: 1 });
    }
    if (RS.state === 'escape') {
      RS.escT += dt;
      RS.ey -= (260 + RS.escT * 900) * dt;
      RS.ex += 150 * dt;
      rsFlame(RS.ex, RS.ey, RS.ea, 1.4);
      if (RS.ey < -80) RS.state = 'gone';
    }
    RS.trail.forEach((q) => { q.life -= dt * 1.1; });
    RS.trail = RS.trail.filter((q) => q.life > 0);
    RS.parts.forEach((q) => { q.life -= dt; q.x += q.vx * dt; q.y += q.vy * dt; });
    RS.parts = RS.parts.filter((q) => q.life > 0);
  }
  function drawRocket(c, x, y, sc, a, flame) {
    c.save();
    c.translate(x, y); c.rotate(a); c.scale(sc, sc);
    if (flame > 0) {
      const fl = 26 * flame * (0.8 + Math.random() * 0.5);
      const g = c.createLinearGradient(0, 18, 0, 18 + fl);
      g.addColorStop(0, '#fff3b0'); g.addColorStop(1, 'rgba(255,90,0,0)');
      c.fillStyle = g; c.beginPath(); c.moveTo(-8, 18); c.quadraticCurveTo(0, 18 + fl * 1.3, 8, 18); c.closePath(); c.fill();
    }
    c.fillStyle = '#e5383b';
    c.beginPath(); c.moveTo(-10, -2); c.lineTo(-24, 26); c.lineTo(-9, 18); c.closePath(); c.fill();
    c.beginPath(); c.moveTo(10, -2); c.lineTo(24, 26); c.lineTo(9, 18); c.closePath(); c.fill();
    c.fillStyle = '#94a3b8'; c.fillRect(-6, 19, 12, 5);
    c.fillStyle = '#fff';
    c.beginPath(); c.moveTo(0, -40); c.bezierCurveTo(18, -24, 16, 8, 11, 20); c.lineTo(-11, 20); c.bezierCurveTo(-16, 8, -18, -24, 0, -40); c.fill();
    c.fillStyle = '#e5383b';
    c.beginPath(); c.moveTo(0, -40); c.bezierCurveTo(9, -32, 14, -24, 15, -17); c.lineTo(-15, -17); c.bezierCurveTo(-14, -24, -9, -32, 0, -40); c.fill();
    c.fillStyle = '#3b82f6'; c.strokeStyle = '#dbeafe'; c.lineWidth = 3;
    c.beginPath(); c.arc(0, -3, 7, 0, 6.283); c.fill(); c.stroke();
    c.restore();
  }
  function rsDraw() {
    const c = RS.ctx;
    const { w, h } = RS;
    c.save();
    if (RS.shake > 0) { c.translate((Math.random() - 0.5) * 12 * RS.shake, (Math.random() - 0.5) * 12 * RS.shake); RS.shake = Math.max(0, RS.shake - 0.03); }
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#060a22'); g.addColorStop(0.6, '#13215c'); g.addColorStop(1, '#2d41a0');
    c.fillStyle = g; c.fillRect(-20, -20, w + 40, h + 40);
    RS.stars.forEach((s) => {
      c.globalAlpha = 0.45 + 0.55 * Math.abs(Math.sin(RS.t * 1.5 + s.tw));
      c.fillStyle = '#fff'; c.beginPath(); c.arc(s.x * w, s.y * h, s.r, 0, 6.283); c.fill();
    });
    c.globalAlpha = 1;
    const gy = h * 0.98 + RS.p * h * 1.3;
    const pg = c.createRadialGradient(w * 0.5, gy, 10, w * 0.5, gy, w * 0.9);
    pg.addColorStop(0, '#5f86ff'); pg.addColorStop(0.35, '#2a3d96'); pg.addColorStop(1, 'rgba(20,30,90,0)');
    c.fillStyle = pg; c.beginPath(); c.ellipse(w * 0.5, gy + h * 0.35, w * 0.95, h * 0.55, 0, 0, 6.283); c.fill();
    if (RS.trail.length > 1) {
      c.lineCap = 'round';
      for (let i = 1; i < RS.trail.length; i++) {
        const a = RS.trail[i - 1]; const b = RS.trail[i];
        c.strokeStyle = `rgba(255,190,90,${Math.max(0, b.life) * 0.55})`;
        c.lineWidth = 2 + b.life * 5;
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
      }
    }
    RS.parts.forEach((q) => {
      c.fillStyle = `rgba(${q.c},${Math.max(0, q.life / q.max)})`;
      c.beginPath(); c.arc(q.x, q.y, q.r * (0.5 + 0.5 * (q.life / q.max)), 0, 6.283); c.fill();
    });
    if (RS.state === 'idle' || RS.state === 'fly' || RS.state === 'escape') {
      const pos = rsPos();
      drawRocket(c, pos.x, pos.y, 0.95, pos.a, RS.state === 'idle' ? 0.35 : 1);
    }
    c.restore();
  }

  function rkTick(m) {
    $('#rkMult').textContent = fx(Math.floor(m * 100) / 100) + 'x';
    const total = Math.floor(rk.stake * m);
    $('#rkCash').textContent = rk.gift ? `Yechib olish: ${fmtN(total)}⭐ (gift sotiladi)` : `Yechib olish: ${fmtN(total)}⭐`;
  }
  function rkStart(v) {
    rk.k = v.k; rk.stake = v.bet; rk.gift = v.gift; rk.target = v.target;
    rk.t0 = performance.now() - v.elapsed_ms;
    $('.stage').className = 'stage';
    $('#rkSetup').hidden = true;
    $('#rkCash').hidden = false;
    $('#rkCash').disabled = false;
    $('#rkStatus').textContent = v.target ? `Avto yechish: ${v.target}x` : 'Xohlagan paytda "Yechib olish" ni bosing';
    RS.trail = []; RS.p = 0; RS.state = 'fly';
    rsRun(true);
    clearInterval(rk.poll);
    rk.poll = setInterval(rkPoll, 350);
  }
  async function rkPoll() {
    if (rk.busy) return;
    rk.busy = true;
    try {
      const r = await api('/rocket/state');
      if (r.status === 'won' || r.status === 'lost') rkFinish(r);
    } catch (e) { /* keyingi urinishda */ }
    rk.busy = false;
  }
  function rkFinish(r) {
    clearInterval(rk.poll);
    const won = r.status === 'won';
    $('.stage').className = 'stage ' + (won ? 'win' : 'lose');
    $('#rkMult').textContent = fx(won ? r.mult : r.crash) + 'x';
    $('#rkCash').hidden = true;
    $('#rkSetup').hidden = false;
    setBalance(r.balance);
    if (won) { rsEscape(); toast(r.gift ? `🎉 Yutdingiz! Gift sotildi: +${fmtN(r.win)}⭐` : `🎉 Yutdingiz: +${fmtN(r.win)}⭐`); }
    else { rsCrash(); toast(r.gift ? '💥 Portladi! Gift adminga o\'tdi' : `💥 Portladi: ${fx(r.crash)}x`, true); }
    $('#rkStatus').textContent = `Portlash nuqtasi: ${fx(r.crash)}x`;
    loadLive();
    if (!$('#rkGift').hidden) fillGifts($('#rkGiftSel')).catch(() => {});
  }
  $('#rkGo').onclick = async () => {
    const btn = $('#rkGo');
    btn.disabled = true;
    try {
      const body = stakeBody('rk');
      const t = $('#rkTarget').value.trim();
      if (t) body.target = Number(t);
      const v = await api('/rocket/bet', 'POST', body);
      setBalance(v.balance);
      rkStart(v);
    } catch (e) { fail(e); }
    btn.disabled = false;
  };
  $('#rkCash').onclick = async () => {
    $('#rkCash').disabled = true;
    try {
      const r = await api('/rocket/cashout', 'POST');
      if (r.status === 'won' || r.status === 'lost') rkFinish(r);
    } catch (e) { fail(e); $('#rkCash').disabled = false; }
  };
  async function loadRocket() {
    rsSetup();
    rsRun(true);
    const r = await api('/rocket');
    $('#rkInfo').textContent = `Stavka: ${fmtN(r.min_bet)} – ${fmtMax(r.max_bet)} ⭐ · Avto yechish: ${r.min_target}x – ${r.max_target}x`;
    const s = await api('/rocket/state');
    if (s.status === 'active') rkStart(s);
    else if (s.status === 'won' || s.status === 'lost') rkFinish(s);
    else if (RS.state !== 'fly') { RS.state = 'idle'; RS.p = 0; RS.trail = []; $('.stage').className = 'stage'; $('#rkMult').textContent = '1.00x'; }
  }

  /* ============ PLINKO ============ */
  const PL = { cv: null, ctx: null, w: 340, h: 392, rows: 12, risk: 'mid', data: null, balls: [], hit: {}, flash: {}, run: false, raf: 0, last: 0, sx: 20, sy: 20, top: 36, cx: 170, slotH: 28 };
  const plTable = () => PL.data.tables[PL.rows][PL.risk];
  function plColor(k) {
    const d = Math.abs(k - PL.rows / 2) / (PL.rows / 2);
    return `hsl(${Math.round(52 - 52 * d)},92%,${Math.round(58 - 6 * d)}%)`;
  }
  function plLayout() {
    PL.sx = (PL.w - 28) / PL.rows;
    PL.sy = (PL.h - PL.top - PL.slotH - 24) / PL.rows;
    PL.cx = PL.w / 2;
  }
  const plPeg = (r, j) => ({ x: PL.cx + (j - r / 2) * PL.sx, y: PL.top + r * PL.sy });
  function plResize() {
    if (!PL.cv) return;
    const r = PL.cv.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    PL.w = Math.max(220, r.width || 340);
    PL.h = Math.max(260, r.height || 392);
    PL.cv.width = Math.round(PL.w * dpr);
    PL.cv.height = Math.round(PL.h * dpr);
    PL.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    plLayout();
  }
  function plRun(on) {
    if (on && !PL.run) { PL.run = true; PL.last = performance.now(); PL.raf = requestAnimationFrame(plLoop); }
    else if (!on) { PL.run = false; cancelAnimationFrame(PL.raf); }
  }
  function plBuild(path) {
    const n = path.length;
    const pts = [{ x: PL.cx, y: PL.top - PL.sy * 0.9 }];
    const keys = [null];
    let k = 0;
    for (let r = 0; r < n; r++) {
      const pg = plPeg(r, k);
      pts.push({ x: pg.x, y: pg.y - 7 });
      keys.push(r + '_' + k);
      k += path[r];
    }
    pts.push({ x: PL.cx + (k - n / 2) * PL.sx, y: PL.top + n * PL.sy + 18 });
    keys.push('slot');
    return { pts, keys };
  }
  function plLand(b) {
    if (b.landed) return;
    b.landed = true;
    const r = b.res;
    setBalance(r.balance);
    PL.flash[r.slot] = 1;
    const chip = document.createElement('i');
    chip.style.background = plColor(r.slot);
    chip.textContent = fx(r.mult) + 'x';
    const box = $('#plLast');
    box.prepend(chip);
    while (box.children.length > 9) box.lastChild.remove();
    if (r.win > 0) toast(`🔮 ${fx(r.mult)}x · +${fmtN(r.win)}⭐${r.gift ? ' (gift sotildi)' : ''}`);
    else if (r.gift) toast('🔮 Gift adminga o\'tdi', true);
    loadLive();
  }
  function plFlush() {
    PL.balls.forEach(plLand);
    PL.balls = [];
    plToggleCtl();
  }
  function plToggleCtl() {
    const busy = PL.balls.length > 0;
    $('#plRows').disabled = busy;
    $$('#plRisk button').forEach((b) => { b.disabled = busy; });
  }
  function plLoop(ts) {
    if (!PL.run) return;
    const dt = Math.min(0.05, (ts - PL.last) / 1000);
    PL.last = ts;
    PL.balls.forEach((b) => {
      if (b.landed) { b.fade = (b.fade || 0) + dt; return; }
      b.t += dt / 0.12;
      while (b.t >= 1 && !b.landed) {
        b.t -= 1; b.i++;
        if (b.keys[b.i] && b.keys[b.i] !== 'slot') PL.hit[b.keys[b.i]] = 1;
        if (b.i >= b.pts.length - 1) { b.t = 1; plLand(b); }
      }
    });
    PL.balls = PL.balls.filter((b) => !b.landed || (b.fade || 0) < 0.5);
    if (!PL.balls.length) plToggleCtl();
    Object.keys(PL.hit).forEach((k) => { PL.hit[k] -= dt * 4; if (PL.hit[k] <= 0) delete PL.hit[k]; });
    Object.keys(PL.flash).forEach((k) => { PL.flash[k] -= dt * 1.6; if (PL.flash[k] <= 0) delete PL.flash[k]; });
    plDraw();
    PL.raf = requestAnimationFrame(plLoop);
  }
  function rrect(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  function plDraw() {
    const c = PL.ctx;
    c.clearRect(0, 0, PL.w, PL.h);
    const n = PL.rows;
    for (let r = 0; r < n; r++) {
      for (let j = 0; j <= r; j++) {
        const p = plPeg(r, j);
        const hit = PL.hit[r + '_' + j] || 0;
        c.fillStyle = hit ? `rgba(255,220,120,${0.6 + hit * 0.4})` : 'rgba(255,255,255,.85)';
        if (hit) { c.shadowColor = '#ffd24a'; c.shadowBlur = 12 * hit; }
        c.beginPath(); c.arc(p.x, p.y, 3 + hit * 1.5, 0, 6.283); c.fill();
        c.shadowBlur = 0;
      }
    }
    const tb = plTable();
    const fs = Math.max(7, Math.min(11, PL.sx * 0.36));
    c.font = `800 ${fs}px Montserrat, sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let k = 0; k <= n; k++) {
      const x = PL.cx + (k - n / 2) * PL.sx;
      const fl = PL.flash[k] || 0;
      const y = PL.top + n * PL.sy + 6 + fl * 6;
      c.fillStyle = plColor(k);
      c.globalAlpha = 0.85 + 0.15 * fl;
      rrect(c, x - PL.sx / 2 + 1.5, y, PL.sx - 3, PL.slotH, 6); c.fill();
      c.globalAlpha = 1;
      c.fillStyle = '#1c1200';
      c.fillText(fx(tb[k]), x, y + PL.slotH / 2 + 1);
    }
    PL.balls.forEach((b) => {
      if (b.landed) return;
      const a = b.pts[b.i];
      const z = b.pts[Math.min(b.i + 1, b.pts.length - 1)];
      const t = b.t;
      const x = a.x + (z.x - a.x) * t;
      const y = a.y + (z.y - a.y) * (t * t * 0.6 + t * 0.4) - Math.sin(Math.PI * t) * PL.sy * 0.28;
      const g = c.createRadialGradient(x - 2, y - 2, 1, x, y, 8);
      g.addColorStop(0, '#fff6c8'); g.addColorStop(1, '#ff4fa3');
      c.shadowColor = '#ff4fa3'; c.shadowBlur = 12;
      c.fillStyle = g; c.beginPath(); c.arc(x, y, 6.5, 0, 6.283); c.fill();
      c.shadowBlur = 0;
    });
  }
  async function loadPlinko() {
    PL.data = await api('/plinko');
    PL.cv = $('#plCanvas');
    PL.ctx = PL.cv.getContext('2d');
    const sel = $('#plRows');
    if (!sel.options.length) {
      sel.innerHTML = PL.data.rows.map((r) => `<option value="${r}"${r === PL.rows ? ' selected' : ''}>${r}</option>`).join('');
    }
    plResize();
    plRun(true);
    $('#plInfo').textContent = `Stavka: ${fmtN(PL.data.min_bet)} – ${fmtMax(PL.data.max_bet)} ⭐`;
  }
  $('#plRows').onchange = () => { PL.rows = Number($('#plRows').value); plLayout(); };
  $('#plRisk').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    PL.risk = b.dataset.risk;
    $$('#plRisk button').forEach((x) => x.classList.toggle('on', x === b));
  };
  $('#plDrop').onclick = async () => {
    try {
      if (!PL.data) throw new Error('Yuklanmoqda...');
      const body = { ...stakeBody('pl'), rows: PL.rows, risk: PL.risk };
      const r = await api('/plinko/drop', 'POST', body);
      setBalance(r.balance - r.win);
      PL.balls.push({ ...plBuild(r.path), i: 0, t: 0, res: r, landed: false });
      plToggleCtl();
      if (!$('#plGift').hidden) fillGifts($('#plGiftSel')).catch(() => {});
    } catch (e) { fail(e); }
  };

  /* ============ MINES ============ */
  const mCount = $('#mCount');
  for (let i = 1; i <= 24; i++) mCount.insertAdjacentHTML('beforeend', `<option value="${i}"${i === 3 ? ' selected' : ''}>${i}</option>`);

  function buildGrid() {
    const g = $('#mGrid');
    g.innerHTML = '';
    for (let i = 0; i < 25; i++) {
      const b = document.createElement('button');
      b.className = 'cell';
      b.dataset.i = i;
      b.disabled = !minesGame;
      g.appendChild(b);
    }
  }
  function renderMines() {
    const active = !!minesGame;
    $('#mSetup').hidden = active;
    $('#mInfo').hidden = !active;
    $('#mCash').hidden = !active;
    if (active) {
      const g = minesGame;
      $('#mInfo').innerHTML = `<span>Stavka: <b>${fmtN(g.bet)}⭐${g.gift ? ' 🎁' : ''}</b></span><span>Mina: <b>${g.mines_count}</b></span><span>Hozir: <b>${g.multiplier.toFixed(2)}x</b></span><span>Keyingi: <b>${g.next.toFixed(2)}x</b></span>`;
      $('#mCash').textContent = g.opened.length ? `Yechib olish: ${fmtN(g.win_now)}⭐${g.gift ? ' (gift sotiladi)' : ''}` : 'Avval katakni oching';
      $('#mCash').disabled = !g.opened.length;
    }
    $$('#mGrid .cell').forEach((c) => {
      const i = Number(c.dataset.i);
      const open = active && minesGame.opened.includes(i);
      c.className = 'cell' + (open ? ' safe' : '');
      c.textContent = open ? '💎' : '';
      c.disabled = !active || open;
    });
  }
  function revealEnd(mines, opened, clicked) {
    $$('#mGrid .cell').forEach((c) => {
      const i = Number(c.dataset.i);
      c.disabled = true;
      if (mines.includes(i)) { c.className = 'cell mine' + (i === clicked ? '' : ' dim'); c.textContent = '💣'; }
      else if (opened && opened.includes(i)) { c.className = 'cell safe'; c.textContent = '💎'; }
      else c.className = 'cell dim';
    });
    minesGame = null;
    $('#mSetup').hidden = false;
    $('#mInfo').hidden = true;
    $('#mCash').hidden = true;
  }
  async function loadMines() {
    await refreshMe();
    minesGame = me.mines_active;
    buildGrid();
    renderMines();
    $('#mMsg').textContent = `Stavka: ${fmtN(me.min_bet)} – ${fmtMax(me.max_bet)} ⭐`;
    if (!$('#mGift').hidden) fillGifts($('#mGiftSel')).catch(() => {});
  }
  $('#mStart').onclick = async () => {
    try {
      const r = await api('/mines/start', 'POST', { ...stakeBody('m'), mines: Number(mCount.value) });
      minesGame = r.game;
      setBalance(r.balance);
      buildGrid();
      renderMines();
      if (r.resumed) toast('Davom etayotgan o\'yin ochildi');
    } catch (e) { fail(e); }
  };
  $('#mGrid').onclick = async (e) => {
    const c = e.target.closest('.cell');
    if (!c || !minesGame || minesBusy) return;
    minesBusy = true;
    try {
      const r = await api('/mines/click', 'POST', { cell: Number(c.dataset.i) });
      setBalance(r.balance);
      if (r.status === 'safe') { minesGame = r.game; renderMines(); }
      else if (r.status === 'lost') { revealEnd(r.mines, minesGame.opened, r.cell); toast(r.gift ? '💣 Mina! Gift adminga o\'tdi' : '💣 Mina! Yutqazdingiz', true); }
      else { revealEnd(r.mines, r.opened, -1); toast(`🎉 Hammasi ochildi! +${fmtN(r.win)}⭐`); loadLive(); }
    } catch (err) { fail(err); }
    minesBusy = false;
  };
  $('#mCash').onclick = async () => {
    if (minesBusy) return;
    minesBusy = true;
    try {
      const r = await api('/mines/cashout', 'POST');
      setBalance(r.balance);
      revealEnd(r.mines, r.opened, -1);
      toast(`✅ Yechildi: +${fmtN(r.win)}⭐${r.gift ? ' (gift sotildi)' : ''}`);
      loadLive();
    } catch (err) { fail(err); }
    minesBusy = false;
  };

  /* ============ KEYS (ruletka) ============ */
  const hms = (s) => { s = Math.max(0, Math.floor(s)); return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((x) => String(x).padStart(2, '0')).join(':'); };
  let keyTick = 0;
  const rewImg = (it) => (it.gift ? gimg({ base_name: it.name, image: it.image }) : '<div class="gimg">⭐</div>');
  async function loadKeys() {
    const { keys } = await api('/keys');
    const box = $('#keysList');
    box.innerHTML = keys.length
      ? keys.map((k, i) => {
        const free = k.cooldown_hours > 0;
        const tag = free
          ? (k.free_in > 0 ? `<small class="kfree wait" data-kin="${k.free_in}">⏳ ${hms(k.free_in)}</small>` : '<small class="kfree">BEPUL · OCHISH</small>')
          : `<small>⭐ ${fmtN(k.price)}</small>`;
        return `<div class="kcard k${i % 4}${free ? ' freekey' : ''}" data-key="${k.id}"><div class="kglow"></div><div class="e">${esc(k.emoji)}</div><b>${esc(k.name)}</b>${tag}</div>`;
      }).join('')
      : '<div class="panel center">Hozircha keys yo\'q</div>';
    box.onclick = (e) => {
      const el = e.target.closest('.kcard');
      if (!el) return;
      openKeyModal(keys.find((k) => k.id === Number(el.dataset.key)));
    };
    clearInterval(keyTick);
    keyTick = setInterval(() => {
      if (current !== 'keys') { clearInterval(keyTick); return; }
      let reload = false;
      $$('.kfree.wait').forEach((el) => {
        const v = Number(el.dataset.kin) - 1;
        el.dataset.kin = v;
        if (v <= 0) reload = true; else el.textContent = '⏳ ' + hms(v);
      });
      if (reload) loadKeys().catch(() => {});
    }, 1000);
  }
  function openKeyModal(k) {
    if (!k) return;
    const free = k.cooldown_hours > 0;
    const items = k.rewards.map((r) => `<div class="ki">${rewImg(r)}<b>${esc(r.name)}</b><div class="pr">⭐ ${fmtN(r.value)}</div></div>`).join('');
    const label = () => (free ? (k.free_in > 0 ? `⏳ ${hms(k.free_in)}` : '🎁 Bepul ochish') : `Ochish — ⭐ ${fmtN(k.price)}`);
    modal(`<h3 style="margin-top:0">${esc(k.emoji)} ${esc(k.name)}</h3>
      <div class="kitems">${items}</div>
      <div class="roul" id="kRoul" hidden><div class="rmark"></div><div class="rstrip" id="kStrip"></div></div>
      <div class="kres" id="kRes"></div>
      <button class="btn green" id="kOpen"${free && k.free_in > 0 ? ' disabled' : ''}>${label()}</button>`);
    $('#kOpen').onclick = async () => {
      const btn = $('#kOpen');
      btn.disabled = true;
      try {
        const r = await api(`/keys/${k.id}/open`, 'POST');
        $('#kRes').innerHTML = '';
        setBalance(r.balance - (r.reward.gift ? 0 : r.reward.value));
        const N = 46;
        const STOP = 38;
        const cell = (it) => `<div class="ri">${rewImg(it)}<b>${esc(it.name)}</b><small>⭐ ${fmtN(it.value)}</small></div>`;
        $('#kStrip').innerHTML = Array.from({ length: N }, (_, i) => cell(i === STOP ? r.reward : k.rewards[Math.floor(Math.random() * k.rewards.length)])).join('');
        $('#kRoul').hidden = false;
        const vw = $('#kRoul').clientWidth || 320;
        const offset = STOP * 100 + 46 - vw / 2 + rand(-28, 28);
        const strip = $('#kStrip');
        strip.style.transition = 'none';
        strip.style.transform = 'translateX(0px)';
        void strip.offsetWidth;
        strip.style.transition = 'transform 5.5s cubic-bezier(.08,.6,.12,1)';
        strip.style.transform = `translateX(${-offset}px)`;
        await sleep(5700);
        setBalance(r.balance);
        k.free_in = r.free_in;
        if (r.reward.gift) {
          const info = await api('/giftdeposit');
          const credit = Math.floor((r.reward.value * info.pct) / 100);
          $('#kRes').innerHTML = `<div class="gcard">${rewImg(r.reward)}<b>🎉 ${esc(r.reward.name)}</b><div class="gp">⭐ ${fmtN(r.reward.value)}</div><div class="gbtn"><button class="s" id="kSell">Sotish +${fmtN(credit)}⭐</button><button id="kWd">Chiqarish BEPUL</button></div></div>`;
          $('#kSell').onclick = async () => {
            try { const s = await api(`/mygifts/${r.gift_id}/sell`, 'POST'); setBalance(s.balance); toast(`💰 Sotildi: +${fmtN(s.credit)}⭐`); $('#kRes').innerHTML = '<div class="gcard"><b>Sotildi ✅</b></div>'; } catch (e) { fail(e); }
          };
          $('#kWd').onclick = async () => {
            if (!confirm(`${r.reward.name} ni hisobingizga chiqarasizmi? Komissiya yo'q (keys yutug'i)`)) return;
            try { const w = await api(`/mygifts/${r.gift_id}/withdraw`, 'POST'); setBalance(w.balance); toast('📤 Gift hisobingizga yuborildi'); $('#kRes').innerHTML = '<div class="gcard"><b>Yuborildi ✅</b></div>'; } catch (e) { fail(e); }
          };
        } else {
          $('#kRes').innerHTML = `<div class="gcard"><b>🎉 ${esc(r.reward.name)}</b><div class="gp">+${fmtN(r.reward.value)} ⭐</div></div>`;
        }
        loadLive();
        loadKeys().catch(() => {});
        btn.textContent = label();
        btn.disabled = free;
      } catch (e) { fail(e); btn.disabled = false; }
    };
  }

  /* ============ DEPOSIT (Stars / Gift) ============ */
  let depInfo = null;
  let depSeen = -1;
  let depTab = 'stars';
  function switchDepTab(t) {
    depTab = t;
    $$('#depTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    $('#depStars').hidden = t !== 'stars';
    $('#depGift').hidden = t !== 'gift';
  }
  $('#depTabs').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    switchDepTab(b.dataset.tab);
    if (b.dataset.tab === 'gift') loadGiftDeposit().catch(fail);
  };
  async function deposit(amount) {
    try {
      const { link } = await api('/topup/link', 'POST', { amount });
      if (tg && tg.openInvoice) {
        tg.openInvoice(link, (status) => {
          if (status === 'paid') {
            toast('✅ To\'lov qabul qilindi');
            [1000, 3000, 6000].forEach((ms) => setTimeout(() => refreshMe().catch(() => {}), ms));
          } else if (status === 'failed') toast('To\'lov amalga oshmadi', true);
        });
      } else window.open(link, '_blank');
    } catch (e) { fail(e); }
  }
  $$('[data-dep]').forEach((b) => { b.onclick = () => deposit(Number(b.dataset.dep)); });
  $('#depGo').onclick = () => {
    const v = Number($('#depAmount').value);
    if (!Number.isInteger(v) || v < 1) return toast('Summani kiriting', true);
    deposit(v);
  };
  function openRelayer() {
    const url = depInfo && depInfo.relayer_url;
    if (!url) return;
    try {
      // PaxtaGram ichida profilni to'g'ridan-to'g'ri ochadi (brauzerga chiqmaydi)
      if (tg && tg.openPaxtaGramLink) { tg.openPaxtaGramLink(url); return; }
      if (tg && tg.openTelegramLink) { tg.openTelegramLink(url); return; }
      if (tg && tg.openLink) { tg.openLink(url); return; }
    } catch (e) { /* pastga */ }
    window.open(url, '_blank');
  }
  $('#giftSend').onclick = openRelayer;
  async function loadGiftDeposit() {
    depInfo = await api('/giftdeposit');
    const g = depInfo;
    $('#giftDepText').innerHTML = g.to_balance
      ? `Giftni <b>@${esc(g.relayer)}</b> ga lichkada yuboring. U narxining <b>${g.pct}%</b> miqdorida avtomatik balansingizga tushadi.`
      : `Giftni <b>@${esc(g.relayer)}</b> ga lichkada yuboring. U Backpack'da paydo bo'ladi: tikish, <b>${g.pct}%</b> ga sotish yoki <b>${fmtN(g.withdraw_fee)}⭐</b> evaziga chiqarish mumkin (keys yutuqlari bepul).`;
    $('#giftDepSub').textContent = `${g.prices.length} ta gift`;
    $('#giftMarket').innerHTML = g.prices.length
      ? g.prices.map((p) => `<div class="mk"><div class="lab">narx</div>${gimg({ base_name: p.n, image: p.img })}<b>${esc(p.n)}</b><div class="pr">⭐ ${fmtN(p.v)}</div><div class="cn">${p.c} ta qabul</div></div>`).join('')
      : '<div class="panel">Gift narxlari hali belgilanmagan</div>';
    await pollDepGifts(true);
  }
  async function pollDepGifts(silent) {
    if (!depInfo) return;
    const { gifts } = await api('/mygifts');
    const live = gifts.filter((g) => g.status === 'owned' || g.status === 'pending');
    if (!silent && depSeen >= 0 && live.length > depSeen) { toast('🎁 Gift tushdi!'); refreshMe().catch(() => {}); }
    depSeen = live.length;
    $('#depMyGifts').innerHTML = live.length
      ? live.slice(0, 6).map((g) => giftCard(g, depInfo.withdraw_fee, false)).join('')
      : '<div class="empty">Hozircha gift yo\'q. Giftni yuboring, shu yerda paydo bo\'ladi.</div>';
  }
  async function loadDeposit() {
    await refreshMe();
    switchDepTab(depTab);
    if (depTab === 'gift') await loadGiftDeposit();
    else loadGiftDeposit().catch(() => {});
  }

  /* ============ BACKPACK ============ */
  async function loadBackpack() {
    const [g, h, mg, di] = await Promise.all([api('/gifts'), api('/history'), api('/mygifts'), api('/giftdeposit')]);
    depInfo = di;
    $('#bpHint').textContent = `Chiqarish: ${fmtN(di.withdraw_fee)}⭐`;
    $('#myGifts').innerHTML = mg.gifts.length
      ? mg.gifts.map((x) => giftCard(x, di.withdraw_fee, true)).join('')
      : '<div class="empty">Hozircha gift yo\'q. Deposit → Gift bo\'limidan qo\'shing.</div>';
    $('#myGifts').onclick = async (e) => {
      const s = e.target.closest('[data-gsell]');
      const w = e.target.closest('[data-gwd]');
      try {
        if (s) {
          const gg = mg.gifts.find((x) => x.id === Number(s.dataset.gsell));
          const credit = Math.floor((gg.value * di.pct) / 100);
          if (!confirm(`${gg.name} ni ${fmtN(credit)}⭐ ga sotasizmi?`)) return;
          const r = await api(`/mygifts/${gg.id}/sell`, 'POST');
          setBalance(r.balance);
          toast(`💰 Sotildi: +${fmtN(r.credit)}⭐`);
        } else if (w) {
          const gg = mg.gifts.find((x) => x.id === Number(w.dataset.gwd));
          if (!confirm(`${gg.name} ni hisobingizga chiqarasizmi? ${gg.source === 'key' ? 'Komissiya yo\'q (keys yutug\'i)' : 'Komissiya: ' + fmtN(di.withdraw_fee) + '⭐'}`)) return;
          const r = await api(`/mygifts/${gg.id}/withdraw`, 'POST');
          setBalance(r.balance);
          toast('📤 Gift hisobingizga yuborildi');
        } else return;
        loadBackpack().catch(fail);
      } catch (err) { fail(err); }
    };
    $('#giftList').innerHTML = g.gifts.length
      ? g.gifts.map((x) => `<div><span>${esc(x.emoji)} ${esc(x.name)}</span><button data-buy="${x.id}" data-name="${esc(x.name)}" data-price="${x.price}">${fmtN(x.price)} ⭐</button></div>`).join('')
      : '<div>Do\'konda gift yo\'q</div>';
    $('#giftList').onclick = async (e) => {
      const b = e.target.closest('[data-buy]');
      if (!b) return;
      if (!confirm(`${b.dataset.name} ni ${b.dataset.price}⭐ ga sotib olasizmi?`)) return;
      try {
        const r = await api(`/gifts/${b.dataset.buy}/buy`, 'POST');
        setBalance(r.balance);
        toast('🎁 Buyurtma qabul qilindi! Admin siz bilan bog\'lanadi.');
      } catch (err) { fail(err); }
    };
    const rows = [];
    h.payments.forEach((p) => rows.push({ t: p.created_at, html: `<div><span>➕ Deposit · ${fmtDate(p.created_at)}</span><span class="win">+${fmtN(p.amount)}⭐</span></div>` }));
    h.rocket.forEach((r) => rows.push({ t: r.created_at, html: `<div><span>🚀 Rocket ${fx(r.crash)}x · ${fmtDate(r.created_at)}</span><span class="${r.win ? 'win' : 'lose'}">${r.win ? '+' + fmtN(r.win) : '-' + fmtN(r.bet)}⭐</span></div>` }));
    h.mines.forEach((m) => rows.push({ t: m.created_at, html: `<div><span>💎 Mines · ${fmtDate(m.created_at)}</span><span class="${m.win ? 'win' : 'lose'}">${m.win ? '+' + fmtN(m.win) : '-' + fmtN(m.bet)}⭐</span></div>` }));
    (h.upgrade || []).forEach((u) => rows.push({ t: u.created_at, html: `<div><span>⬆️ Upgrade ${esc(u.target)} (${fx(u.chance * 100)}%) · ${fmtDate(u.created_at)}</span><span class="${u.win ? 'win' : 'lose'}">${u.win ? '🎉 yutdi' : '-' + fmtN(u.stake) + '⭐'}</span></div>` }));
    (h.plinko || []).forEach((p) => rows.push({ t: p.created_at, html: `<div><span>🔮 Plinko ${fx(p.mult)}x · ${fmtDate(p.created_at)}</span><span class="${p.win >= p.bet ? 'win' : 'lose'}">${p.win >= p.bet ? '+' + fmtN(p.win - p.bet) : '-' + fmtN(p.bet - p.win)}⭐</span></div>` }));
    rows.sort((a, b) => b.t - a.t);
    $('#history').innerHTML = rows.length ? rows.slice(0, 25).map((r) => r.html).join('') : '<div>Tarix bo\'sh</div>';
  }

  /* ============ PVP duel xonasi ============ */
  const PVC = ['#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7', '#14b8a6', '#ec4899', '#84cc16'];
  const pv = { data: null, skew: 0, anim: false, playedId: 0, hash: '' };
  function pvAv(p, i) {
    const col = PVC[i % PVC.length];
    if (p.bot) return `<span class="pva bot" style="border-color:${col}">🤖</span>`;
    const ini = esc((p.name || '?').trim().charAt(0).toUpperCase() || '?');
    return `<span class="pva" style="border-color:${col};background:${col}33">${p.photo ? `<img src="${esc(p.photo)}" alt="" data-fb="${ini}">` : ini}</span>`;
  }
  function pvWheel(players) {
    let a = 0;
    const parts = players.map((p, i) => { const s = a; a = i === players.length - 1 ? 360 : a + p.pct * 3.6; return `${PVC[i % PVC.length]} ${s}deg ${a}deg`; });
    $('#pvWheel').style.background = parts.length ? `conic-gradient(${parts.join(',')})` : '#2a2d3a';
    a = 0;
    $('#pvLabs').innerHTML = players.map((p) => {
      const span = p.pct * 3.6;
      const m = a + span / 2;
      a += span;
      return span < 20 ? '' : `<div class="pvlab" style="--ang:${m}deg"><div>${p.pct}%</div></div>`;
    }).join('');
  }
  function pvList(players, winnerId) {
    $('#pvCnt').textContent = players.length;
    $('#pvPlayers').innerHTML = players.length
      ? players.map((p, i) => `<div class="pvp${winnerId === p.id ? ' win' : ''}">${pvAv(p, i)}<div class="pvn"><b style="color:${PVC[i % PVC.length]}">${esc(p.name)}${p.bot ? ' <em class="botb">BOT</em>' : ''}</b><small>${p.pct}%</small></div><b class="pvs">${fmtN(p.stake)} ⭐</b></div>`).join('')
      : '<div class="pvp"><small>Hozircha o\'yinchi yo\'q</small></div>';
  }
  const pvShortHash = (hh) => hh.slice(0, 4) + '…' + hh.slice(-4);
  function pvLeft() {
    const r = pv.data && pv.data.round;
    if (!r || r.status !== 'countdown') return null;
    return Math.max(0, Math.ceil((r.start_at - (Date.now() + pv.skew)) / 1000));
  }
  function pvHubUpdate() {
    if (pv.anim || !pv.data) return;
    const l = pvLeft();
    const r = pv.data.round;
    $('#pvHubTxt').textContent = l !== null ? l : (r.players.length < 2 ? '⏳' : 'VS');
    $('#pvInfo').textContent = l !== null ? `O'yin ${l} soniyadan keyin boshlanadi` : 'Raqib kutilmoqda…';
  }
  function pvChance() {
    const rd = pv.data && pv.data.round;
    if (!rd || !me) return;
    const y = Number($('#pvBet').value) || 0;
    const mine = rd.players.find((p) => p.id === me.id);
    const my = (mine ? mine.stake : 0) + y;
    const tot = rd.total + y;
    $('#pvChance').textContent = y > 0 && tot > 0 ? `Sizning shansingiz: ${Math.round((my / tot) * 1000) / 10}%` : '';
  }
  function pvRender(r) {
    const rd = r.round;
    pvWheel(rd.players);
    pvList(rd.players, null);
    pv.hash = rd.hash;
    $('#pvHash').textContent = pvShortHash(rd.hash);
    $('#pvId').textContent = '#' + rd.id;
    $('#pvTop').textContent = r.top ? `${r.top.n} · ${fmtN(r.top.p)}⭐` : '—';
    $('#pvLast').textContent = r.last ? `${r.last.winner.name} · ${fmtN(r.last.payout)}⭐` : '—';
    const mine = rd.players.find((p) => p.id === me.id);
    $('#pvCancel').hidden = !(mine && rd.status === 'waiting');
    pvChance();
    pvHubUpdate();
  }
  async function loadPvp() {
    const r = await api('/pvp');
    pv.data = r;
    pv.skew = r.now - Date.now();
    $('#pvBet').min = r.min_bet;
    if (r.play && r.play.id !== pv.playedId && !pv.anim) { pv.playedId = r.play.id; pvSpin(r.play); return; }
    if (!pv.anim) pvRender(r);
  }
  // To'p g'ildirak o'rtasidan tashlanadi, aylanib roll*360 burchakdagi o'yinchiga tushadi
  function pvSpin(res) {
    pv.anim = true;
    pvWheel(res.players);
    pvList(res.players, null);
    $('#pvId').textContent = '#' + res.id;
    $('#pvHash').textContent = pvShortHash(res.hash);
    $('#pvHubTxt').textContent = '🎯';
    $('#pvInfo').textContent = 'To\'p aylanmoqda…';
    const ball = $('#pvBall');
    ball.hidden = false;
    const R = ($('#pvWheel').clientWidth || 260) / 2 - 18;
    const thetaF = res.roll * 360;
    const T = 6.5;
    const t0 = performance.now();
    const done = () => {
      pvList(res.players, res.winner.id);
      $('#pvHubTxt').textContent = '🏆';
      $('#pvInfo').textContent = `${res.winner.name} yutdi: +${fmtN(res.payout)}⭐`;
      toast(res.won ? `🏆 Siz yutdingiz! +${fmtN(res.payout)}⭐` : `🏆 ${res.winner.name} yutdi (+${fmtN(res.payout)}⭐)`);
      refreshMe().catch(() => {});
      if (res.mine) api(`/pvp/${res.id}/seen`, 'POST').catch(() => {});
      if (tg && tg.HapticFeedback) { try { tg.HapticFeedback.notificationOccurred(res.won ? 'success' : 'warning'); } catch (e) { /* ignore */ } }
      loadLive();
      setTimeout(() => { ball.hidden = true; pv.anim = false; if (current === 'pvp') loadPvp().catch(() => {}); }, 2600);
    };
    const frame = (now) => {
      const t = (now - t0) / 1000;
      const k = Math.min(1, t / T);
      const e = 1 - Math.pow(1 - k, 3);
      const ang = ((thetaF + 360 * 5 * (1 - e)) * Math.PI) / 180;
      const rr = R * (1 - Math.pow(1 - Math.min(1, t / 0.8), 3)) - (k > 0.9 ? 0 : Math.abs(Math.sin(t * 9)) * 7 * (1 - e));
      ball.style.transform = `translate(${rr * Math.sin(ang)}px, ${-rr * Math.cos(ang)}px)`;
      if (k < 1) requestAnimationFrame(frame); else done();
    };
    requestAnimationFrame(frame);
  }
  $('#pvBet').addEventListener('input', pvChance);
  $('#pvGo').onclick = async () => {
    try {
      const r = await api('/pvp/bet', 'POST', { stake: Number($('#pvBet').value) });
      setBalance(r.balance);
      toast('✅ Stavka qabul qilindi');
      loadPvp();
    } catch (e) { fail(e); }
  };
  $('#pvCancel').onclick = async () => {
    try {
      const r = await api('/pvp/cancel', 'POST');
      setBalance(r.balance);
      toast('Stavka qaytarildi');
      loadPvp();
    } catch (e) { fail(e); }
  };
  $('#pvCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(pv.hash); toast('Hash nusxalandi ✅'); } catch (e) { toast(pv.hash); }
  };

  /* ============ UPGRADE ============ */
  const UP = { data: null, target: null, busy: false };
  function upStakeValue() {
    if (!$('#upGift').hidden) { const o = $('#upGiftSel').selectedOptions[0]; return o ? Number(o.dataset.v) || 0 : 0; }
    return Number($('#upBet').value) || 0;
  }
  function upChance() {
    const V = upStakeValue();
    const T = UP.target ? UP.target.v : 0;
    if (!T || !V || V >= T) return 0;
    return Math.floor((V / T) * UP.data.rtp * 100) / 100;
  }
  function updateUpChance() {
    if (!UP.data) return;
    const V = upStakeValue();
    const p = upChance();
    $('#upWheel').style.setProperty('--p', p);
    $('#upPct').textContent = `${Math.round(p * 10) / 10}%`;
    $('#upCenter').innerHTML = UP.target ? gimg({ base_name: UP.target.n, image: UP.target.img }) : '🎁';
    $('#upMarket').innerHTML = UP.data.catalog.map((c) => {
      const ch = V && c.v > V ? Math.floor((V / c.v) * UP.data.rtp * 100) / 100 : 0;
      return `<div class="mk${UP.target && UP.target.n === c.n ? ' sel' : ''}${c.v <= V ? ' dim' : ''}" data-up="${esc(c.n)}"><div class="lab">orzu</div>${gimg({ base_name: c.n, image: c.img })}<b>${esc(c.n)}</b><div class="pr">⭐ ${fmtN(c.v)}</div><div class="cn">${ch ? ch + '%' : '—'}</div></div>`;
    }).join('') || '<div class="panel">Katalog bo\'sh</div>';
    $('#upInfo').textContent = !UP.target ? 'Orzu giftini tanlang' : p < 1 ? 'Shans 1% dan past: qimmatroq stavka yoki arzonroq gift tanlang' : `Shans: ${Math.round(p * 10) / 10}% · yutsangiz ${esc(UP.target.n)} (${fmtN(UP.target.v)}⭐) olasiz`;
  }
  async function loadUpgrade() {
    UP.data = await api('/upgrade');
    if (UP.target) UP.target = UP.data.catalog.find((c) => c.n === UP.target.n) || null;
    if (!$('#upGift').hidden) await fillGifts($('#upGiftSel'));
    updateUpChance();
  }
  $('#upBet').oninput = updateUpChance;
  $('#upGiftSel').onchange = updateUpChance;
  $('#upMarket').onclick = (e) => {
    const c = e.target.closest('[data-up]');
    if (!c || c.classList.contains('dim') || UP.busy) return;
    UP.target = UP.data.catalog.find((x) => x.n === c.dataset.up) || null;
    updateUpChance();
  };
  $('#upGo').onclick = async () => {
    if (UP.busy) return;
    UP.busy = true;
    $('#upGo').disabled = true;
    try {
      if (!UP.target) throw new Error('Avval orzu giftini tanlang');
      const r = await api('/upgrade', 'POST', { ...stakeBody('up'), target: UP.target.n });
      const wrap = $('#upArrowWrap');
      wrap.style.transition = 'none';
      wrap.style.transform = 'rotate(0deg)';
      void wrap.offsetWidth;
      wrap.style.transition = 'transform 4.5s cubic-bezier(.12,.67,.1,1)';
      wrap.style.transform = `rotate(${360 * 5 + r.roll * 360}deg)`;
      await sleep(4700);
      setBalance(r.balance);
      $('#upRes').innerHTML = r.win
        ? `<div class="gifts"><div class="gcard">${gimg({ base_name: r.target.n, image: r.target.img })}<b>${esc(r.target.n)}</b><div class="gp">⭐ ${fmtN(r.target.v)}</div><span class="st">🎉 Inventarga qo'shildi</span></div></div>`
        : `<div class="panel center">😔 Omad kelmadi (shans ${Math.round(r.chance * 1000) / 10}%). ${r.gift ? 'Gift adminga o\'tdi.' : ''}</div>`;
      toast(r.win ? `🎉 Upgrade! ${r.target.n} sizniki` : '😔 Upgrade omadsiz', !r.win);
      if (r.win && tg && tg.HapticFeedback) { try { tg.HapticFeedback.notificationOccurred('success'); } catch (e) { /* ignore */ } }
      loadLive();
      if (!$('#upGift').hidden) await fillGifts($('#upGiftSel'));
      updateUpChance();
    } catch (e) { fail(e); }
    UP.busy = false;
    $('#upGo').disabled = false;
  };

  /* ============ INVITE / LEADERBOARD ============ */
  async function loadInvite() {
    await refreshMe();
    $('#invText').textContent = `Har bir yangi do'st uchun ${me.ref_bonus}⭐ bonus oling.`;
    $('#invLink').value = me.invite_link;
  }
  $('#invCopy').onclick = async () => {
    const v = $('#invLink').value;
    try { await navigator.clipboard.writeText(v); toast('Nusxalandi ✅'); }
    catch (e) { $('#invLink').select(); document.execCommand('copy'); toast('Nusxalandi ✅'); }
  };
  async function loadLb() {
    const r = await api('/leaderboard');
    $('#lbInfo').textContent = `Konkurs sovrini: ${fmtN(r.prize)}⭐ · Sizning ochkoyingiz: ${fmtN(r.my_score)}`;
    const medals = ['🥇', '🥈', '🥉'];
    $('#lbList').innerHTML = r.top.length
      ? r.top.map((x, i) => `<div><span>${medals[i] || (i + 1) + '.'} ${esc(x.n)}${x.un ? ' @' + esc(x.un) : ''}</span><b>${fmtN(x.s)}</b></div>`).join('')
      : '<div>Hozircha ishtirokchilar yo\'q</div>';
  }

  /* ============ EARN + ADMIN ============ */
  async function redeemPromo() {
    const code = $('#promoCode').value.trim();
    if (!code) return toast('Promo kodni kiriting', true);
    try {
      const r = await api('/promo/redeem', 'POST', { code });
      setBalance(r.balance);
      const parts = [];
      if (r.stars) parts.push(`+${fmtN(r.stars)}⭐`);
      if (r.gift) parts.push(`🎁 ${r.gift.name}`);
      $('#promoMsg').textContent = '✅ Promo kod faollashtirildi: ' + parts.join(' ');
      toast('🎟 Promo kod faollashtirildi: ' + parts.join(' '));
      $('#promoCode').value = '';
      loadLive();
    } catch (e) { $('#promoMsg').textContent = '❌ ' + e.message; fail(e); }
  }
  $('#promoGo').onclick = redeemPromo;
  $('#promoCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') redeemPromo(); });
  async function loadEarn() {
    await refreshMe();
    if (me.is_admin) await loadAdmin(); else $('#adminBox').hidden = true;
  }
  const SET_LABELS = {
    rocket_rtp: 'Rocket: o\'yinchiga qaytish % (RTP)',
    mines_rtp: 'Mines: o\'yinchiga qaytish % (RTP)',
    plinko_rtp: 'Plinko: o\'yinchiga qaytish % (RTP)',
    min_bet: 'Minimal stavka ⭐',
    max_bet: 'Maksimal stavka ⭐',
    ref_bonus: 'Referal bonus ⭐',
    contest_prize: 'Konkurs sovrini ⭐',
    pvp_fee: 'PVP komissiya %',
    gift_to_balance: 'Gift kelsa: 1 = balansga avto, 0 = inventarga',
    gift_credit_pct: 'Gift sotilganda narxning necha % i beriladi',
    gift_withdraw_fee: 'Giftni chiqarish komissiyasi ⭐',
    upgrade_rtp: 'Upgrade: o\'yinchiga qaytish % (RTP)',
    pvp_bot: 'PVP: Epic bot (1 = yoqilgan, 0 = o\'chirilgan)',
    pvp_bot_max: 'PVP: Epic bot maksimal stavkasi ⭐',
    pvp_countdown: 'PVP: hisoblagich (soniya)',
    key_nft_mult: 'Keys: qimmat gift (NFT) tushish koeffitsienti (0-1, 1 = o\'zgarmaydi)',
    key_nft_min: 'Keys: qimmat gift chegarasi ⭐ (shundan qimmatlari NFT)',
  };
  const ST_LABEL = { lost: 'yutqazilgan', sold: 'sotilgan/yutuqda', taken: 'olingan ✅' };
  async function loadAdmin() {
    const d = await api('/admin/data');
    const box = $('#adminBox');
    box.hidden = false;
    box.className = 'adm';
    const sets = Object.keys(SET_LABELS).map((k) =>
      `<label>${SET_LABELS[k]}</label><input type="number" data-set="${k}" value="${esc(d.settings[k])}" step="any">`).join('');
    const keys = d.keys.map((k) => `<div><span>${esc(k.emoji)} ${esc(k.name)} · ${k.cooldown_hours > 0 ? 'bepul, ' + k.cooldown_hours + ' soatda 1 marta' : k.price + '⭐'} · ${k.rewards.length} mukofot</span><button class="del" data-delkey="${k.id}">O'chirish</button></div>`).join('') || '<div>Keys yo\'q</div>';
    const gifts = d.gifts.map((g) => `<div><span>${esc(g.emoji)} ${esc(g.name)} · ${g.price}⭐</span><button class="del" data-delgift="${g.id}">O'chirish</button></div>`).join('') || '<div>Do\'kon giftlari yo\'q</div>';
    const top = d.contest.map((c, i) => `<div><span>${i + 1}. ${esc(c.n)}${c.un ? ' @' + esc(c.un) : ''}</span><b>${c.s}</b></div>`).join('') || '<div>Ishtirokchi yo\'q</div>';
    const cat = (d.gift_types || []).map((t, i) => `<div style="flex-wrap:wrap"><span style="display:flex;align-items:center;gap:8px">${gimg({ base_name: t.b, image: t.img })}${esc(t.b)} · ${t.c} ta · omborda ${(d.stock || {})[normN(t.b)] || 0}</span><span style="display:flex;gap:6px"><input data-gvi="${i}" type="number" value="${t.v || 0}" style="width:96px;margin:0"><button data-gvs="${i}">OK</button></span><input data-gvm="${i}" placeholder="Rasm URL (ixtiyoriy)" value="${esc(t.img)}" style="margin:4px 0 0"></div>`).join('') || '<div>Katalog bo\'sh</div>';
    const lost = (d.lost || []).map((g) => `<div><span>🎁 ${esc(g.name)} · ${fmtN(g.value)}⭐<br><small>${esc(g.n)} · ${ST_LABEL[g.status] || g.status}${g.lost_at ? ' · ' + fmtDate(g.lost_at) : ''}</small></span>${g.status === 'taken' ? '' : `<button data-lt="${g.id}">Menga o'tkazish</button>`}</div>`).join('') || '<div>Adminga o\'tgan gift yo\'q</div>';
    const promos = (d.promos || []).map((p) => `<div><span><b>${esc(p.code)}</b><br><small>${p.stars ? '+' + fmtN(p.stars) + '⭐ ' : ''}${p.gift_name ? '🎁 ' + esc(p.gift_name) + ' ' : ''}· ishlatilgan ${p.used}/${p.max_uses || '∞'}${p.expires_at ? ' · ' + fmtDate(p.expires_at) + ' gacha' : ''}</small></span><button class="del" data-delpromo="${esc(p.code)}">O'chirish</button></div>`).join('') || '<div>Promo kod yo\'q</div>';
    const conn = d.bc_id ? `✅ Ulangan: <b>${esc(d.bc_id)}</b>${d.bc_env ? ' (Render env)' : ''}` : '❌ Ulanish ID topilmadi. @PaxtaFather → /setrelayer ni qayta bajaring yoki ID ni pastga yozing';
    box.innerHTML = `
      <h3>🛠 Admin panel <small style="font-size:11px">(${d.users} foydalanuvchi)</small></h3>
      <div class="card"><h4>Sozlamalar</h4>${sets}<button class="btn green" id="adSet">Saqlash</button></div>
      <h4>🎁 Gift katalogi (narxlar ⭐)</h4><div class="list" id="adGT">${cat}</div>
      <div class="card"><h4>Katalogga gift qo'shish</h4>
        <div class="row"><input id="ngcName" placeholder="Nomi (masalan Star Notepad)"><input id="ngcPrice" type="number" placeholder="Narxi ⭐"></div>
        <input id="ngcImg" placeholder="Rasm URL (ixtiyoriy)">
        <button class="btn green" id="adCat">Qo'shish</button></div>
      <h4>📥 Adminga o'tgan giftlar</h4><div class="list" id="adLost">${lost}</div>
      <div class="card"><h4>⭐ Stars qo'shish</h4>
        <input id="abId" type="number" placeholder="Foydalanuvchi ID">
        <input id="abAmount" type="number" placeholder="Summa (minus = ayirish)">
        <button class="btn green" id="adBal">Balansga qo'shish</button></div>
      <div class="card"><h4>🔗 Relayer ulanishi</h4>
        <p class="hint" style="text-align:left">${conn}</p>
        <p class="hint" style="text-align:left">Doimiy bo'lishi uchun Render → Environment ga <code>BUSINESS_CONNECTION_ID</code> nomi bilan yozing (bepul tarifda baza o'chib ketadi).</p>
        <input id="connId" placeholder="Connection ID">
        <button class="btn green" id="adConn">Saqlash</button></div>
      <div class="card"><h4>🎟 Yangi promo kod</h4>
        <input id="pcCode" placeholder="KOD (masalan EPIC100)" style="text-transform:uppercase">
        <div class="row"><input id="pcStars" type="number" placeholder="Stars ⭐"><input id="pcMax" type="number" placeholder="Limit (0 = cheksiz)"></div>
        <input id="pcGift" placeholder="Gift nomi (ixtiyoriy, katalogdan)">
        <input id="pcHours" type="number" placeholder="Muddat soatda (0 = cheksiz)">
        <button class="btn green" id="adPromo">Promo kod yaratish</button></div>
      <h4>🎟 Promo kodlar</h4><div class="list" id="adPromos">${promos}</div>
      <div class="card"><h4>🖼 NFT link bilan qo'shish</h4>
        <textarea id="nftLinks" placeholder="https://paxta.online/nft/LolPop-648&#10;https://paxta.online/nft/Mask-404"></textarea>
        <input id="nftPrice" type="number" placeholder="Narx ⭐ (ixtiyoriy)">
        <button class="btn green" id="adNft">Linklardan qo'shish</button>
        <button class="btn ghost" id="adStock">🔄 Relayer omborini yuklash (API)</button></div>
      <div class="card"><h4>Yangi Keys</h4>
        <div class="row"><input id="nkName" placeholder="Nomi"><input id="nkEmoji" placeholder="Emoji 🔑"></div>
        <input id="nkPrice" type="number" placeholder="Narxi ⭐">
        <input id="nkCd" type="number" placeholder="Bepul oraliq (soat): 0 = pullik, 24 = kuniga 1 marta bepul">
        <label>Mukofotlar (har qatorda: nomi|qiymat|ehtimol)</label>
        <textarea id="nkRew" placeholder="Mayda|5|50&#10;Oz|8|30&#10;Jackpot|100|1"></textarea>
        <button class="btn green" id="adKey">Keys qo'shish</button></div>
      <h4>Keyslar</h4><div class="list" id="adKeys">${keys}</div>
      <div class="card"><h4>Do'kon gifti qo'shish</h4>
        <div class="row"><input id="ngName" placeholder="Nomi"><input id="ngEmoji" placeholder="Emoji 🎁"></div>
        <input id="ngPrice" type="number" placeholder="Narxi ⭐">
        <button class="btn green" id="adGift">Gift qo'shish</button></div>
      <h4>Do'kon giftlari</h4><div class="list" id="adGifts">${gifts}</div>
      <div class="card"><h4>🏆 Konkurs</h4><div class="list">${top}</div>
        <button class="btn purple" id="adFinish">Konkursni yakunlash</button></div>`;

    $('#adSet').onclick = async () => {
      const body = {};
      $$('[data-set]').forEach((i) => { body[i.dataset.set] = Number(i.value); });
      try { await api('/admin/settings', 'POST', body); toast('Saqlandi ✅'); } catch (e) { fail(e); }
    };
    $('#adGT').onclick = async (e) => {
      const b = e.target.closest('[data-gvs]');
      if (!b) return;
      const i = Number(b.dataset.gvs);
      try {
        const r = await api('/admin/giftvalue', 'POST', { base_name: d.gift_types[i].b, value: Number($(`[data-gvi="${i}"]`).value), image: $(`[data-gvm="${i}"]`).value.trim() });
        toast(r.credited ? `Narx saqlandi ✅ (${r.credited} ta gift hisoblandi)` : 'Narx saqlandi ✅');
      } catch (err) { fail(err); }
    };
    $('#adCat').onclick = async () => {
      try {
        await api('/admin/giftvalue', 'POST', { base_name: $('#ngcName').value.trim(), value: Number($('#ngcPrice').value), image: $('#ngcImg').value.trim() });
        toast('Katalogga qo\'shildi ✅');
        loadAdmin();
      } catch (e) { fail(e); }
    };
    $('#adLost').onclick = async (e) => {
      const b = e.target.closest('[data-lt]');
      if (!b || !confirm('Gift sizning akkauntingizga o\'tkazilsinmi?')) return;
      try { await api(`/admin/lostgifts/${b.dataset.lt}/transfer`, 'POST'); toast('O\'tkazildi ✅'); loadAdmin(); } catch (err) { fail(err); }
    };
    $('#adConn').onclick = async () => {
      try { await api('/admin/connection', 'POST', { id: $('#connId').value }); toast('Saqlandi ✅'); loadAdmin(); } catch (e) { fail(e); }
    };
    $('#adPromo').onclick = async () => {
      try {
        await api('/admin/promos', 'POST', { code: $('#pcCode').value, stars: Number($('#pcStars').value) || 0, max_uses: Number($('#pcMax').value) || 0, gift_name: $('#pcGift').value, expire_hours: Number($('#pcHours').value) || 0 });
        toast('Promo kod yaratildi ✅');
        loadAdmin();
      } catch (e) { fail(e); }
    };
    $('#adPromos').onclick = async (e) => {
      const b = e.target.closest('[data-delpromo]');
      if (!b || !confirm('Promo kod o\'chirilsinmi?')) return;
      try { await api('/admin/promos/' + encodeURIComponent(b.dataset.delpromo), 'DELETE'); loadAdmin(); } catch (err) { fail(err); }
    };
    $('#adNft').onclick = async () => {
      try {
        const r = await api('/admin/nftlinks', 'POST', { links: $('#nftLinks').value, price: $('#nftPrice').value });
        toast(`✅ ${r.added.length} ta gift qo'shildi/yangilandi`);
        loadAdmin();
      } catch (e) { fail(e); }
    };
    $('#adStock').onclick = async () => {
      try {
        const r = await api('/admin/syncstock', 'POST');
        toast(`📦 Omborda ${r.total} ta gift, ${r.types} xil`);
        loadAdmin();
      } catch (e) { fail(e); }
    };
    $('#adBal').onclick = async () => {
      try {
        const r = await api('/admin/balance', 'POST', { user_id: Number($('#abId').value), amount: Number($('#abAmount').value) });
        toast(`✅ Yangi balans: ${fmtN(r.balance)}⭐`);
      } catch (e) { fail(e); }
    };
    $('#adKey').onclick = async () => {
      try {
        const rewards = $('#nkRew').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
          const [name, value, chance] = l.split('|').map((s) => s.trim());
          return { name, value: Number(value), chance: Number(chance) };
        });
        await api('/admin/keys', 'POST', { name: $('#nkName').value.trim(), emoji: $('#nkEmoji').value.trim() || '🔑', price: Number($('#nkPrice').value), cooldown_hours: Number($('#nkCd').value) || 0, rewards });
        toast('Keys qo\'shildi ✅');
        loadAdmin();
      } catch (e) { fail(e); }
    };
    $('#adGift').onclick = async () => {
      try {
        await api('/admin/gifts', 'POST', { name: $('#ngName').value.trim(), emoji: $('#ngEmoji').value.trim() || '🎁', price: Number($('#ngPrice').value) });
        toast('Gift qo\'shildi ✅');
        loadAdmin();
      } catch (e) { fail(e); }
    };
    $('#adKeys').onclick = async (e) => {
      const b = e.target.closest('[data-delkey]');
      if (!b || !confirm('Keys o\'chirilsinmi?')) return;
      try { await api('/admin/keys/' + b.dataset.delkey, 'DELETE'); loadAdmin(); } catch (err) { fail(err); }
    };
    $('#adGifts').onclick = async (e) => {
      const b = e.target.closest('[data-delgift]');
      if (!b || !confirm('Gift o\'chirilsinmi?')) return;
      try { await api('/admin/gifts/' + b.dataset.delgift, 'DELETE'); loadAdmin(); } catch (err) { fail(err); }
    };
    $('#adFinish').onclick = async () => {
      if (!confirm('Konkurs yakunlansinmi? G\'olib sovrinni oladi, ochkolar nollanadi.')) return;
      try {
        const r = await api('/admin/contest/finish', 'POST');
        toast(`🏆 G'olib: ${r.winner.name} (+${fmtN(r.prize)}⭐)`);
        loadAdmin();
      } catch (err) { fail(err); }
    };
  }

  /* ============ Ishga tushirish ============ */
  (async function init() {
    if (!initData) toast('Ilovani PaxtaGram ichidan oching', true);
    try { await refreshMe(); } catch (e) { fail(e); }
    loadLive();
    setInterval(loadLive, 60000);
    window.addEventListener('resize', () => {
      if (current === 'rocket') rsResize();
      if (current === 'plinko') plResize();
    });
  })();
})();
