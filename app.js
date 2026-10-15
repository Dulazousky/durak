// Durak online: UI and networking. One player hosts the room in their browser
// and runs the rules engine; everyone else connects to the host over WebRTC
// (PeerJS) and only ever receives their own view of the game.
(() => {
  'use strict';
  const E = window.DurakEngine;
  const $ = (s) => document.querySelector(s);
  const params = new URLSearchParams(location.search);

  const PEER_PREFIX = 'durak-online-v1-';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const BOT_NAMES = ['Бот Вася', 'Бот Маша', 'Бот Гена', 'Бот Оля', 'Бот Петя'];
  const SUIT_SYM = { S: '♠', C: '♣', D: '♦', H: '♥' };
  const RANK_SYM = { 11: 'В', 12: 'Д', 13: 'К', 14: 'Т' };

  // ---- small helpers --------------------------------------------------

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } },
  };

  function randomId(len, chars) {
    chars = chars || 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    const buf = new Uint32Array(len);
    crypto.getRandomValues(buf);
    for (const x of buf) s += chars[x % chars.length];
    return s;
  }

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids) if (kid != null) el.append(kid);
    return el;
  }

  const cardName = (c) => (RANK_SYM[E.rank(c)] || E.rank(c)) + SUIT_SYM[E.suit(c)];
  const isRed = (c) => E.suit(c) === 'H' || E.suit(c) === 'D';

  function cardEl(c, extra) {
    const r = RANK_SYM[E.rank(c)] || String(E.rank(c));
    const s = SUIT_SYM[E.suit(c)];
    return h('div', Object.assign({ class: 'card' + (isRed(c) ? ' red' : '') }, extra || {}),
      h('span', { class: 'corner', text: r + '\n' + s }),
      h('span', { class: 'pip', text: s }),
      h('span', { class: 'corner bottom', text: r + '\n' + s }));
  }

  const backEl = (cls) => h('div', { class: 'card back' + (cls ? ' ' + cls : '') });

  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  function show(id) {
    for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
  }

  function peerOptions() {
    // ?peer=host:port points at a self-hosted PeerJS server (used for local testing).
    const p = params.get('peer');
    if (!p) return { debug: 1 };
    const [host, port] = p.split(':');
    return { host, port: Number(port) || 9000, path: '/', secure: location.protocol === 'https:', debug: 1 };
  }

  const myToken = store.get('durak-token') || randomId(16);
  store.set('durak-token', myToken);
  const myName = () => ($('#nameInput').value.trim() || store.get('durak-name') || 'Игрок').slice(0, 16);

  // ---- state ----------------------------------------------------------

  let role = null; // 'host' | 'guest'
  let code = null;
  let peer = null;
  let view = null; // the last room view we rendered
  let selected = null; // selected card in hand
  let overHidden = false;
  let chatOpen = false;
  let seenChat = 0;
  let shownOnTable = new Set();

  // Host only
  let room = null;
  const conns = new Set();
  let botTimer = 0;
  let releaseHostLock = null;

  // Guest only
  let conn = null;
  let joinedOnce = false;
  let retryTimer = 0;
  let retries = 0;

  // ---- host -----------------------------------------------------------

  function newRoom(c) {
    return {
      code: c,
      host: randomId(16),
      settings: { transfer: false },
      seats: [{ token: null, name: myName(), bot: false, connected: true, score: 0 }],
      watchers: [],
      phase: 'lobby',
      game: null,
      scored: false,
      gameNo: 0,
      chat: [],
    };
  }

  function saveRoom() {
    store.set('durak-host-' + room.code, JSON.stringify(room));
  }

  function seatOf(token) {
    return room.seats.findIndex((s) => s.token === token);
  }

  function buildView(token) {
    const idx = seatOf(token);
    return {
      code: room.code,
      you: idx,
      isHost: token === room.host,
      settings: room.settings,
      phase: room.phase,
      gameNo: room.gameNo,
      seats: room.seats.map((s) => ({ name: s.name, bot: s.bot, connected: s.connected || s.bot, score: s.score, host: s.token === room.host })),
      watchers: room.watchers.map((w) => w.name),
      chat: room.chat.slice(-60),
      game: room.game ? E.viewFor(room.game, room.phase === 'game' ? idx : -1) : null,
    };
  }

  function broadcast() {
    if (!room) return;
    if (room.game && room.game.over && !room.scored) {
      room.scored = true;
      if (room.game.durak >= 0) room.seats[room.game.durak].score++;
    }
    for (const c of conns) {
      if (c.open && c.token) {
        try { c.send({ t: 'state', v: buildView(c.token) }); } catch (e) { /* closed meanwhile */ }
      }
    }
    render(buildView(room.host));
    saveRoom();
    scheduleBots();
  }

  function scheduleBots() {
    clearTimeout(botTimer);
    const g = room.game;
    if (room.phase !== 'game' || !g || g.over) return;
    const order = [g.defender];
    room.seats.forEach((s, i) => { if (i !== g.defender) order.push(i); });
    for (const i of order) {
      if (!room.seats[i].bot) continue;
      if (E.botAction(E.viewFor(g, i))) {
        botTimer = setTimeout(() => runBot(i), 650 + Math.random() * 600);
        return;
      }
    }
  }

  function runBot(i) {
    const g = room.game;
    if (!g || g.over || !room.seats[i] || !room.seats[i].bot) return;
    const a = E.botAction(E.viewFor(g, i));
    if (a) E.apply(g, i, a);
    broadcast();
  }

  function startGame() {
    if (room.seats.length < 2) return toast('Нужно хотя бы 2 игрока');
    room.phase = 'game';
    room.game = E.newGame(room.seats.map((s) => s.name), { transfer: room.settings.transfer });
    room.scored = false;
    room.gameNo++;
    broadcast();
  }

  function toLobby() {
    room.phase = 'lobby';
    room.game = null;
    // Leave out people who walked away mid-game; seat whoever was watching.
    room.seats = room.seats.filter((s) => s.connected || s.bot || s.token === room.host);
    for (const w of room.watchers) {
      if (room.seats.length < E.MAX_PLAYERS) room.seats.push({ token: w.token, name: w.name, bot: false, connected: true, score: 0 });
    }
    room.watchers = [];
    broadcast();
  }

  // Every message, from a guest connection or from the host's own UI.
  function handle(token, msg, c) {
    if (!msg || typeof msg !== 'object') return;
    const isHost = token === room.host;
    const idx = seatOf(token);
    const reply = (m) => { if (c) c.send(m); else if (m.t === 'err') toast(m.m); };

    switch (msg.t) {
      case 'hello': {
        const name = String(msg.name || 'Игрок').trim().slice(0, 16) || 'Игрок';
        for (const other of conns) if (other !== c && other.token === token) other.close();
        c.token = token;
        if (idx >= 0) {
          const s = room.seats[idx];
          s.connected = true;
          s.name = name;
          if (s.wasHuman) { s.bot = false; delete s.wasHuman; }
          if (room.game) room.game.players[idx].name = name;
        } else if (room.phase === 'lobby' && room.seats.length < E.MAX_PLAYERS) {
          room.seats.push({ token, name, bot: false, connected: true, score: 0 });
        } else {
          room.watchers = room.watchers.filter((w) => w.token !== token);
          room.watchers.push({ token, name });
        }
        broadcast();
        break;
      }
      case 'act': {
        if (room.phase !== 'game' || !room.game || idx < 0) return;
        const err = E.apply(room.game, idx, msg.a);
        if (err) reply({ t: 'err', m: err });
        broadcast();
        break;
      }
      case 'chat': {
        const text = String(msg.text || '').trim().slice(0, 200);
        if (!text) return;
        const name = idx >= 0 ? room.seats[idx].name : (room.watchers.find((w) => w.token === token) || {}).name || 'Гость';
        room.chat.push({ n: name, x: text, at: Date.now() });
        if (room.chat.length > 100) room.chat.shift();
        broadcast();
        break;
      }
      case 'leave':
        dropToken(token);
        break;
      // Host-only commands from the host's own screen.
      case 'start':
        if (isHost && room.phase === 'lobby') startGame();
        break;
      case 'rematch':
        if (isHost && room.game && room.game.over) startGame();
        break;
      case 'lobby':
        if (isHost) toLobby();
        break;
      case 'transfer':
        if (isHost && room.phase === 'lobby') { room.settings.transfer = !!msg.on; broadcast(); }
        break;
      case 'addBot':
        if (isHost && room.phase === 'lobby' && room.seats.length < E.MAX_PLAYERS) {
          const used = new Set(room.seats.map((s) => s.name));
          const name = BOT_NAMES.find((n) => !used.has(n)) || 'Бот';
          room.seats.push({ token: 'bot-' + randomId(8), name, bot: true, connected: true, score: 0 });
          broadcast();
        }
        break;
      case 'kick':
        if (isHost && room.phase === 'lobby' && msg.i > 0 && msg.i < room.seats.length) {
          const [s] = room.seats.splice(msg.i, 1);
          for (const other of conns) if (other.token === s.token) { other.send({ t: 'kicked' }); setTimeout(() => other.close(), 300); }
          broadcast();
        }
        break;
      case 'botify':
        // A player dropped out mid-game: let a bot play their hand until they return.
        if (isHost && room.game && msg.i > 0 && room.seats[msg.i] && !room.seats[msg.i].connected) {
          room.seats[msg.i].bot = true;
          room.seats[msg.i].wasHuman = true;
          broadcast();
        }
        break;
    }
  }

  // A guest left or lost the connection. In the lobby their seat frees up; in
  // a game it waits for them (or for a bot the host seats there).
  function dropToken(token) {
    const idx = seatOf(token);
    room.watchers = room.watchers.filter((w) => w.token !== token);
    if (idx > 0) {
      if (room.phase === 'lobby') room.seats.splice(idx, 1);
      else room.seats[idx].connected = false;
    }
    broadcast();
  }

  function hostRoom(c, restored) {
    role = 'host';
    code = c;
    room = restored || newRoom(c);
    room.seats[0].token = room.host;
    room.seats.forEach((s) => { if (!s.bot && s.token !== room.host) s.connected = false; });
    room.seats[0].name = myName();
    location.hash = c;
    broadcast();
    openHostPeer(0);
  }

  // Re-register with the signalling server after a drop. Connections that are
  // already open keep working meanwhile.
  function reconnectPeer() {
    if (!peer || peer.destroyed || !peer.disconnected) return;
    try { peer.reconnect(); } catch (e) { /* the next 'disconnected' retries */ }
  }

  function openHostPeer(attempt) {
    if (peer) peer.destroy();
    peer = new Peer(PEER_PREFIX + code, peerOptions());
    peer.on('open', () => { setNetStatus(''); });
    peer.on('connection', (c) => {
      c.on('open', () => conns.add(c));
      c.on('data', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'hello') {
          if (typeof msg.token !== 'string' || !msg.token || msg.token.startsWith('bot-') || msg.token === room.host) return c.close();
          handle(msg.token, msg, c);
        } else if (c.token) handle(c.token, msg, c);
      });
      c.on('close', () => {
        conns.delete(c);
        if (c.token && ![...conns].some((o) => o.token === c.token)) dropToken(c.token);
      });
      c.on('error', () => {});
    });
    peer.on('disconnected', () => {
      setNetStatus('Нет связи с сервером, переподключаемся…');
      setTimeout(reconnectPeer, 1500);
    });
    peer.on('error', (e) => {
      if (e.type === 'unavailable-id') {
        // After a reload the server may still hold our old id for a moment.
        if (attempt < 8) {
          setNetStatus('Занимаем комнату…');
          setTimeout(() => openHostPeer(attempt + 1), 2500);
        } else {
          setNetStatus('Код комнаты занят. Создайте новую комнату.');
        }
      } else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error' || e.type === 'socket-closed') {
        setNetStatus('Нет связи с сервером, переподключаемся…');
        setTimeout(() => openHostPeer(attempt), 4000);
      } else if (e.type === 'browser-incompatible') {
        setNetStatus('Браузер не поддерживает WebRTC — можно играть только с ботами.');
      }
    });
  }

  // ---- guest ----------------------------------------------------------

  function joinRoom(c) {
    role = 'guest';
    code = c;
    location.hash = c;
    showConnecting('Подключаемся к комнате ' + c + '…');
    if (peer) peer.destroy();
    peer = new Peer(peerOptions());
    peer.on('open', connectToHost);
    peer.on('disconnected', () => setTimeout(reconnectPeer, 1500));
    peer.on('error', (e) => {
      if (e.type === 'peer-unavailable') {
        retries++;
        if (joinedOnce || retries < 4) {
          if (joinedOnce) setNetStatus('Хост отключился. Ждём его возвращения…');
          retryLater(3000);
        } else {
          showConnecting('Комната ' + c + ' не найдена. Проверьте код или попросите хоста открыть игру.', true);
        }
      } else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error' || e.type === 'socket-closed') {
        if (!joinedOnce) showConnecting('Нет связи с сервером…', true);
        else setNetStatus('Нет связи, переподключаемся…');
        retryLater(4000, true);
      } else if (e.type === 'browser-incompatible') {
        showConnecting('Этот браузер не поддерживает WebRTC. Попробуйте Chrome, Firefox или Safari.', true);
      }
    });
  }

  function retryLater(ms, newPeer) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (role !== 'guest') return;
      if (newPeer || !peer || peer.destroyed) joinRoom(code);
      else connectToHost();
    }, ms);
  }

  function connectToHost() {
    if (conn) conn.close();
    const c = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'json' });
    conn = c;
    // A connection that never opens (blocked by NAT) is retried.
    const guard = setTimeout(() => {
      if (c === conn && !c.open) {
        if (!joinedOnce) showConnecting('Не получается соединиться с хостом. Пробуем ещё раз…', true);
        retryLater(500);
      }
    }, 12000);
    c.on('open', () => {
      clearTimeout(guard);
      retries = 0;
      c.send({ t: 'hello', name: myName(), token: myToken });
    });
    c.on('data', (msg) => {
      if (c !== conn || !msg) return;
      if (msg.t === 'state') {
        joinedOnce = true;
        setNetStatus('');
        render(msg.v);
      } else if (msg.t === 'err') toast(msg.m);
      else if (msg.t === 'kicked') { goHome('Хост убрал вас из комнаты'); }
    });
    c.on('close', () => {
      if (c !== conn || role !== 'guest') return;
      setNetStatus('Связь с хостом потеряна, переподключаемся…');
      retryLater(2000);
    });
    c.on('error', () => {});
  }

  // ---- sending --------------------------------------------------------

  function send(msg) {
    if (role === 'host') handle(room.host, msg, null);
    else if (conn && conn.open) conn.send(msg);
    else toast('Нет связи с хостом');
  }

  const act = (a) => { selected = null; send({ t: 'act', a }); };

  // ---- screens --------------------------------------------------------

  function showConnecting(text, failed) {
    show('connecting');
    $('#connText').textContent = text;
    $('#connSpinner').hidden = !!failed;
    $('#connRetryBtn').hidden = !failed;
  }

  let netStatus = '';
  function setNetStatus(s) {
    netStatus = s;
    if (view) render(view);
  }

  function goHome(err) {
    clearTimeout(retryTimer);
    clearTimeout(botTimer);
    if (peer) peer.destroy();
    if (releaseHostLock) { releaseHostLock(); releaseHostLock = null; }
    peer = null;
    conn = null;
    conns.clear();
    role = null;
    room = null;
    view = null;
    joinedOnce = false;
    retries = 0;
    history.replaceState(null, '', location.pathname + location.search);
    $('#inviteBox').hidden = true;
    $('#homeActions').hidden = false;
    $('#homeError').hidden = !err;
    $('#homeError').textContent = err || '';
    show('home');
  }

  function leave() {
    if (role === 'host') {
      if (!confirm('Закрыть комнату? Игра закончится для всех.')) return;
      for (const c of conns) { try { c.send({ t: 'kicked' }); } catch (e) { /* ignore */ } }
      store.del('durak-host-' + code);
      setTimeout(() => goHome(), 200);
    } else {
      if (conn && conn.open) conn.send({ t: 'leave' });
      setTimeout(() => goHome(), 150);
    }
  }

  function shareLink() {
    return location.origin + location.pathname + location.search + '#' + code;
  }

  function render(v) {
    view = v;
    if (v.phase === 'lobby' || !v.game) renderLobby(v);
    else renderGame(v);
  }

  function renderLobby(v) {
    show('lobby');
    $('#lobbyCode').textContent = v.code;
    $('#shareLink').value = shareLink();
    const list = $('#seatList');
    list.replaceChildren();
    v.seats.forEach((s, i) => {
      const tags = [];
      if (s.host) tags.push(h('span', { class: 'tag', text: 'хост' }));
      if (s.bot) tags.push(h('span', { class: 'tag', text: 'бот' }));
      if (i === v.you) tags.push(h('span', { class: 'tag you', text: 'вы' }));
      if (!s.connected) tags.push(h('span', { class: 'tag off', text: 'нет связи' }));
      const kick = v.isHost && i > 0
        ? h('button', { class: 'btn ghost small', title: 'Убрать', text: '✕', onclick: () => send({ t: 'kick', i }) })
        : null;
      list.append(h('li', null, h('span', { class: 'avatar', text: s.bot ? '🤖' : (s.name[0] || '?').toUpperCase() }),
        h('span', { class: 'seat-name', text: s.name }), ...tags,
        s.score ? h('span', { class: 'score', text: 'дурак ×' + s.score }) : null, kick));
    });
    for (let i = v.seats.length; i < E.MAX_PLAYERS; i++) {
      list.append(h('li', { class: 'empty' }, h('span', { class: 'avatar', text: '·' }), h('span', { text: 'свободное место' })));
    }
    if (v.you < 0) list.append(h('li', { class: 'empty' }, h('span', { text: 'Комната заполнена, вы наблюдаете' })));

    $('#hostControls').hidden = !v.isHost;
    $('#startBtn').hidden = !v.isHost;
    $('#lobbyWait').hidden = v.isHost;
    $('#addBotBtn').disabled = v.seats.length >= E.MAX_PLAYERS;
    $('#startBtn').disabled = v.seats.length < 2;
    $('#transferToggle').checked = v.settings.transfer;
    $('#modeNote').textContent = (v.settings.transfer
      ? 'Переводной: отбивающийся может перевести ход картой того же достоинства.'
      : 'Подкидной: подкидывать можно карты тех достоинств, что уже на столе.')
      + (netStatus ? ' · ' + netStatus : '');
  }

  function playerBadge(g, i) {
    const p = g.players[i];
    if (p.out) return ['вышел', 'done'];
    if (g.over) return null;
    if (i === g.defender) return [g.taking ? 'берёт' : 'отбивается', 'def'];
    if (i === g.attacker) return [g.table.length ? 'ходит' : 'ходит…', 'att'];
    if (p.passed) return ['пас', 'pass'];
    return null;
  }

  function renderGame(v) {
    show('game');
    const g = v.game;
    const me = v.you;
    $('#gameCode').textContent = v.code;
    $('#modeTag').textContent = g.transfer ? 'переводной' : 'подкидной';

    // Opponents in turn order, starting after me.
    const n = g.players.length;
    const start = me >= 0 ? me : n - 1;
    const opp = $('#opponents');
    opp.replaceChildren();
    for (let k = 1; k <= n; k++) {
      const i = (start + k) % n;
      if (i === me) continue;
      const p = g.players[i];
      const seat = v.seats[i] || {};
      const badge = playerBadge(g, i);
      const fan = h('div', { class: 'fan' });
      for (let c = 0; c < Math.min(p.count, 8); c++) fan.append(backEl('mini'));
      const bot = v.isHost && !seat.connected && !seat.bot
        ? h('button', { class: 'btn small', text: 'Посадить бота', onclick: () => send({ t: 'botify', i }) })
        : null;
      opp.append(h('div', { class: 'opp' + (badge ? ' ' + badge[1] : '') + (p.out ? ' out' : '') },
        fan,
        h('div', { class: 'opp-name' },
          h('span', { text: (seat.bot ? '🤖 ' : '') + p.name }),
          h('span', { class: 'count', text: p.out ? '✓' : String(p.count) })),
        badge ? h('span', { class: 'badge-role ' + badge[1], text: badge[0] }) : null,
        seat.connected === false && !seat.bot ? h('span', { class: 'off-note', text: 'нет связи' }) : null,
        bot));
    }

    // Deck, trump and discard.
    const deck = $('#deck');
    deck.replaceChildren();
    if (g.trumpCard) deck.append(cardEl(g.trumpCard, { class: 'card trump' + (isRed(g.trumpCard) ? ' red' : '') }));
    if (g.deckCount > 1) deck.append(backEl('stack'));
    deck.append(h('span', { class: 'deck-count', text: g.deckCount ? String(g.deckCount) : '' }));
    deck.append(h('span', { class: 'trump-suit' + (g.trump === 'H' || g.trump === 'D' ? ' red' : ''), title: 'Козырь', text: SUIT_SYM[g.trump] }));
    const discard = $('#discard');
    discard.replaceChildren();
    if (g.discard) discard.append(backEl('tilt'), h('span', { class: 'deck-count', text: 'бито ' + g.discard }));

    // My possible moves for the selected card.
    const m = g.moves || { attack: [], defend: {}, transfer: [], take: false, pass: false };
    if (selected && !g.hand.includes(selected)) selected = null;
    const defTargets = selected ? (m.defend[selected] || []) : [];
    const canTransferSel = selected && m.transfer.includes(selected);

    // Table. Only cards that just landed get the deal animation.
    const table = $('#table');
    table.replaceChildren();
    const onTable = new Set();
    const fresh = (c) => { onTable.add(c); return shownOnTable.has(c) ? '' : ' new'; };
    g.table.forEach((x, k) => {
      const target = defTargets.includes(k);
      const pair = h('div', {
        class: 'pair' + (target ? ' target' : ''),
        onclick: target ? () => act({ type: 'defend', card: selected, target: k }) : null,
      }, cardEl(x.a, { class: 'card' + (isRed(x.a) ? ' red' : '') + ' a' + fresh(x.a) }));
      if (x.d) pair.append(cardEl(x.d, { class: 'card' + (isRed(x.d) ? ' red' : '') + ' d' + fresh(x.d) }));
      table.append(pair);
    });
    shownOnTable = onTable;
    if (canTransferSel) {
      table.append(h('div', { class: 'pair ghost-slot', onclick: () => act({ type: 'transfer', card: selected }) },
        h('span', { text: 'Перевести' })));
    }
    if (!g.table.length) table.append(h('p', { class: 'table-empty', text: tableHint(v) }));

    // Status and buttons.
    $('#status').textContent = netStatus || statusText(v);
    const actions = $('#actions');
    actions.replaceChildren();
    if (canTransferSel) actions.append(h('button', { class: 'btn primary', text: 'Перевести ' + cardName(selected), onclick: () => act({ type: 'transfer', card: selected }) }));
    if (m.take) actions.append(h('button', { class: 'btn warn', text: 'Взять', onclick: () => act({ type: 'take' }) }));
    if (m.pass) actions.append(h('button', { class: 'btn primary', text: g.taking ? 'Пас' : 'Бито', onclick: () => act({ type: 'pass' }) }));

    // My hand: trumps on the right, sorted by suit then rank.
    const order = { S: 0, H: 1, C: 2, D: 3 };
    const key = (c) => (E.suit(c) === g.trump ? 10 : order[E.suit(c)]) * 100 + E.rank(c);
    const hand = $('#hand');
    hand.replaceChildren();
    const sorted = g.hand.slice().sort((a, b) => key(a) - key(b));
    hand.style.setProperty('--n', sorted.length);
    for (const c of sorted) {
      const playable = m.attack.includes(c) || !!m.defend[c] || m.transfer.includes(c);
      const el = cardEl(c, {
        class: 'card' + (isRed(c) ? ' red' : '') + (playable ? ' playable' : ' dim') + (c === selected ? ' selected' : '') + (E.suit(c) === g.trump ? ' is-trump' : ''),
        role: 'button',
        tabindex: playable ? '0' : '-1',
        'aria-label': cardName(c),
        onclick: () => clickCard(c),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clickCard(c); } },
      });
      hand.append(el);
    }
    if (me >= 0 && g.players[me].out && !g.over) hand.append(h('p', { class: 'table-empty', text: 'Вы вышли из игры 🎉' }));
    if (me < 0) hand.append(h('p', { class: 'table-empty', text: 'Вы наблюдаете. Сядете за стол в следующей партии.' }));

    renderOver(v);
    renderChat(v);
  }

  function tableHint(v) {
    const g = v.game;
    if (g.over) return '';
    if (g.attacker === v.you) return 'Ваш ход — выберите карту';
    return g.players[g.attacker].name + ' ходит…';
  }

  function statusText(v) {
    const g = v.game;
    const me = v.you;
    if (g.over) return 'Партия окончена';
    if (me < 0) return 'Вы наблюдаете';
    if (g.players[me].out) return 'Вы вышли. Ждём, кто останется дураком…';
    const m = g.moves;
    const att = g.players[g.attacker].name;
    const def = g.players[g.defender].name;
    if (me === g.defender) {
      if (!g.table.length) return att + ' ходит под вас';
      if (g.taking) return 'Вы берёте. Ждём, подкинут ли ещё…';
      if (g.table.some((x) => !x.d)) {
        if (m.transfer.length) return 'Отбивайтесь, переводите или берите';
        return Object.keys(m.defend).length ? 'Отбивайтесь: выберите карту, потом — какую бить' : 'Нечем крыть — придётся взять';
      }
      return 'Отбились! Ждём, подкинут ли ещё…';
    }
    if (!g.table.length) return me === g.attacker ? 'Ваш ход' : att + ' ходит, отбивается ' + def;
    if (m.attack.length && m.pass) return g.taking ? def + ' берёт — подкиньте или «Пас»' : 'Подкиньте или нажмите «Бито»';
    if (m.attack.length) return 'Можно подкинуть';
    return g.taking ? def + ' берёт' : def + ' отбивается';
  }

  function clickCard(c) {
    const g = view && view.game;
    if (!g || g.over) return;
    const m = g.moves;
    if (m.attack.includes(c)) return act({ type: 'attack', card: c });
    const targets = m.defend[c] || [];
    const canTransfer = m.transfer.includes(c);
    if (!targets.length && !canTransfer) {
      selected = null;
      render(view);
      return;
    }
    if (selected === c) selected = null;
    else if (targets.length === 1 && !canTransfer && g.table.filter((x) => !x.d).length === 1) {
      return act({ type: 'defend', card: c, target: targets[0] });
    } else selected = c;
    render(view);
  }

  function renderOver(v) {
    const g = v.game;
    const box = $('#over');
    if (!g.over) { overHidden = false; box.hidden = true; return; }
    box.hidden = overHidden;
    const me = v.you;
    let title;
    if (g.durak < 0) title = 'Ничья! 🤝';
    else if (g.durak === me) title = 'Вы дурак 🃏';
    else title = 'Дурак — ' + g.players[g.durak].name + ' 🃏';
    $('#overTitle').textContent = title;
    $('#overSub').textContent = g.durak < 0 ? 'Последние карты вышли одновременно' : (g.durak === me ? 'Отыграетесь в следующий раз!' : 'Поздравляем всех, кто вышел!');
    const tbl = $('#scoreTable');
    tbl.replaceChildren(h('tr', null, h('th', { text: 'Игрок' }), h('th', { text: 'Был дураком' })));
    v.seats.forEach((s) => tbl.append(h('tr', null, h('td', { text: s.name }), h('td', { text: String(s.score) }))));
    $('#overHost').hidden = !v.isHost;
    $('#overWait').hidden = v.isHost;
  }

  function logText(e, names) {
    const who = names[e.p] || '?';
    switch (e.t) {
      case 'start': return e.c ? who + ' ходит первым (младший козырь ' + cardName(e.c) + ')' : who + ' ходит первым';
      case 'attack': return who + ' ходит ' + cardName(e.c);
      case 'throw': return who + ' подкидывает ' + cardName(e.c);
      case 'defend': return who + ' бьёт ' + cardName(e.on) + ' картой ' + cardName(e.c);
      case 'transfer': return who + ' переводит на ' + (names[e.to] || '?') + ' (' + cardName(e.c) + ')';
      case 'take': return who + ' берёт';
      case 'took': return who + ' забирает ' + e.n + ' ' + cardsWord(e.n);
      case 'bito': return 'Бито';
      case 'out': return who + ' выходит из игры';
      case 'over': return e.p >= 0 ? who + ' — дурак!' : 'Ничья';
    }
    return '';
  }

  function cardsWord(n) {
    const d = n % 10;
    const dd = n % 100;
    if (d === 1 && dd !== 11) return 'карту';
    if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return 'карты';
    return 'карт';
  }

  function renderChat(v) {
    const names = v.game ? v.game.players.map((p) => p.name) : [];
    const items = [];
    for (const c of v.chat) items.push({ at: c.at, chat: c });
    if (v.game) for (const e of v.game.log) items.push({ at: e.at, log: e });
    items.sort((a, b) => a.at - b.at);
    const list = $('#chatLog');
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.replaceChildren(...items.map((it) => it.chat
      ? h('li', { class: 'msg' }, h('b', { text: it.chat.n + ': ' }), h('span', { text: it.chat.x }))
      : h('li', { class: 'log', text: logText(it.log, names) })));
    if (atBottom) list.scrollTop = list.scrollHeight;
    const unseen = v.chat.length - seenChat;
    if (chatOpen) seenChat = v.chat.length;
    $('#chatBadge').hidden = chatOpen || unseen <= 0;
    $('#chatBadge').textContent = unseen > 0 ? String(unseen) : '';
  }

  // ---- wiring ---------------------------------------------------------

  function setChat(open) {
    chatOpen = open;
    document.body.classList.toggle('chat-open', open);
    if (view) render(view);
    if (open) { const l = $('#chatLog'); l.scrollTop = l.scrollHeight; }
  }

  function rememberName() {
    const n = $('#nameInput').value.trim();
    if (!n) { $('#nameInput').focus(); $('#nameInput').classList.add('shake'); setTimeout(() => $('#nameInput').classList.remove('shake'), 500); return false; }
    store.set('durak-name', n.slice(0, 16));
    return true;
  }

  function cleanCode(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  }

  function boot() {
    $('#nameInput').value = store.get('durak-name') || '';

    $('#createBtn').onclick = async () => {
      if (!rememberName()) return;
      const c = randomId(5, CODE_CHARS);
      await grabHostLock(c);
      hostRoom(c);
    };
    $('#joinForm').onsubmit = (e) => {
      e.preventDefault();
      const c = cleanCode($('#codeInput').value);
      if (c.length !== 5) { $('#codeInput').focus(); return; }
      if (!rememberName()) return;
      enterRoom(c);
    };
    $('#acceptInviteBtn').onclick = () => {
      if (!rememberName()) return;
      enterRoom(cleanCode(location.hash.slice(1)));
    };
    $('#connBackBtn').onclick = () => goHome();
    $('#connRetryBtn').onclick = () => { retries = 0; joinRoom(code); };
    for (const b of document.querySelectorAll('[data-action="leave"]')) b.onclick = leave;
    $('#copyBtn').onclick = async () => {
      const link = shareLink();
      try {
        if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'Дурак онлайн', text: 'Играем в дурака!', url: link });
        else { await navigator.clipboard.writeText(link); toast('Ссылка скопирована'); }
      } catch (e) {
        $('#shareLink').select();
        toast('Скопируйте ссылку вручную');
      }
    };
    $('#addBotBtn').onclick = () => send({ t: 'addBot' });
    $('#transferToggle').onchange = (e) => send({ t: 'transfer', on: e.target.checked });
    $('#startBtn').onclick = () => send({ t: 'start' });
    $('#rematchBtn').onclick = () => send({ t: 'rematch' });
    $('#toLobbyBtn').onclick = () => send({ t: 'lobby' });
    $('#overHideBtn').onclick = () => { overHidden = true; $('#over').hidden = true; };
    $('#chatToggle').onclick = () => setChat(!chatOpen);
    $('#chatClose').onclick = () => setChat(false);
    $('#chatForm').onsubmit = (e) => {
      e.preventDefault();
      const text = $('#chatInput').value.trim();
      if (!text) return;
      send({ t: 'chat', text });
      $('#chatInput').value = '';
    };
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && selected) { selected = null; render(view); }
    });
    window.addEventListener('hashchange', () => {
      const c = cleanCode(location.hash.slice(1));
      if (c && c !== code) route();
    });
    if (matchMedia('(min-width: 1100px)').matches) setChat(true);
    route();
  }

  // Only one tab can be the host. Another tab of the same browser that opens
  // the room's link joins it as a guest instead.
  function grabHostLock(c) {
    if (!navigator.locks) return Promise.resolve(true);
    return new Promise((resolve) => {
      navigator.locks.request('durak-host-' + c, { ifAvailable: true }, (lock) => {
        if (!lock) return resolve(false);
        resolve(true);
        return new Promise((release) => { releaseHostLock = release; });
      }).catch(() => resolve(true));
    });
  }

  async function enterRoom(c) {
    const saved = store.get('durak-host-' + c);
    if (saved) {
      let r = null;
      try { r = JSON.parse(saved); } catch (e) { /* fall through to joining */ }
      if (r && r.host && r.seats && await grabHostLock(c)) return hostRoom(c, r);
    }
    joinRoom(c);
  }

  function route() {
    const c = cleanCode(location.hash.slice(1));
    if (c.length !== 5) return goHome();
    if (store.get('durak-host-' + c) || store.get('durak-name')) return enterRoom(c);
    // Invited, but we don't know their name yet.
    show('home');
    $('#inviteCode').textContent = c;
    $('#inviteBox').hidden = false;
    $('#homeActions').hidden = true;
    $('#nameInput').focus();
  }

  boot();
})();
