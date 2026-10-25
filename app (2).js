(() => {
  'use strict';
  /* ============ Asosiy yordamchilar ============ */
  const tg = (window.PaxtaGram && window.PaxtaGram.WebApp) || (window.Telegram && window.Telegram.WebApp) || null;
  if (tg) { try { tg.ready(); if (tg.expand) tg.expand(); } catch (e) { /* ignore */ } }
  const initData = tg ? tg.initData : '';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (t) => new Date(t * 1000).toLocaleString('uz-UZ', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    toastT = setTimeout(() => { t.className = ''; }, 2600);
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

  /* ============ Holat ============ */
  let me = null;
  let minesGame = null;
  let minesBusy = false;

  function setBalance(b) {
    if (me) me.balance = b;
    $('#bal').textContent = Number(b).toLocaleString('en-US');
  }
  function setMe(m) {
    me = m;
    setBalance(m.balance);
    const av = $('#avatar');
    if (m.photo_url) av.innerHTML = `<img src="${esc(m.photo_url)}" alt="">`;
    else av.textContent = (m.first_name || '?').trim().charAt(0).toUpperCase() || '?';
  }
  async function refreshMe() { setMe(await api('/me')); }

  /* ============ Navigatsiya ============ */
  const NAV = ['backpack', 'invite', 'home', 'leaderboard', 'earn'];
  const loaders = {
    rocket: loadRocket, mines: loadMines, keys: loadKeys, backpack: loadBackpack,
    invite: loadInvite, leaderboard: loadLb, earn: loadEarn,
  };
  function show(name) {
    $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));
    $$('.bottom button').forEach((b) => b.classList.toggle('on', b.dataset.go === name));
    if (!NAV.includes(name)) $$('.bottom button').forEach((b) => b.classList.remove('on'));
    window.scrollTo(0, 0);
    if (loaders[name]) loaders[name]().catch(fail);
  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-go]');
    if (t) show(t.dataset.go);
  });
  $('#depBtn').onclick = () => show('earn');

  /* ============ Live bar ============ */
  async function loadLive() {
    let items = [];
    try { items = (await api('/live')).items; } catch (e) { /* jim */ }
    if (!items.length) {
      items = [{ e: '🚀', n: 'Rocket', w: 0 }, { e: '💎', n: 'Mines', w: 0 }, { e: '🔑', n: 'Keys', w: 0 }, { e: '🎁', n: 'Gifts', w: 0 }];
    }
    const card = (x) => `<div class="lc"><b>${x.e}</b><span>${esc(x.n)}</span><i>${x.w ? '+' + x.w + '⭐' : 'O\'ynang!'}</i></div>`;
    const html = items.map(card).join('');
    $('#liveTrack').innerHTML = html + html;
  }

  /* ============ ROCKET ============ */
  async function loadRocket() {
    const r = await api('/rocket');
    $('#rkInfo').textContent = `Stavka: ${r.min_bet} – ${r.max_bet} ⭐ · Koeffitsient: ${r.min_target}x – ${r.max_target}x`;
  }
  function animateRocket(stop) {
    return new Promise((resolve) => {
      const dur = Math.min(4500, 900 + (stop - 1) * 700);
      const ship = $('#rkShip');
      const stage = $('#rkStage');
      const W = stage.clientWidth - 70;
      const t0 = performance.now();
      (function frame(t) {
        const p = Math.min(1, (t - t0) / dur);
        const e = 1 - Math.pow(1 - p, 2);
        $('#rkMult').textContent = (1 + (stop - 1) * e).toFixed(2) + 'x';
        ship.style.transform = `translate(${p * W}px, ${-p * 120}px)`;
        if (p < 1) requestAnimationFrame(frame); else resolve();
      })(t0);
    });
  }
  $('#rkGo').onclick = async () => {
    const btn = $('#rkGo');
    const bet = Number($('#rkBet').value);
    const target = Number($('#rkTarget').value);
    btn.disabled = true;
    const stage = $('#rkStage');
    stage.className = 'stage';
    $('#rkShip').textContent = '🚀';
    $('#rkShip').style.transform = 'none';
    $('#rkMult').textContent = '1.00x';
    try {
      const r = await api('/rocket/bet', 'POST', { bet, target });
      await animateRocket(r.crash);
      const won = r.win > 0;
      stage.className = 'stage ' + (won ? 'win' : 'lose');
      if (!won) $('#rkShip').textContent = '💥';
      setBalance(r.balance);
      toast(won ? `🎉 Yutdingiz: +${r.win}⭐` : `💥 Portladi: ${r.crash.toFixed(2)}x`, !won);
      loadLive();
    } catch (e) { fail(e); }
    btn.disabled = false;
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
      b.textContent = '';
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
      $('#mInfo').innerHTML = `<span>Stavka: <b>${minesGame.bet}⭐</b></span><span>Mina: <b>${minesGame.mines_count}</b></span><span>Hozir: <b>${minesGame.multiplier.toFixed(2)}x</b></span><span>Keyingi: <b>${minesGame.next.toFixed(2)}x</b></span>`;
      $('#mCash').textContent = minesGame.opened.length ? `Yechib olish: ${minesGame.win_now}⭐` : 'Avval katakni oching';
      $('#mCash').disabled = !minesGame.opened.length;
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
    $('#mMsg').textContent = `Stavka: ${me.min_bet} – ${me.max_bet} ⭐`;
  }
  $('#mStart').onclick = async () => {
    try {
      const r = await api('/mines/start', 'POST', { bet: Number($('#mBet').value), mines: Number(mCount.value) });
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
      else if (r.status === 'lost') { revealEnd(r.mines, minesGame.opened, r.cell); toast('💣 Mina! Yutqazdingiz', true); }
      else { revealEnd(r.mines, r.opened, -1); toast(`🎉 Hammasi ochildi! +${r.win}⭐`); loadLive(); }
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
      toast(`✅ Yechildi: +${r.win}⭐`);
      loadLive();
    } catch (err) { fail(err); }
    minesBusy = false;
  };

  /* ============ KEYS ============ */
  async function loadKeys() {
    const { keys } = await api('/keys');
    const box = $('#keysList');
    box.innerHTML = keys.length
      ? keys.map((k) => `<div class="kcard" data-key="${k.id}"><div class="e">${esc(k.emoji)}</div><b>${esc(k.name)}</b><small>${k.price} ⭐</small></div>`).join('')
      : '<div class="card center">Hozircha keys yo\'q</div>';
    box.onclick = (e) => {
      const el = e.target.closest('.kcard');
      if (!el) return;
      openKeyModal(keys.find((k) => k.id === Number(el.dataset.key)));
    };
  }
  function openKeyModal(k) {
    if (!k) return;
    const rw = k.rewards.map((r) => `<div class="rwi"><span>${esc(r.name)}</span><b>${r.value} ⭐</b></div>`).join('');
    modal(`<h3>${esc(k.emoji)} ${esc(k.name)}</h3>${rw}<div class="kres" id="kRes">❓</div><button class="btn green" id="kOpen">Ochish — ${k.price} ⭐</button>`);
    $('#kOpen').onclick = async () => {
      const btn = $('#kOpen');
      btn.disabled = true;
      try {
        const r = await api(`/keys/${k.id}/open`, 'POST');
        for (let i = 0; i < 14; i++) {
          $('#kRes').textContent = k.rewards[Math.floor(Math.random() * k.rewards.length)].name;
          await sleep(70 + i * 12);
        }
        $('#kRes').innerHTML = `🎉 ${esc(r.reward.name)}<br>+${r.reward.value} ⭐`;
        setBalance(r.balance);
      } catch (e) { fail(e); }
      btn.disabled = false;
    };
  }

  /* ============ BACKPACK ============ */
  async function loadBackpack() {
    const [g, h] = await Promise.all([api('/gifts'), api('/history')]);
    $('#giftList').innerHTML = g.gifts.length
      ? g.gifts.map((x) => `<div><span>${esc(x.emoji)} ${esc(x.name)}</span><button data-buy="${x.id}" data-name="${esc(x.name)}" data-price="${x.price}">${x.price} ⭐</button></div>`).join('')
      : '<div>Hozircha giftlar yo\'q</div>';
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
    h.payments.forEach((p) => rows.push({ t: p.created_at, html: `<div><span>➕ Deposit · ${fmtDate(p.created_at)}</span><span class="win">+${p.amount}⭐</span></div>` }));
    h.rocket.forEach((r) => rows.push({ t: r.created_at, html: `<div><span>🚀 Rocket ${r.crash.toFixed(2)}x · ${fmtDate(r.created_at)}</span><span class="${r.win ? 'win' : 'lose'}">${r.win ? '+' + r.win : '-' + r.bet}⭐</span></div>` }));
    h.mines.forEach((m) => rows.push({ t: m.created_at, html: `<div><span>💎 Mines · ${fmtDate(m.created_at)}</span><span class="${m.win ? 'win' : 'lose'}">${m.win ? '+' + m.win : '-' + m.bet}⭐</span></div>` }));
    rows.sort((a, b) => b.t - a.t);
    $('#history').innerHTML = rows.length ? rows.map((r) => r.html).join('') : '<div>Tarix bo\'sh</div>';
  }

  /* ============ INVITE ============ */
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

  /* ============ LEADERBOARD ============ */
  async function loadLb() {
    const r = await api('/leaderboard');
    $('#lbInfo').textContent = `Konkurs sovrini: ${r.prize}⭐ · Sizning ochkoyingiz: ${r.my_score}`;
    const medals = ['🥇', '🥈', '🥉'];
    $('#lbList').innerHTML = r.top.length
      ? r.top.map((x, i) => `<div><span>${medals[i] || (i + 1) + '.'} ${esc(x.n)}${x.un ? ' @' + esc(x.un) : ''}</span><b>${x.s}</b></div>`).join('')
      : '<div>Hozircha ishtirokchilar yo\'q</div>';
  }

  /* ============ EARN: DEPOSIT ============ */
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
  async function loadEarn() {
    await refreshMe();
    if (me.is_admin) await loadAdmin(); else $('#adminBox').hidden = true;
  }

  /* ============ ADMIN PANEL ============ */
  const SET_LABELS = {
    rocket_rtp: 'Rocket: o\'yinchiga qaytish % (RTP)',
    mines_rtp: 'Mines: o\'yinchiga qaytish % (RTP)',
    min_bet: 'Minimal stavka ⭐',
    max_bet: 'Maksimal stavka ⭐',
    ref_bonus: 'Referal bonus ⭐',
    contest_prize: 'Konkurs sovrini ⭐',
  };
  async function loadAdmin() {
    const d = await api('/admin/data');
    const box = $('#adminBox');
    box.hidden = false;
    box.className = 'adm';
    const sets = Object.keys(SET_LABELS).map((k) =>
      `<label>${SET_LABELS[k]}</label><input type="number" data-set="${k}" value="${esc(d.settings[k])}" step="any">`).join('');
    const keys = d.keys.map((k) => `<div><span>${esc(k.emoji)} ${esc(k.name)} · ${k.price}⭐ · ${k.rewards.length} mukofot</span><button class="del" data-delkey="${k.id}">O'chirish</button></div>`).join('') || '<div>Keys yo\'q</div>';
    const gifts = d.gifts.map((g) => `<div><span>${esc(g.emoji)} ${esc(g.name)} · ${g.price}⭐</span><button class="del" data-delgift="${g.id}">O'chirish</button></div>`).join('') || '<div>Giftlar yo\'q</div>';
    const top = d.contest.map((c, i) => `<div><span>${i + 1}. ${esc(c.n)}${c.un ? ' @' + esc(c.un) : ''}</span><b>${c.s}</b></div>`).join('') || '<div>Ishtirokchi yo\'q</div>';
    box.innerHTML = `
      <h3>🛠 Admin panel <small style="color:var(--mute);font-size:11px">(${d.users} foydalanuvchi)</small></h3>
      <div class="card"><h4>Sozlamalar</h4>${sets}<button class="btn green" id="adSet">Saqlash</button></div>
      <div class="card"><h4>Yangi Keys</h4>
        <div class="row"><input id="nkName" placeholder="Nomi"><input id="nkEmoji" placeholder="Emoji 🔑"></div>
        <input id="nkPrice" type="number" placeholder="Narxi ⭐">
        <label>Mukofotlar (har qatorda: nomi|qiymat|ehtimol)</label>
        <textarea id="nkRew" placeholder="Mayda|5|50&#10;Oz|8|30&#10;Jackpot|100|1"></textarea>
        <button class="btn green" id="adKey">Keys qo'shish</button></div>
      <h4>Keyslar</h4><div class="list" id="adKeys">${keys}</div>
      <div class="card"><h4>Yangi Gift</h4>
        <div class="row"><input id="ngName" placeholder="Nomi"><input id="ngEmoji" placeholder="Emoji 🎁"></div>
        <input id="ngPrice" type="number" placeholder="Narxi ⭐">
        <button class="btn green" id="adGift">Gift qo'shish</button></div>
      <h4>Giftlar</h4><div class="list" id="adGifts">${gifts}</div>
      <div class="card"><h4>⭐ Stars qo'shish</h4>
        <input id="abId" type="number" placeholder="Foydalanuvchi ID">
        <input id="abAmount" type="number" placeholder="Summa (minus = ayirish)">
        <button class="btn green" id="adBal">Balansga qo'shish</button></div>
      <div class="card"><h4>🏆 Konkurs</h4><div class="list">${top}</div>
        <button class="btn purple" id="adFinish">Konkursni yakunlash</button></div>`;

    $('#adSet').onclick = async () => {
      const body = {};
      $$('[data-set]').forEach((i) => { body[i.dataset.set] = Number(i.value); });
      try { await api('/admin/settings', 'POST', body); toast('Saqlandi ✅'); } catch (e) { fail(e); }
    };
    $('#adKey').onclick = async () => {
      try {
        const rewards = $('#nkRew').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
          const [name, value, chance] = l.split('|').map((s) => s.trim());
          return { name, value: Number(value), chance: Number(chance) };
        });
        await api('/admin/keys', 'POST', { name: $('#nkName').value.trim(), emoji: $('#nkEmoji').value.trim() || '🔑', price: Number($('#nkPrice').value), rewards });
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
    $('#adBal').onclick = async () => {
      try {
        const r = await api('/admin/balance', 'POST', { user_id: Number($('#abId').value), amount: Number($('#abAmount').value) });
        toast(`✅ Yangi balans: ${r.balance}⭐`);
      } catch (e) { fail(e); }
    };
    $('#adFinish').onclick = async () => {
      if (!confirm('Konkurs yakunlansinmi? G\'olib sovrinni oladi, ochkolar nollanadi.')) return;
      try {
        const r = await api('/admin/contest/finish', 'POST');
        toast(`🏆 G'olib: ${r.winner.name} (+${r.prize}⭐)`);
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
  })();
})();
