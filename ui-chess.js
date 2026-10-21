// Chess: host-side adapter for the room, and the game screen.
(() => {
  'use strict';
  const C = window.ChessEngine;
  const { h } = window.UI;
  const t = (k, p) => window.I18N.t(k, p);

  // One filled glyph per piece, coloured by CSS. U+FE0E asks for the text
  // form, so phones don't swap the pawn for an emoji.
  const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  const glyph = (p) => GLYPH[p.toLowerCase()] + '︎';
  const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

  let selected = -1;
  let promo = null; // {from, to} waiting for a piece choice
  let last = null;

  function act(a) {
    selected = -1;
    promo = null;
    last.ctx.act(a);
  }

  function clickSquare(s) {
    const g = last.v.game;
    if (g.over) return;
    const moves = g.moves;
    if (selected >= 0) {
      const to = moves.filter((m) => m.from === selected && m.to === s);
      if (to.length > 1) { promo = { from: selected, to: s }; last.ctx.rerender(); return; }
      if (to.length === 1) return act({ type: 'move', from: selected, to: s });
    }
    selected = moves.some((m) => m.from === s) && s !== selected ? s : -1;
    last.ctx.rerender();
  }

  function playerBar(v, i, ctx) {
    const g = v.game;
    if (i < 0) return h('div', { class: 'cbar' });
    const color = i === g.white ? 'w' : 'b';
    const seat = v.seats[i] || {};
    // Pieces this player has taken, and the material lead if any.
    const taken = g.captured[color].slice().sort((a, b) => VALUE[b.toLowerCase()] - VALUE[a.toLowerCase()]);
    const score = (c) => g.captured[c].reduce((s, p) => s + VALUE[p.toLowerCase()], 0);
    const lead = score(color) - score(color === 'w' ? 'b' : 'w');
    const toMove = !g.over && g.pos.turn === color;
    return h('div', { class: 'cbar' + (toMove ? ' to-move' : '') },
      h('span', { class: 'cdot ' + color }),
      h('span', { class: 'cname', text: (seat.bot ? '🤖 ' : '') + g.names[i] + (i === v.you ? ' (' + t('you') + ')' : '') }),
      h('span', { class: 'ctaken' + (color === 'w' ? ' of-b' : ' of-w'), text: taken.map(glyph).join('') }),
      lead > 0 ? h('span', { class: 'clead', text: '+' + lead }) : null,
      ctx.seatExtras(i));
  }

  function statusText(v) {
    const g = v.game;
    if (g.over) return t('status.over');
    if (v.you < 0) return t('status.watching');
    const mine = g.pos.turn === g.color;
    if (mine) return g.check >= 0 ? t('chess.st.check') : t('chess.st.yourMove');
    return t('chess.st.theirMove', { name: g.names[1 - v.you] });
  }

  function render(stage, v, ctx) {
    last = { v, ctx };
    const g = v.game;
    const el = (name) => stage.querySelector('[data-el="' + name + '"]');
    const me = v.you;
    const flip = g.color === 'b';
    const moves = g.moves || [];
    if (selected >= 0 && !moves.some((m) => m.from === selected)) selected = -1;
    const targets = new Set(moves.filter((m) => m.from === selected).map((m) => m.to));

    const top = me >= 0 ? 1 - me : (g.white === 0 ? 1 : 0);
    const bottom = me >= 0 ? me : g.white;
    el('top').replaceChildren(playerBar(v, top, ctx));
    el('bottom').replaceChildren(playerBar(v, bottom, ctx));

    const board = el('board');
    board.replaceChildren();
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const r = flip ? row : 7 - row;
        const f = flip ? 7 - col : col;
        const s = r * 8 + f;
        const p = g.pos.board[s];
        const cls = ['sq', (r + f) % 2 ? 'light' : 'dark'];
        if (g.last && (g.last.from === s || g.last.to === s)) cls.push('lastmove');
        if (s === selected) cls.push('sel');
        if (s === g.check) cls.push('check');
        if (targets.has(s)) cls.push(p ? 'capture' : 'target');
        if (moves.some((m) => m.from === s)) cls.push('movable');
        const sq = h('button', { class: cls.join(' '), 'aria-label': C.sqName(s) + (p ? ' ' + p : ''), onclick: () => clickSquare(s) });
        if (p) sq.append(h('span', { class: 'piece ' + (C.colorOf(p) === 'w' ? 'white' : 'black'), text: glyph(p) }));
        if (col === 0) sq.append(h('span', { class: 'coord rank', text: String(r + 1) }));
        if (row === 7) sq.append(h('span', { class: 'coord file', text: C.FILES[f] }));
        board.append(sq);
      }
    }

    // Promotion picker.
    const picker = el('promo');
    picker.hidden = !promo;
    if (promo) {
      picker.replaceChildren(h('p', { text: t('chess.promote') }), h('div', { class: 'promo-row' },
        ...['q', 'r', 'b', 'n'].map((k) => h('button', {
          class: 'promo-btn piece ' + (g.color === 'w' ? 'white' : 'black'),
          text: glyph(k),
          'aria-label': t('chess.piece.' + k),
          onclick: () => act({ type: 'move', from: promo.from, to: promo.to, promo: k }),
        })),
        h('button', { class: 'btn ghost small', text: '✕', onclick: () => { promo = null; selected = -1; ctx.rerender(); } })));
    }

    el('status').textContent = statusText(v);
    const actions = el('actions');
    actions.replaceChildren();
    if (me >= 0 && !g.over) {
      if (g.drawOffer === 1 - me) {
        actions.append(h('span', { class: 'offer', text: t('chess.offerIn') }),
          h('button', { class: 'btn primary', text: t('chess.accept'), onclick: () => act({ type: 'acceptDraw' }) }),
          h('button', { class: 'btn', text: t('chess.decline'), onclick: () => act({ type: 'declineDraw' }) }));
      } else if (g.drawOffer === me) {
        actions.append(h('span', { class: 'offer', text: t('chess.offerOut') }));
      } else {
        actions.append(h('button', { class: 'btn ghost', text: t('chess.offerDraw'), onclick: () => act({ type: 'offerDraw' }) }));
      }
      actions.append(h('button', { class: 'btn ghost', text: t('resign'), onclick: () => { if (confirm(t('resignConfirm'))) act({ type: 'resign' }); } }));
    }

    // Move list, two plies per line.
    const list = el('moves');
    list.replaceChildren();
    for (let k = 0; k < g.history.length; k += 2) {
      list.append(h('li', null, h('span', { class: 'mn', text: (k / 2 + 1) + '.' }), h('span', { text: g.history[k] }), h('span', { text: g.history[k + 1] || '' })));
    }
    list.scrollTop = list.scrollHeight;
  }

  function overText(v) {
    const g = v.game;
    const reason = t('chess.reason.' + g.reason);
    if (g.result === 'draw') return { title: t('over.draw'), sub: reason };
    const name = g.names[g.winner];
    if (g.winner === v.you) return { title: t('over.youWin'), sub: reason };
    return { title: t('over.wins', { name }), sub: reason };
  }

  function logText(e, v) {
    const g = v.game;
    const who = g.names[e.p] || '?';
    switch (e.t) {
      case 'move': return t('chess.log.move', { name: who, n: e.n, san: e.san });
      case 'resign': return t('log.resign', { name: who });
      case 'offer': return t('chess.log.offer', { name: who });
      case 'decline': return t('chess.log.decline', { name: who });
      case 'over':
        if (e.result === 'draw') return t('log.draw') + ' — ' + t('chess.reason.' + e.reason);
        return t('log.wins', { name: g.names[e.result === 'w' ? g.white : 1 - g.white] }) + ' — ' + t('chess.reason.' + e.reason);
    }
    return '';
  }

  window.GAMES.chess = {
    id: 'chess',
    icon: '♟︎',
    min: 2,
    max: 2,
    scoreKind: 'wins',
    defaultSettings: {},
    // Colours alternate between games; the first game is a coin toss.
    create: (names, settings, room) => C.newGame(names, { white: (room.gameNo + room.seed) % 2 }),
    apply: C.apply,
    view: C.viewFor,
    isOver: (st) => st.over,
    winner: (st) => (st.result && st.result !== 'draw' ? (st.result === 'w' ? st.white : 1 - st.white) : -1),
    loser: () => -1,
    botWants: (st, i) => C.botWants(C.viewFor(st, i)),
    botAction: (st, i) => C.botAction(C.viewFor(st, i)),
    rename(st, i, name) { if (i < 2) st.names[i] = name; },
    settings: () => h('p', { class: 'muted small', text: t('chess.note') }),
    mode: (v) => (v.game && v.you >= 0 ? t(v.game.color === 'w' ? 'chess.youWhite' : 'chess.youBlack') : ''),
    mount(stage) {
      stage.append(h('div', { class: 'board chess-board' },
        h('div', { class: 'chess-main' },
          h('div', { 'data-el': 'top' }),
          h('div', { class: 'cboard-wrap' },
            h('div', { class: 'cboard', 'data-el': 'board' }),
            h('div', { class: 'promo', 'data-el': 'promo', hidden: true })),
          h('div', { 'data-el': 'bottom' }),
          h('div', { class: 'me-bar' }, h('p', { class: 'status', 'data-el': 'status' }), h('div', { class: 'actions', 'data-el': 'actions' }))),
        h('ol', { class: 'cmoves', 'data-el': 'moves' })));
    },
    render,
    reset() { selected = -1; promo = null; },
    escape() { if (selected < 0 && !promo) return false; selected = -1; promo = null; return true; },
    overText,
    logText,
  };
})();
