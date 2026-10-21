// Rooms, networking and the shared screens. One player hosts the room in their
// browser and runs the rules engine of the chosen game; everyone else connects
// to the host over WebRTC (PeerJS) and only ever receives their own view.
// The games themselves live in ui-*.js and register in window.GAMES.
(() => {
  'use strict';
  const { $, h, store, randomId, toast } = window.UI;
  const GAMES = window.GAMES;
  const I18N = window.I18N;
  const t = (k, p) => I18N.t(k, p);
  const params = new URLSearchParams(location.search);

  const PEER_PREFIX = 'durak-online-v1-';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const GAME_IDS = ['durak', 'battleship', 'chess'];

  // STUN finds each browser's public address; TURN relays the traffic when
  // two networks can't reach each other directly (common on mobile data).
  // PeerJS's own free TURN servers are often down, so the site can hand out
  // credentials for its own relay from api/ice (see README); the shared ones
  // stay as a fallback.
  const STUN = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  const PEERJS_TURN = { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' };
  let ownRelay = []; // filled from api/ice when the site has a relay configured

  const iceReady = fetch('api/ice', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { if (j && Array.isArray(j.iceServers)) ownRelay = j.iceServers.filter((x) => x && x.urls); })
    .catch(() => { /* static hosting without the function: shared relay only */ });
  // Don't hold up joining for long if api/ice is slow.
  const iceSettled = () => Promise.race([iceReady, new Promise((r) => setTimeout(r, 3000))]);

  function peerOptions() {
    const config = { iceServers: STUN.concat(ownRelay, [PEERJS_TURN]), sdpSemantics: 'unified-plan' };
    // ?peer=host:port points at a self-hosted PeerJS server (used for local testing).
    const p = params.get('peer');
    if (!p) return { debug: 1, config };
    const [host, port] = p.split(':');
    return { host, port: Number(port) || 9000, path: '/', secure: location.protocol === 'https:', debug: 1, config };
  }

  const myToken = store.get('durak-token') || randomId(16);
  store.set('durak-token', myToken);
  const myName = () => ($('#nameInput').value.trim() || store.get('durak-name') || t('player')).slice(0, 16);

  // ---- state ----------------------------------------------------------

  let role = null; // 'host' | 'guest'
  let code = null;
  let peer = null;
  let view = null; // the last room view we rendered
  let shownGameNo = -1;
  let overHidden = false;
  let chatOpen = false;
  let seenChat = 0;
  let netStatus = ''; // i18n key

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

  const gameOf = (r) => GAMES[r.gameType] || GAMES.durak;

  // ---- host -----------------------------------------------------------

  function newRoom(c, type) {
    return {
      code: c,
      host: randomId(16),
      gameType: type,
      settings: Object.assign({}, GAMES[type].defaultSettings),
      seats: [{ token: null, name: myName(), bot: false, connected: true, score: 0 }],
      watchers: [],
      phase: 'lobby',
      game: null,
      scored: false,
      gameNo: 0,
      seed: Math.random() < 0.5 ? 0 : 1,
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
    const G = gameOf(room);
    return {
      code: room.code,
      gameType: room.gameType,
      max: G.max,
      min: G.min,
      you: idx,
      isHost: token === room.host,
      settings: room.settings,
      phase: room.phase,
      gameNo: room.gameNo,
      seats: room.seats.map((s) => ({ name: s.name, bot: s.bot, connected: s.connected || s.bot, score: s.score, host: s.token === room.host })),
      watchers: room.watchers.map((w) => w.name),
      chat: room.chat.slice(-60),
      game: room.game ? G.view(room.game, room.phase === 'game' ? idx : -1) : null,
    };
  }

  function broadcast() {
    if (!room) return;
    const G = gameOf(room);
    if (room.game && G.isOver(room.game) && !room.scored) {
      room.scored = true;
      const i = G.scoreKind === 'losses' ? G.loser(room.game) : G.winner(room.game);
      if (i >= 0 && room.seats[i]) room.seats[i].score++;
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
    const G = gameOf(room);
    if (room.phase !== 'game' || !g || G.isOver(g)) return;
    const first = G.botOrder ? G.botOrder(g) : [];
    const order = first.concat(room.seats.map((_, i) => i).filter((i) => !first.includes(i)));
    for (const i of order) {
      if (!room.seats[i] || !room.seats[i].bot) continue;
      if (G.botWants(g, i)) {
        botTimer = setTimeout(() => runBot(i), 650 + Math.random() * 600);
        return;
      }
    }
  }

  function runBot(i) {
    const g = room && room.game;
    if (!g) return;
    const G = gameOf(room);
    if (G.isOver(g) || !room.seats[i] || !room.seats[i].bot) return;
    const a = G.botAction(g, i);
    if (a) G.apply(g, i, a);
    broadcast();
  }

  function startGame() {
    const G = gameOf(room);
    if (room.seats.length < G.min) return toast(t('err.needPlayers', { n: G.min }));
    room.phase = 'game';
    room.game = G.create(room.seats.slice(0, G.max).map((s) => s.name), room.settings, room);
    room.scored = false;
    room.gameNo++;
    broadcast();
  }

  function toLobby() {
    const G = gameOf(room);
    room.phase = 'lobby';
    room.game = null;
    // Leave out people who walked away mid-game; seat whoever was watching.
    room.seats = room.seats.filter((s) => s.connected || s.bot || s.token === room.host);
    const still = [];
    for (const w of room.watchers) {
      if (room.seats.length < G.max) room.seats.push({ token: w.token, name: w.name, bot: false, connected: true, score: 0 });
      else still.push(w);
    }
    room.watchers = still;
    broadcast();
  }

  function botName() {
    const used = new Set(room.seats.map((s) => s.name));
    const names = t('botNames').split(',');
    return names.find((n) => !used.has(n)) || names[0];
  }

  // Every message, from a guest connection or from the host's own UI.
  function handle(token, msg, c) {
    if (!msg || typeof msg !== 'object') return;
    const G = gameOf(room);
    const isHost = token === room.host;
    const idx = seatOf(token);
    const reply = (m) => { if (c) c.send(m); else if (m.t === 'err') toast(t('err.' + m.m)); };

    switch (msg.t) {
      case 'hello': {
        const name = String(msg.name || t('player')).trim().slice(0, 16) || t('player');
        for (const other of conns) if (other !== c && other.token === token) other.close();
        c.token = token;
        if (idx >= 0) {
          const s = room.seats[idx];
          s.connected = true;
          s.name = name;
          if (s.wasHuman) { s.bot = false; delete s.wasHuman; }
          if (room.game) G.rename(room.game, idx, name);
        } else if (room.phase === 'lobby' && room.seats.length < G.max) {
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
        const err = G.apply(room.game, idx, msg.a);
        if (err) reply({ t: 'err', m: err });
        broadcast();
        break;
      }
      case 'chat': {
        const text = String(msg.text || '').trim().slice(0, 200);
        if (!text) return;
        const name = idx >= 0 ? room.seats[idx].name : (room.watchers.find((w) => w.token === token) || {}).name || t('guest');
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
        if (isHost && room.game && G.isOver(room.game)) startGame();
        break;
      case 'lobby':
        if (isHost) toLobby();
        break;
      case 'settings':
        if (isHost && room.phase === 'lobby' && msg.settings) {
          for (const k in G.defaultSettings) {
            if (k in msg.settings) room.settings[k] = typeof G.defaultSettings[k] === 'boolean' ? !!msg.settings[k] : msg.settings[k];
          }
          broadcast();
        }
        break;
      case 'addBot':
        if (isHost && room.phase === 'lobby' && room.seats.length < G.max) {
          room.seats.push({ token: 'bot-' + randomId(8), name: botName(), bot: true, connected: true, score: 0 });
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
        // A player dropped out mid-game: let a bot play for them until they return.
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

  function hostRoom(c, restored, type) {
    role = 'host';
    code = c;
    room = restored || newRoom(c, type);
    if (!GAMES[room.gameType]) room.gameType = 'durak'; // rooms saved before there was a choice
    if (!room.settings) room.settings = Object.assign({}, GAMES[room.gameType].defaultSettings);
    if (room.seed == null) room.seed = 0;
    room.seats[0].token = room.host;
    room.seats.forEach((s) => { if (!s.bot && s.token !== room.host) s.connected = false; });
    room.seats[0].name = myName();
    location.hash = c;
    broadcast();
    hostRetry = 0;
    openHostPeer();
  }

  // Re-register with the signalling server after a drop. Connections that are
  // already open keep working meanwhile.
  function reconnectPeer() {
    if (!peer || peer.destroyed || !peer.disconnected) return;
    try { peer.reconnect(); } catch (e) { /* the next 'disconnected' retries */ }
  }

  const isNetError = (e) => ['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type);
  let hostRetry = 0;

  // The host registers the room code with the PeerJS server. When that link
  // drops (screen locked, tab in the background, Wi-Fi blip), the guests'
  // direct connections keep working, so we only re-register; tearing the peer
  // down would cut everyone off. The server can keep the old registration for
  // up to a minute, so "code taken" means wait and retry, never give up.
  function openHostPeer() {
    if (peer) peer.destroy();
    peer = new Peer(PEER_PREFIX + code, peerOptions());
    peer.on('open', () => { hostRetry = 0; setNetStatus(''); });
    peer.on('connection', (c) => {
      c.on('open', () => conns.add(c));
      c.on('data', (msg) => {
        if (!room || !msg || typeof msg !== 'object') return;
        if (msg.t === 'hello') {
          if (typeof msg.token !== 'string' || !msg.token || msg.token.startsWith('bot-') || msg.token === room.host) return c.close();
          handle(msg.token, msg, c);
        } else if (c.token) handle(c.token, msg, c);
      });
      c.on('close', () => {
        conns.delete(c);
        if (!room) return;
        if (c.token && ![...conns].some((o) => o.token === c.token)) dropToken(c.token);
      });
      c.on('error', () => {});
    });
    const me = peer;
    peer.on('disconnected', () => {
      if (me !== peer || me.destroyed) return;
      if (netStatus !== 'net.claiming') setNetStatus('net.reconnecting');
      retryHostPeer();
    });
    peer.on('error', (e) => {
      if (me !== peer) return;
      lastError = e.type;
      if (e.type === 'unavailable-id') {
        setNetStatus('net.claiming');
        retryHostPeer();
      } else if (isNetError(e)) {
        setNetStatus('net.reconnecting');
        retryHostPeer();
      } else if (e.type === 'browser-incompatible') {
        setNetStatus('net.noWebrtcHost');
      }
    });
  }

  let hostRetryTimer = 0;
  function retryHostPeer() {
    clearTimeout(hostRetryTimer);
    const delay = Math.min(2000 + hostRetry * 1000, 8000);
    hostRetry++;
    hostRetryTimer = setTimeout(() => {
      if (role !== 'host') return;
      if (peer && !peer.destroyed) reconnectPeer();
      else openHostPeer();
    }, delay);
  }

  // ---- guest ----------------------------------------------------------

  function joinRoom(c) {
    role = 'guest';
    code = c;
    location.hash = c;
    showConnecting('conn.joining');
    if (peer) peer.destroy();
    peer = new Peer(peerOptions());
    // 'open' also fires after re-registering with the server; a working link
    // to the host doesn't need replacing then.
    peer.on('open', () => { refreshDiag(); if (!(conn && conn.open)) connectToHost(); });
    peer.on('disconnected', () => setTimeout(reconnectPeer, 1500));
    peer.on('error', (e) => {
      lastError = e.type;
      if (e.type === 'peer-unavailable') {
        retries++;
        // The host may be re-registering after a hiccup, so give it ~45 s.
        if (joinedOnce || retries < 15) {
          if (!joinedOnce && retries > 2) showConnecting('conn.waitingHost');
          if (joinedOnce) setNetStatus('net.hostGone');
          retryLater(3000);
        } else {
          showConnecting('conn.notFound', true);
        }
      } else if (isNetError(e)) {
        // Once connected, the game runs over the direct link to the host; the
        // server is only needed to find it. Keep that link and quietly retry.
        if (conn && conn.open) setTimeout(reconnectPeer, 3000);
        else {
          if (!joinedOnce) showConnecting('conn.noServer', true);
          else setNetStatus('net.reconnecting');
          retryLater(4000, true);
        }
      } else if (e.type === 'browser-incompatible') {
        showConnecting('conn.noWebrtc', true);
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
    // A connection that never opens (blocked by NAT) is retried. A relayed
    // connection can take a while to set up, so be patient.
    const guard = setTimeout(() => {
      if (c === conn && !c.open) {
        if (!joinedOnce) showConnecting(ownRelay.length ? 'conn.cantReach' : 'conn.iceFailed', true);
        retryLater(500);
      }
    }, 30000);
    c.on('iceStateChanged', (state) => {
      if (c !== conn) return;
      const was = lastIce;
      lastIce = state;
      // checking -> disconnected/failed before ever opening: the two networks
      // couldn't find a way to each other, not even through a relay.
      if (!c.open && !joinedOnce && (state === 'failed' || (state === 'disconnected' && was === 'checking'))) showConnecting('conn.iceFailed', true);
      else refreshDiag();
    });
    c.on('open', () => {
      clearTimeout(guard);
      retries = 0;
      c.send({ t: 'hello', name: myName(), token: myToken });
    });
    c.on('data', (msg) => {
      if (c !== conn || !msg) return;
      if (msg.t === 'state') {
        joinedOnce = true;
        netStatus = '';
        render(msg.v);
      } else if (msg.t === 'err') toast(t('err.' + msg.m));
      else if (msg.t === 'kicked') goHome('kicked');
    });
    c.on('close', () => {
      if (c !== conn || role !== 'guest') return;
      setNetStatus('net.lost');
      retryLater(2000);
    });
    c.on('error', (e) => { if (c === conn) { lastError = (e && e.type) || 'connection'; refreshDiag(); } });
  }

  // ---- sending --------------------------------------------------------

  function send(msg) {
    if (role === 'host') handle(room.host, msg, null);
    else if (conn && conn.open) conn.send(msg);
    else toast(t('net.noHost'));
  }

  // ---- screens --------------------------------------------------------

  function show(id) {
    for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
  }

  let connKey = null;
  let lastError = '';
  let lastIce = '';
  function showConnecting(key, failed) {
    connKey = { key, failed };
    show('connecting');
    $('#connText').textContent = t(key, { code });
    refreshDiag();
    $('#connSpinner').hidden = !!failed;
    $('#connRetryBtn').hidden = !failed;
  }

  // One line under the spinner saying how far the connection got, so a stuck
  // player can tell whether it's the server, the room or the direct link.
  function refreshDiag() {
    if (!connKey) return;
    const server = peer && peer.open ? '✓' : '…';
    $('#connDetail').textContent = t('conn.diag', { server, link: lastIce || '…', relay: ownRelay.length ? t('conn.relayOwn') : t('conn.relayShared') }) +
      (lastError ? ' · ' + t('conn.error', { err: lastError }) : '');
  }

  function setNetStatus(key) {
    netStatus = key;
    if (view) render(view);
  }

  let homeError = '';
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
    connKey = null;
    lastError = '';
    lastIce = '';
    clearTimeout(hostRetryTimer);
    joinedOnce = false;
    retries = 0;
    history.replaceState(null, '', location.pathname + location.search);
    $('#inviteBox').hidden = true;
    $('#homeActions').hidden = false;
    homeError = err || '';
    $('#homeError').hidden = !err;
    $('#homeError').textContent = err ? t(err) : '';
    show('home');
  }

  function leave() {
    if (role === 'host') {
      if (!confirm(t('confirmClose'))) return;
      for (const c of conns) { try { c.send({ t: 'kicked' }); } catch (e) { /* ignore */ } }
      store.del('durak-host-' + code);
    } else if (conn && conn.open) {
      conn.send({ t: 'leave' });
    }
    // Go home right away, but give the goodbye a moment to go out before the
    // old connection closes. (Waiting before going home let a link opened in
    // that moment be thrown back to the home screen.)
    const old = peer;
    peer = null;
    goHome();
    if (old) setTimeout(() => old.destroy(), 400);
  }

  function shareLink() {
    return location.origin + location.pathname + location.search + '#' + code;
  }

  // Shared pieces the game screens use.
  const ctx = {
    act: (a) => send({ t: 'act', a }),
    send,
    rerender: () => { if (view) render(view); },
    // Under a player's name: "offline", and for the host a button to seat a bot.
    seatExtras(i) {
      const seat = view && view.seats[i];
      if (!seat || seat.connected || seat.bot) return null;
      return h('span', { class: 'seat-extra' },
        h('span', { class: 'off-note', text: t('offline') }),
        view.isHost ? h('button', { class: 'btn small', text: t('seatBot'), onclick: () => send({ t: 'botify', i }) }) : null);
    },
  };

  function render(v) {
    view = v;
    if (v.phase === 'lobby' || !v.game) renderLobby(v);
    else renderGame(v);
  }

  function gameTitle(type) {
    return (GAMES[type] ? GAMES[type].icon + ' ' : '') + t('game.' + type);
  }

  function renderLobby(v) {
    show('lobby');
    const G = GAMES[v.gameType];
    $('#lobbyCode').textContent = v.code;
    $('#lobbyGame').textContent = gameTitle(v.gameType);
    $('#shareLink').value = shareLink();
    const list = $('#seatList');
    list.replaceChildren();
    v.seats.forEach((s, i) => {
      const tags = [];
      if (s.host) tags.push(h('span', { class: 'tag', text: t('tag.host') }));
      if (s.bot) tags.push(h('span', { class: 'tag', text: t('tag.bot') }));
      if (i === v.you) tags.push(h('span', { class: 'tag you', text: t('you') }));
      if (!s.connected) tags.push(h('span', { class: 'tag off', text: t('offline') }));
      const kick = v.isHost && i > 0
        ? h('button', { class: 'btn ghost small', title: t('kick'), text: '✕', onclick: () => send({ t: 'kick', i }) })
        : null;
      list.append(h('li', null, h('span', { class: 'avatar', text: s.bot ? '🤖' : (s.name[0] || '?').toUpperCase() }),
        h('span', { class: 'seat-name', text: s.name }), ...tags,
        s.score ? h('span', { class: 'score', text: t(G.scoreKind === 'losses' ? 'score.lossesShort' : 'score.winsShort', { n: s.score }) }) : null, kick));
    });
    for (let i = v.seats.length; i < v.max; i++) {
      list.append(h('li', { class: 'empty' }, h('span', { class: 'avatar', text: '·' }), h('span', { text: t('freeSeat') })));
    }
    if (v.you < 0) list.append(h('li', { class: 'empty' }, h('span', { text: t('roomFull') })));
    if (v.watchers.length) list.append(h('li', { class: 'empty' }, h('span', { text: t('watchers') + ': ' + v.watchers.join(', ') })));

    $('#playersNote').textContent = v.min === v.max ? t('playersExactly', { n: v.max }) : t('playersRange', { min: v.min, max: v.max });
    $('#addBotBtn').hidden = !v.isHost;
    $('#addBotBtn').disabled = v.seats.length >= v.max;
    $('#startBtn').hidden = !v.isHost;
    $('#lobbyWait').hidden = v.isHost;
    $('#startBtn').disabled = v.seats.length < v.min;
    $('#gameSettings').replaceChildren(G.settings(v, ctx));
    // The host sees whether friends can join yet; guests only see trouble.
    const open = role === 'host' && peer && peer.open;
    const line = role === 'host'
      ? (open ? t('net.roomOpen') : t(netStatus || 'net.roomOpening') + (lastError ? ' · ' + t('conn.error', { err: lastError }) : ''))
      : (netStatus ? t(netStatus) : '');
    $('#lobbyNet').hidden = !line;
    $('#lobbyNet').textContent = line;
    $('#lobbyNet').className = 'small net-line' + (open ? ' ok' : ' bad');
  }

  function renderGame(v) {
    show('game');
    const G = GAMES[v.gameType];
    const stage = $('#stage');
    if (stage.dataset.game !== v.gameType) {
      stage.replaceChildren();
      G.mount(stage);
      stage.dataset.game = v.gameType;
      shownGameNo = -1;
    }
    if (shownGameNo !== v.gameNo) {
      G.reset();
      shownGameNo = v.gameNo;
      overHidden = false;
    }
    $('#gameCode').textContent = v.code;
    const mode = G.mode(v);
    $('#modeTag').textContent = gameTitle(v.gameType) + (mode ? ' · ' + mode : '');
    $('#netBanner').hidden = !netStatus;
    $('#netBanner').textContent = netStatus ? t(netStatus) : '';
    G.render(stage, v, ctx);
    renderOver(v, G);
    renderChat(v, G);
  }

  function renderOver(v, G) {
    const box = $('#over');
    if (!G.isOver(v.game)) { overHidden = false; box.hidden = true; return; }
    box.hidden = overHidden;
    const o = G.overText(v);
    $('#overTitle').textContent = o.title;
    $('#overSub').textContent = o.sub || '';
    const tbl = $('#scoreTable');
    tbl.replaceChildren(h('tr', null, h('th', { text: t('player') }), h('th', { text: t(G.scoreKind === 'losses' ? 'score.losses' : 'score.wins') })));
    v.seats.forEach((s) => tbl.append(h('tr', null, h('td', { text: s.name }), h('td', { text: String(s.score) }))));
    $('#overHost').hidden = !v.isHost;
    $('#overWait').hidden = v.isHost;
  }

  function renderChat(v, G) {
    const items = [];
    for (const c of v.chat) items.push({ at: c.at, chat: c });
    if (v.game) for (const e of v.game.log) items.push({ at: e.at, log: e });
    items.sort((a, b) => a.at - b.at);
    const list = $('#chatLog');
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.replaceChildren(...items.map((it) => it.chat
      ? h('li', { class: 'msg' }, h('b', { text: it.chat.n + ': ' }), h('span', { text: it.chat.x }))
      : h('li', { class: 'log', text: G.logText(it.log, v) })));
    if (atBottom) list.scrollTop = list.scrollHeight;
    const unseen = v.chat.length - seenChat;
    if (chatOpen) seenChat = v.chat.length;
    $('#chatBadge').hidden = chatOpen || unseen <= 0;
    $('#chatBadge').textContent = unseen > 0 ? String(unseen) : '';
  }

  // ---- language ---------------------------------------------------------

  function refreshLanguage() {
    I18N.apply();
    for (const b of document.querySelectorAll('[data-action="lang"]')) b.textContent = I18N.lang === 'ru' ? 'EN' : 'RU';
    if (view) render(view);
    else if (connKey) showConnecting(connKey.key, connKey.failed);
    if (homeError) $('#homeError').textContent = t(homeError);
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
    if (!n) {
      $('#nameInput').focus();
      $('#nameInput').classList.add('shake');
      setTimeout(() => $('#nameInput').classList.remove('shake'), 500);
      return false;
    }
    store.set('durak-name', n.slice(0, 16));
    return true;
  }

  function cleanCode(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  }

  function chosenGame() {
    const el = document.querySelector('input[name="gameType"]:checked');
    return el && GAMES[el.value] ? el.value : 'durak';
  }

  function boot() {
    $('#nameInput').value = store.get('durak-name') || '';
    const lastGame = store.get('durak-game');
    if (GAME_IDS.includes(lastGame)) document.querySelector('input[name="gameType"][value="' + lastGame + '"]').checked = true;

    $('#createBtn').onclick = async () => {
      if (!rememberName()) return;
      const type = chosenGame();
      store.set('durak-game', type);
      const c = randomId(5, CODE_CHARS);
      await iceSettled();
      await grabHostLock(c);
      hostRoom(c, null, type);
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
    for (const b of document.querySelectorAll('[data-action="lang"]')) b.onclick = () => I18N.setLang(I18N.lang === 'ru' ? 'en' : 'ru');
    I18N.onChange(refreshLanguage);
    $('#copyBtn').onclick = async () => {
      const link = shareLink();
      try {
        if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: t('title'), text: t('shareText', { game: t('game.' + view.gameType) }), url: link });
        else { await navigator.clipboard.writeText(link); toast(t('copied')); }
      } catch (e) {
        $('#shareLink').select();
        toast(t('copyManually'));
      }
    };
    $('#addBotBtn').onclick = () => send({ t: 'addBot' });
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
      if (!view || !view.game || e.target.closest('input, textarea')) return;
      const G = GAMES[view.gameType];
      if ((e.key === 'Escape' && G.escape()) || (G.key && G.key(e))) render(view);
    });
    // Phones freeze background tabs; reconnect as soon as we're visible again.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (role === 'host') {
        if (!peer || peer.destroyed) openHostPeer();
        else if (peer.disconnected) reconnectPeer();
      } else if (role === 'guest' && joinedOnce && !(conn && conn.open)) {
        retryLater(0);
      }
    });
    window.addEventListener('hashchange', () => {
      const c = cleanCode(location.hash.slice(1));
      if (c && c !== code) route();
    });
    if (matchMedia('(min-width: 1100px)').matches) setChat(true);
    refreshLanguage();
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
    await iceSettled();
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
