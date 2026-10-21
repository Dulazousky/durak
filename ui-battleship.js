// Battleship: host-side adapter for the room, and the game screen.
(() => {
  'use strict';
  const B = window.BattleshipEngine;
  const { h } = window.UI;
  const t = (k, p) => window.I18N.t(k, p);

  const LETTERS = { ru: 'АБВГДЕЖЗИК', en: 'ABCDEFGHIJ' };
  const coord = (cell) => (LETTERS[window.I18N.lang] || LETTERS.en)[cell % B.SIZE] + (Math.floor(cell / B.SIZE) + 1);

  // Fleet being placed on this device before "Ready".
  let draft = { ships: [], size: 4, vertical: false, hover: -1 };
  let last = null;

  const remaining = () => {
    const left = B.FLEET.slice();
    for (const s of draft.ships) left.splice(left.indexOf(s.length), 1);
    return left;
  };

  function pickNextSize() {
    const left = remaining();
    if (!left.includes(draft.size)) draft.size = left.length ? Math.max(...left) : 0;
  }

  function clickSetupCell(cell) {
    const hit = draft.ships.findIndex((s) => s.includes(cell));
    if (hit >= 0) {
      // Pick a placed ship back up.
      draft.size = draft.ships[hit].length;
      draft.ships.splice(hit, 1);
    } else if (draft.size) {
      const cells = B.shipCells(cell, draft.size, draft.vertical);
      if (cells && B.fits(draft.ships, cells)) {
        draft.ships.push(cells);
        pickNextSize();
      }
    }
    last.ctx.rerender();
  }

  function preview() {
    if (draft.hover < 0 || !draft.size) return null;
    // Over a placed ship a click picks it up, so don't cover it with a preview.
    if (draft.ships.some((s) => s.includes(draft.hover))) return null;
    const cells = B.shipCells(draft.hover, draft.size, draft.vertical);
    if (!cells) return { cells: [draft.hover], ok: false };
    return { cells, ok: B.fits(draft.ships, cells) };
  }

  // One 10x10 sea. opts: {ships, shots, onCell, onHover, preview, lastShot, active}
  function sea(opts) {
    const shipAt = new Map();
    (opts.ships || []).forEach((s, k) => s.forEach((x) => shipAt.set(x, k)));
    const pv = opts.preview;
    const grid = h('div', { class: 'sea' + (opts.active ? ' active' : '') });
    const letters = LETTERS[window.I18N.lang] || LETTERS.en;
    grid.append(h('span', { class: 'lbl' }));
    for (let c = 0; c < B.SIZE; c++) grid.append(h('span', { class: 'lbl', text: letters[c] }));
    for (let r = 0; r < B.SIZE; r++) {
      grid.append(h('span', { class: 'lbl', text: String(r + 1) }));
      for (let c = 0; c < B.SIZE; c++) {
        const x = r * B.SIZE + c;
        const shot = opts.shots ? opts.shots[x] : 0;
        const cls = ['cell'];
        if (shipAt.has(x)) {
          cls.push('ship');
          const k = shipAt.get(x);
          const s = opts.ships[k];
          // Rounded ends, so each ship reads as one piece.
          if (!s.includes(x - 1) || x % B.SIZE === 0) cls.push('l');
          if (!s.includes(x + 1) || x % B.SIZE === B.SIZE - 1) cls.push('r');
          if (!s.includes(x - B.SIZE)) cls.push('t');
          if (!s.includes(x + B.SIZE)) cls.push('b');
          if (opts.sunk && opts.sunk.has(k)) cls.push('sunk');
        }
        if (shot === B.MISS) cls.push('miss');
        if (shot === B.HIT) cls.push('hit');
        if (pv && pv.cells.includes(x)) cls.push(pv.ok ? 'pv-ok' : 'pv-bad');
        if (opts.lastShot === x) cls.push('last');
        const clickable = opts.onCell && (opts.canClick ? opts.canClick(x) : true);
        if (clickable) cls.push('clickable');
        grid.append(h('button', {
          class: cls.join(' '),
          'aria-label': coord(x),
          tabindex: clickable ? '0' : '-1',
          onclick: clickable ? () => opts.onCell(x) : null,
          onpointerenter: opts.onHover ? () => opts.onHover(x) : null,
        }));
      }
    }
    if (opts.onHover) grid.addEventListener('pointerleave', () => opts.onHover(-1));
    return grid;
  }

  function sunkSet(board) {
    const out = new Set();
    board.ships.forEach((s, k) => { if (s.every((x) => board.shots[x] === B.HIT)) out.add(k); });
    return out;
  }

  function lastShotOn(g, k) {
    for (let j = g.log.length - 1; j >= 0; j--) {
      const e = g.log[j];
      if (e.c != null && (e.t === 'miss' || e.t === 'hit' || e.t === 'sunk')) return e.p === 1 - k ? e.c : -1;
    }
    return -1;
  }

  function fleetLeft(board) {
    return h('span', { class: 'afloat', text: t('bs.afloat', { n: board.afloat }) });
  }

  function renderSetup(root, v, ctx) {
    const g = v.game;
    const me = v.you;
    const ready = g.ready[me];
    if (ready && !draft.ships.length) draft.ships = g.boards[me].ships.map((s) => s.slice());
    pickNextSize();
    const left = remaining();
    const done = !left.length;

    const palette = h('div', { class: 'palette' });
    for (const size of [4, 3, 2, 1]) {
      const n = left.filter((x) => x === size).length;
      palette.append(h('button', {
        class: 'ship-pick' + (draft.size === size ? ' on' : ''),
        disabled: !n || ready,
        onclick: () => { draft.size = size; ctx.rerender(); },
        'aria-label': t('bs.shipOf', { n: size }),
      }, h('span', { class: 'ship-icon', style: '--len:' + size }), h('span', { text: '×' + n })));
    }

    root.append(
      h('div', { class: 'bs-setup' },
        h('div', { class: 'bs-col' },
          h('p', { class: 'bs-title', text: t('bs.yourFleet') }),
          sea({
            ships: draft.ships,
            preview: ready ? null : preview(),
            onCell: ready ? null : clickSetupCell,
            onHover: ready ? null : (x) => { if (draft.hover !== x) { draft.hover = x; ctx.rerender(); } },
          })),
        h('div', { class: 'bs-side' },
          h('p', { class: 'muted small', text: ready ? t('bs.waitOther') : t('bs.placeHelp') }),
          ready ? null : palette,
          ready ? null : h('div', { class: 'row left' },
            h('button', { class: 'btn', text: draft.vertical ? t('bs.vertical') : t('bs.horizontal'), onclick: () => { draft.vertical = !draft.vertical; ctx.rerender(); } }),
            h('button', { class: 'btn', text: t('bs.random'), onclick: () => { draft.ships = B.randomFleet(); pickNextSize(); ctx.rerender(); } }),
            h('button', { class: 'btn ghost', text: t('bs.clear'), onclick: () => { draft.ships = []; draft.size = 4; ctx.rerender(); } })),
          ready
            ? h('button', { class: 'btn big', text: t('bs.change'), onclick: () => ctx.act({ type: 'unready' }) })
            : h('button', { class: 'btn primary big', text: t('bs.ready'), disabled: !done, onclick: () => ctx.act({ type: 'place', ships: draft.ships }) }),
          h('p', { class: 'muted small', text: g.ready[1 - me] ? t('bs.otherReady', { name: g.names[1 - me] }) : t('bs.otherPlacing', { name: g.names[1 - me] }) }))));
  }

  function statusText(v) {
    const g = v.game;
    if (g.over) return t('status.over');
    if (v.you < 0) return g.phase === 'setup' ? t('bs.st.placing') : t('bs.st.shoots', { name: g.names[g.turn] });
    if (g.phase === 'setup') return g.ready[v.you] ? t('bs.waitOther') : t('bs.st.place');
    return g.turn === v.you ? t('bs.st.yourShot') : t('bs.st.shoots', { name: g.names[g.turn] });
  }

  function render(stage, v, ctx) {
    last = { v, ctx };
    const g = v.game;
    const me = v.you;
    const root = stage.querySelector('[data-el="root"]');
    root.replaceChildren();
    stage.querySelector('[data-el="status"]').textContent = statusText(v);
    const actions = stage.querySelector('[data-el="actions"]');
    actions.replaceChildren();

    if (g.phase === 'setup' && me >= 0) {
      renderSetup(root, v, ctx);
      return;
    }
    if (me >= 0 && !g.over && g.phase === 'play') {
      actions.append(h('button', { class: 'btn ghost', text: t('resign'), onclick: () => { if (confirm(t('resignConfirm'))) ctx.act({ type: 'resign' }); } }));
    }

    // Two seas: mine (or player 0 for spectators) and the enemy's.
    const order = me >= 0 ? [me, 1 - me] : [0, 1];
    const wrap = h('div', { class: 'bs-play' });
    for (const k of order) {
      const board = g.boards[k];
      const enemy = me >= 0 && k !== me;
      const myTurn = enemy && g.phase === 'play' && g.turn === me && !g.over;
      const seat = v.seats[k] || {};
      const title = me < 0 ? g.names[k] : (k === me ? t('bs.yourSea') : t('bs.enemySea', { name: g.names[k] }));
      wrap.append(h('div', { class: 'bs-col' + (k === me ? ' mine' : '') + (myTurn ? ' aim' : '') + (g.phase === 'play' && g.turn === 1 - k && !g.over ? ' under-fire' : '') },
        h('p', { class: 'bs-title' }, h('span', { text: (seat.bot ? '🤖 ' : '') + title }), fleetLeft(board), ctx.seatExtras(k)),
        sea({
          ships: board.ships,
          shots: board.shots,
          sunk: sunkSet(board),
          lastShot: lastShotOn(g, k),
          active: myTurn,
          onCell: myTurn ? (x) => ctx.act({ type: 'shoot', cell: x }) : null,
          canClick: (x) => !board.shots[x],
        })));
    }
    root.append(wrap);
  }

  function logText(e, v) {
    const g = v.game;
    const who = g.names[e.p] || '?';
    switch (e.t) {
      case 'ready': return t('bs.log.ready', { name: who });
      case 'start': return t('bs.log.start', { name: who });
      case 'miss': return t('bs.log.miss', { name: who, at: coord(e.c) });
      case 'hit': return t('bs.log.hit', { name: who, at: coord(e.c) });
      case 'sunk': return t('bs.log.sunk', { name: who, at: coord(e.c), n: e.n });
      case 'resign': return t('log.resign', { name: who });
      case 'over': return t('log.wins', { name: who });
    }
    return '';
  }

  window.GAMES.battleship = {
    id: 'battleship',
    icon: '🚢',
    min: 2,
    max: 2,
    scoreKind: 'wins',
    defaultSettings: {},
    create: (names) => B.newGame(names),
    apply: B.apply,
    view: B.viewFor,
    isOver: (st) => st.over,
    winner: (st) => st.winner,
    loser: () => -1,
    botWants: (st, i) => B.botWants(B.viewFor(st, i)),
    botAction: (st, i) => B.botAction(B.viewFor(st, i)),
    rename(st, i, name) { if (i < 2) st.names[i] = name; },
    settings: () => h('p', { class: 'muted small', text: t('bs.note') }),
    mode: () => '',
    mount(stage) {
      stage.append(h('div', { class: 'board bs-board' },
        h('div', { class: 'bs-root', 'data-el': 'root' }),
        h('div', { class: 'me-bar' }, h('p', { class: 'status', 'data-el': 'status' }), h('div', { class: 'actions', 'data-el': 'actions' }))));
    },
    render,
    reset() { draft = { ships: [], size: 4, vertical: false, hover: -1 }; },
    escape() { return false; },
    key(e) {
      if ((e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') && last && last.v.game.phase === 'setup') {
        draft.vertical = !draft.vertical;
        return true;
      }
      return false;
    },
    overText(v) {
      const g = v.game;
      if (g.winner === v.you) return { title: t('over.youWin'), sub: t('bs.over.winSub') };
      return { title: t('over.wins', { name: g.names[g.winner] }), sub: v.you >= 0 ? t('bs.over.loseSub') : '' };
    },
    logText,
  };
})();
