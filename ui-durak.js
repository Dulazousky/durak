// Durak: host-side adapter for the room, and the game screen.
(() => {
  'use strict';
  const E = window.DurakEngine;
  const { h } = window.UI;
  const t = (k, p) => window.I18N.t(k, p);

  const SUIT_SYM = { S: '♠', C: '♣', D: '♦', H: '♥' };
  const FACES = { ru: { 11: 'В', 12: 'Д', 13: 'К', 14: 'Т' }, en: { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' } };
  const rankSym = (r) => (FACES[window.I18N.lang] || FACES.en)[r] || String(r);
  const cardName = (c) => rankSym(E.rank(c)) + SUIT_SYM[E.suit(c)];
  const isRed = (c) => E.suit(c) === 'H' || E.suit(c) === 'D';

  function cardEl(c, cls, extra) {
    const r = rankSym(E.rank(c));
    const s = SUIT_SYM[E.suit(c)];
    return h('div', Object.assign({ class: 'card' + (isRed(c) ? ' red' : '') + (cls ? ' ' + cls : '') }, extra || {}),
      h('span', { class: 'corner', text: r + '\n' + s }),
      h('span', { class: 'pip', text: s }),
      h('span', { class: 'corner bottom', text: r + '\n' + s }));
  }
  const backEl = (cls) => h('div', { class: 'card back' + (cls ? ' ' + cls : '') });

  let selected = null;
  let shownOnTable = new Set();
  let last = null; // {v, ctx} from the latest render

  function playerBadge(g, i) {
    const p = g.players[i];
    if (p.out) return ['out', 'done'];
    if (g.over) return null;
    if (i === g.defender) return [g.taking ? 'taking' : 'defending', 'def'];
    if (i === g.attacker) return ['attacking', 'att'];
    if (p.passed) return ['passed', 'pass'];
    return null;
  }

  function statusText(v) {
    const g = v.game;
    const me = v.you;
    if (g.over) return t('status.over');
    if (me < 0) return t('status.watching');
    if (g.players[me].out) return t('durak.st.youOut');
    const m = g.moves;
    const att = g.players[g.attacker].name;
    const def = g.players[g.defender].name;
    if (me === g.defender) {
      if (!g.table.length) return t('durak.st.attacksYou', { name: att });
      if (g.taking) return t('durak.st.youTake');
      if (g.table.some((x) => !x.d)) {
        if (m.transfer.length) return t('durak.st.defendOrTransfer');
        return Object.keys(m.defend).length ? t('durak.st.defend') : t('durak.st.mustTake');
      }
      return t('durak.st.defended');
    }
    if (!g.table.length) return me === g.attacker ? t('durak.st.yourMove') : t('durak.st.attacks', { a: att, d: def });
    if (m.attack.length && m.pass) return g.taking ? t('durak.st.throwOrPass', { name: def }) : t('durak.st.throwOrBito');
    if (m.attack.length) return t('durak.st.canThrow');
    return g.taking ? t('durak.st.takes', { name: def }) : t('durak.st.defends', { name: def });
  }

  function act(a) {
    selected = null;
    last.ctx.act(a);
  }

  function clickCard(c) {
    const g = last && last.v.game;
    if (!g || g.over) return;
    const m = g.moves;
    if (m.attack.includes(c)) return act({ type: 'attack', card: c });
    const targets = m.defend[c] || [];
    const canTransfer = m.transfer.includes(c);
    if (!targets.length && !canTransfer) selected = null;
    else if (selected === c) selected = null;
    else if (targets.length === 1 && !canTransfer && g.table.filter((x) => !x.d).length === 1) {
      return act({ type: 'defend', card: c, target: targets[0] });
    } else selected = c;
    last.ctx.rerender();
  }

  function render(stage, v, ctx) {
    last = { v, ctx };
    const g = v.game;
    const me = v.you;
    const el = (name) => stage.querySelector('[data-el="' + name + '"]');

    // Opponents in turn order, starting after me.
    const n = g.players.length;
    const start = me >= 0 ? me : n - 1;
    const opp = el('opponents');
    opp.replaceChildren();
    for (let k = 1; k <= n; k++) {
      const i = (start + k) % n;
      if (i === me) continue;
      const p = g.players[i];
      const seat = v.seats[i] || {};
      const badge = playerBadge(g, i);
      const fan = h('div', { class: 'fan' });
      for (let c = 0; c < Math.min(p.count, 8); c++) fan.append(backEl('mini'));
      opp.append(h('div', { class: 'opp' + (badge ? ' ' + badge[1] : '') + (p.out ? ' out' : '') },
        fan,
        h('div', { class: 'opp-name' },
          h('span', { text: (seat.bot ? '🤖 ' : '') + p.name }),
          h('span', { class: 'count', text: p.out ? '✓' : String(p.count) })),
        badge ? h('span', { class: 'badge-role ' + badge[1], text: t('durak.badge.' + badge[0]) }) : null,
        ctx.seatExtras(i)));
    }

    // Deck, trump and discard.
    const deck = el('deck');
    deck.replaceChildren();
    if (g.trumpCard) deck.append(cardEl(g.trumpCard, 'trump'));
    if (g.deckCount > 1) deck.append(backEl('stack'));
    deck.append(h('span', { class: 'deck-count', text: g.deckCount ? String(g.deckCount) : '' }));
    deck.append(h('span', { class: 'trump-suit' + (g.trump === 'H' || g.trump === 'D' ? ' red' : ''), title: t('durak.trump'), text: SUIT_SYM[g.trump] }));
    const discard = el('discard');
    discard.replaceChildren();
    if (g.discard) discard.append(backEl('tilt'), h('span', { class: 'deck-count', text: t('durak.discard', { n: g.discard }) }));

    const m = g.moves || { attack: [], defend: {}, transfer: [], take: false, pass: false };
    if (selected && !g.hand.includes(selected)) selected = null;
    const defTargets = selected ? (m.defend[selected] || []) : [];
    const canTransferSel = selected && m.transfer.includes(selected);

    // Table. Only cards that just landed get the deal animation.
    const table = el('table');
    table.replaceChildren();
    const onTable = new Set();
    const fresh = (c) => { onTable.add(c); return shownOnTable.has(c) ? '' : ' new'; };
    g.table.forEach((x, k) => {
      const target = defTargets.includes(k);
      const pair = h('div', {
        class: 'pair' + (target ? ' target' : ''),
        onclick: target ? () => act({ type: 'defend', card: selected, target: k }) : null,
      }, cardEl(x.a, 'a' + fresh(x.a)));
      if (x.d) pair.append(cardEl(x.d, 'd' + fresh(x.d)));
      table.append(pair);
    });
    shownOnTable = onTable;
    if (canTransferSel) {
      table.append(h('div', { class: 'pair ghost-slot', onclick: () => act({ type: 'transfer', card: selected }) },
        h('span', { text: t('durak.transferBtn') })));
    }
    if (!g.table.length && !g.over) {
      table.append(h('p', { class: 'table-empty', text: g.attacker === me ? t('durak.hint.yourMove') : t('durak.hint.moves', { name: g.players[g.attacker].name }) }));
    }

    // Status and buttons.
    el('status').textContent = statusText(v);
    const actions = el('actions');
    actions.replaceChildren();
    if (canTransferSel) actions.append(h('button', { class: 'btn primary', text: t('durak.transferBtn') + ' ' + cardName(selected), onclick: () => act({ type: 'transfer', card: selected }) }));
    if (m.take) actions.append(h('button', { class: 'btn warn', text: t('durak.take'), onclick: () => act({ type: 'take' }) }));
    if (m.pass) actions.append(h('button', { class: 'btn primary', text: g.taking ? t('durak.pass') : t('durak.bito'), onclick: () => act({ type: 'pass' }) }));

    // My hand: trumps on the right, sorted by suit then rank.
    const order = { S: 0, H: 1, C: 2, D: 3 };
    const key = (c) => (E.suit(c) === g.trump ? 10 : order[E.suit(c)]) * 100 + E.rank(c);
    const hand = el('hand');
    hand.replaceChildren();
    const sorted = g.hand.slice().sort((a, b) => key(a) - key(b));
    hand.style.setProperty('--n', sorted.length);
    for (const c of sorted) {
      const playable = m.attack.includes(c) || !!m.defend[c] || m.transfer.includes(c);
      hand.append(cardEl(c, (playable ? 'playable' : 'dim') + (c === selected ? ' selected' : '') + (E.suit(c) === g.trump ? ' is-trump' : ''), {
        role: 'button',
        tabindex: playable ? '0' : '-1',
        'aria-label': cardName(c),
        onclick: () => clickCard(c),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clickCard(c); } },
      }));
    }
    if (me >= 0 && g.players[me].out && !g.over) hand.append(h('p', { class: 'table-empty', text: t('durak.youOutHand') }));
    if (me < 0) hand.append(h('p', { class: 'table-empty', text: t('status.watchingNext') }));
  }

  function logText(e, v) {
    const names = v.game.players.map((p) => p.name);
    const who = names[e.p] || '?';
    switch (e.t) {
      case 'start': return e.c ? t('durak.log.startTrump', { name: who, card: cardName(e.c) }) : t('durak.log.start', { name: who });
      case 'attack': return t('durak.log.attack', { name: who, card: cardName(e.c) });
      case 'throw': return t('durak.log.throw', { name: who, card: cardName(e.c) });
      case 'defend': return t('durak.log.defend', { name: who, card: cardName(e.c), on: cardName(e.on) });
      case 'transfer': return t('durak.log.transfer', { name: who, to: names[e.to] || '?', card: cardName(e.c) });
      case 'take': return t('durak.log.take', { name: who });
      case 'took': return t('durak.log.took', { name: who, n: e.n });
      case 'bito': return t('durak.log.bito');
      case 'out': return t('durak.log.out', { name: who });
      case 'over': return e.p >= 0 ? t('durak.log.durak', { name: who }) : t('log.draw');
    }
    return '';
  }

  window.GAMES.durak = {
    id: 'durak',
    icon: '🃏',
    min: 2,
    max: E.MAX_PLAYERS,
    scoreKind: 'losses',
    defaultSettings: { transfer: false },
    create: (names, settings) => E.newGame(names, { transfer: !!settings.transfer }),
    apply: E.apply,
    view: E.viewFor,
    isOver: (st) => st.over,
    winner: () => -1,
    loser: (st) => st.durak,
    botOrder: (st) => [st.defender],
    botWants: (st, i) => !!E.botAction(E.viewFor(st, i)),
    botAction: (st, i) => E.botAction(E.viewFor(st, i)),
    rename(st, i, name) { if (st.players[i]) st.players[i].name = name; },

    settings(v, ctx) {
      const wrap = h('div', { class: 'game-settings' });
      if (v.isHost) {
        wrap.append(h('label', { class: 'toggle' },
          h('input', { type: 'checkbox', checked: !!v.settings.transfer, onchange: (e) => ctx.send({ t: 'settings', settings: { transfer: e.target.checked } }) }),
          h('span', { text: t('durak.transferMode') })));
      }
      wrap.append(h('p', { class: 'muted small', text: t(v.settings.transfer ? 'durak.noteTransfer' : 'durak.notePodkidnoy') }));
      return wrap;
    },
    mode: (v) => t(v.game && v.game.transfer ? 'durak.modeTransfer' : 'durak.modePodkidnoy'),
    mount(stage) {
      stage.append(h('div', { class: 'board durak-board' },
        h('div', { class: 'opponents', 'data-el': 'opponents' }),
        h('div', { class: 'middle' },
          h('div', { class: 'pile-area' }, h('div', { class: 'deck', 'data-el': 'deck' }), h('div', { class: 'discard', 'data-el': 'discard' })),
          h('div', { class: 'table', 'data-el': 'table' })),
        h('div', { class: 'me' },
          h('div', { class: 'me-bar' }, h('p', { class: 'status', 'data-el': 'status' }), h('div', { class: 'actions', 'data-el': 'actions' })),
          h('div', { class: 'hand', 'data-el': 'hand' }))));
    },
    render,
    reset() { selected = null; shownOnTable = new Set(); },
    escape() { if (!selected) return false; selected = null; return true; },
    overText(v) {
      const g = v.game;
      if (g.durak < 0) return { title: t('durak.over.draw'), sub: t('durak.over.drawSub') };
      if (g.durak === v.you) return { title: t('durak.over.you'), sub: t('durak.over.youSub') };
      return { title: t('durak.over.other', { name: g.players[g.durak].name }), sub: t('durak.over.otherSub') };
    },
    logText,
  };
})();
