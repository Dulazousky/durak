// Durak rules engine and bot. No DOM, no network: the host runs it, and the
// tests run it under Node. Cards are strings like "10H": rank 6..14, suit S/C/D/H.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DurakEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SUITS = ['S', 'C', 'D', 'H'];
  const RANKS = [6, 7, 8, 9, 10, 11, 12, 13, 14];
  const HAND = 6;
  const MAX_TABLE = 6;
  const MAX_PLAYERS = 6;

  const rank = (c) => parseInt(c, 10);
  const suit = (c) => c[c.length - 1];

  function makeDeck() {
    const deck = [];
    for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
    return deck;
  }

  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Does `def` beat `att`? Higher card of the same suit, or any trump on a non-trump.
  function beats(def, att, trump) {
    if (suit(def) === suit(att)) return rank(def) > rank(att);
    return suit(def) === trump && suit(att) !== trump;
  }

  // Next player after i who is still in the game, or -1.
  function nextActive(st, i) {
    const n = st.players.length;
    for (let k = 1; k < n; k++) {
      const j = (i + k) % n;
      if (!st.players[j].out) return j;
    }
    return -1;
  }

  function log(st, entry) {
    entry.at = Date.now();
    st.log.push(entry);
    if (st.log.length > 60) st.log.shift();
  }

  function startBout(st) {
    st.table = [];
    st.taking = false;
    st.passed = st.players.map(() => false);
    st.limit = Math.min(MAX_TABLE, st.players[st.defender].hand.length);
  }

  // names: player names in seat order. opts: {transfer, rng, deck}
  function newGame(names, opts) {
    opts = opts || {};
    if (names.length < 2 || names.length > MAX_PLAYERS) throw new Error('2-6 players');
    const deck = opts.deck ? opts.deck.slice() : shuffle(makeDeck(), opts.rng || Math.random);
    const players = names.map((name) => ({ name, hand: [], out: false }));
    for (let r = 0; r < HAND; r++) for (const p of players) p.hand.push(deck.pop());
    // The bottom card of the deck is shown face up and sets trumps. With six
    // players nothing is left over, so the last card dealt plays that role.
    const trumpCard = deck.length ? deck[0] : players[players.length - 1].hand[HAND - 1];
    const trump = suit(trumpCard);

    // Whoever holds the lowest trump attacks first.
    let first = 0;
    let low = 99;
    players.forEach((p, i) => p.hand.forEach((c) => {
      if (suit(c) === trump && rank(c) < low) { low = rank(c); first = i; }
    }));

    const st = {
      players, deck, trumpCard, trump,
      discard: 0,
      table: [],
      attacker: first,
      defender: -1,
      taking: false,
      passed: [],
      limit: 0,
      transfer: !!opts.transfer,
      over: false,
      durak: -1,
      finished: [],
      log: [],
    };
    st.defender = nextActive(st, first);
    startBout(st);
    log(st, { t: 'start', p: first, c: low < 99 ? low + trump : null });
    return st;
  }

  function tableRanks(st) {
    const set = new Set();
    for (const x of st.table) {
      set.add(rank(x.a));
      if (x.d) set.add(rank(x.d));
    }
    return set;
  }

  // Everything player i may do right now.
  function legalMoves(st, i) {
    const m = { attack: [], defend: {}, transfer: [], take: false, pass: false };
    if (st.over || i < 0 || i >= st.players.length) return m;
    const p = st.players[i];
    if (p.out) return m;

    if (i === st.defender) {
      const open = [];
      st.table.forEach((x, k) => { if (!x.d) open.push(k); });
      if (st.taking || !open.length) return m;
      m.take = true;
      for (const c of p.hand) {
        const targets = open.filter((k) => beats(c, st.table[k].a, st.trump));
        if (targets.length) m.defend[c] = targets;
      }
      // Transfer ("перевод"): nothing beaten yet, add a card of the same rank
      // and the next player has to defend against the lot.
      if (st.transfer && st.table.every((x) => !x.d)) {
        const next = nextActive(st, i);
        const n = st.table.length + 1;
        if (next !== -1 && n <= MAX_TABLE && st.players[next].hand.length >= n) {
          const r = rank(st.table[0].a);
          m.transfer = p.hand.filter((c) => rank(c) === r);
        }
      }
      return m;
    }

    if (!st.table.length) {
      if (i === st.attacker) m.attack = p.hand.slice();
      return m;
    }
    if (st.table.length < st.limit) {
      const ranks = tableRanks(st);
      m.attack = p.hand.filter((c) => ranks.has(rank(c)));
    }
    m.pass = (st.taking || st.table.every((x) => x.d)) && !st.passed[i];
    return m;
  }

  function resetPasses(st) {
    st.passed = st.players.map(() => false);
  }

  function remove(hand, card) {
    hand.splice(hand.indexOf(card), 1);
  }

  // Apply player i's action. Returns an error message, or null on success.
  function apply(st, i, a) {
    if (st.over) return 'Игра окончена';
    if (!a || typeof a.type !== 'string') return 'Непонятный ход';
    const m = legalMoves(st, i);
    const p = st.players[i];
    switch (a.type) {
      case 'attack':
        if (!m.attack.includes(a.card)) return 'Эту карту сейчас нельзя положить';
        remove(p.hand, a.card);
        st.table.push({ a: a.card, d: null, by: i });
        if (!st.taking) resetPasses(st);
        log(st, { t: st.table.length === 1 ? 'attack' : 'throw', p: i, c: a.card });
        break;
      case 'defend': {
        const targets = m.defend[a.card];
        if (!targets || !targets.includes(a.target)) return 'Этой картой не побить';
        remove(p.hand, a.card);
        st.table[a.target].d = a.card;
        resetPasses(st);
        log(st, { t: 'defend', p: i, c: a.card, on: st.table[a.target].a });
        break;
      }
      case 'transfer':
        if (!m.transfer.includes(a.card)) return 'Перевести нельзя';
        remove(p.hand, a.card);
        st.table.push({ a: a.card, d: null, by: i });
        st.attacker = i;
        st.defender = nextActive(st, i);
        st.limit = Math.min(MAX_TABLE, st.players[st.defender].hand.length);
        resetPasses(st);
        log(st, { t: 'transfer', p: i, c: a.card, to: st.defender });
        break;
      case 'take':
        if (!m.take) return 'Сейчас нечего брать';
        st.taking = true;
        resetPasses(st);
        log(st, { t: 'take', p: i });
        break;
      case 'pass':
        if (!m.pass) return 'Сейчас нельзя пасовать';
        st.passed[i] = true;
        break;
      default:
        return 'Непонятный ход';
    }
    maybeEndBout(st);
    return null;
  }

  // A player who can't add anything counts as having passed, so nobody has to
  // click "pass" with nothing to throw.
  function done(st, i) {
    if (i === st.defender || st.players[i].out || st.passed[i]) return true;
    return legalMoves(st, i).attack.length === 0;
  }

  function maybeEndBout(st) {
    if (!st.table.length) return;
    if (!st.taking && !st.table.every((x) => x.d)) return;
    const full = st.table.length >= st.limit;
    if (full || st.players.every((_, i) => done(st, i))) endBout(st);
  }

  function endBout(st) {
    const n = st.players.length;
    const d = st.defender;
    const cards = [];
    for (const x of st.table) { cards.push(x.a); if (x.d) cards.push(x.d); }
    if (st.taking) {
      st.players[d].hand.push(...cards);
      log(st, { t: 'took', p: d, n: cards.length });
    } else {
      st.discard += cards.length;
      log(st, { t: 'bito', p: d, n: cards.length });
    }
    st.table = [];

    // Refill to six: the main attacker first, then the others in turn, the
    // defender last.
    const order = [st.attacker];
    for (let k = 1; k < n; k++) {
      const j = (st.attacker + k) % n;
      if (j !== d) order.push(j);
    }
    order.push(d);
    for (const j of order) {
      const h = st.players[j].hand;
      if (st.players[j].out) continue;
      while (h.length < HAND && st.deck.length) h.push(st.deck.pop());
    }

    st.players.forEach((p, j) => {
      if (!p.out && !st.deck.length && !p.hand.length) {
        p.out = true;
        st.finished.push(j);
        log(st, { t: 'out', p: j });
      }
    });

    const left = [];
    st.players.forEach((p, j) => { if (!p.out) left.push(j); });
    if (left.length <= 1) {
      st.over = true;
      st.durak = left.length ? left[0] : -1;
      st.taking = false;
      log(st, { t: 'over', p: st.durak });
      return;
    }

    let next;
    if (st.taking || st.players[d].out) next = nextActive(st, d);
    else next = d;
    st.attacker = next;
    st.defender = nextActive(st, next);
    startBout(st);
  }

  // What player i is allowed to see (i = -1 for spectators).
  function viewFor(st, i) {
    const me = i >= 0 && i < st.players.length ? i : -1;
    return {
      you: me,
      hand: me >= 0 ? st.players[me].hand.slice() : [],
      players: st.players.map((p, k) => ({
        name: p.name,
        count: p.hand.length,
        out: p.out,
        passed: !!st.passed[k],
      })),
      table: st.table.map((x) => ({ a: x.a, d: x.d, by: x.by })),
      deckCount: st.deck.length,
      trumpCard: st.deck.length ? st.trumpCard : null,
      trump: st.trump,
      discard: st.discard,
      attacker: st.attacker,
      defender: st.defender,
      taking: st.taking,
      limit: st.limit,
      transfer: st.transfer,
      over: st.over,
      durak: st.durak,
      finished: st.finished.slice(),
      log: st.log.slice(-30),
      moves: legalMoves(st, me),
    };
  }

  // ---- Bot -------------------------------------------------------------
  // Decides from a player's view only, so it never peeks at other hands.

  function cost(c, trump) {
    return rank(c) + (suit(c) === trump ? 100 : 0);
  }

  function cheapest(cards, trump) {
    return cards.slice().sort((a, b) => cost(a, trump) - cost(b, trump))[0];
  }

  function botAction(v) {
    const m = v.moves;
    const tr = v.trump;
    if (!m) return null;

    if (v.you === v.defender) {
      if (!m.take) return null;
      if (m.transfer.length) {
        const c = cheapest(m.transfer, tr);
        if (suit(c) !== tr || v.deckCount === 0) return { type: 'transfer', card: c };
      }
      // Plan the whole defence greedily, the strongest attack card first; if
      // any card can't be covered, take.
      const open = [];
      v.table.forEach((x, k) => { if (!x.d) open.push(k); });
      open.sort((a, b) => cost(v.table[b].a, tr) - cost(v.table[a].a, tr));
      const used = new Set();
      const plan = [];
      for (const k of open) {
        const options = v.hand.filter((c) => !used.has(c) && beats(c, v.table[k].a, tr));
        if (!options.length) return { type: 'take' };
        const c = cheapest(options, tr);
        used.add(c);
        plan.push({ k, c });
      }
      // Early in the game, don't burn high trumps to cover a single card.
      const spendsBig = plan.some((x) => cost(x.c, tr) >= 113);
      if (spendsBig && v.deckCount > 12 && v.table.length === 1) return { type: 'take' };
      return { type: 'defend', target: plan[0].k, card: plan[0].c };
    }

    if (!v.table.length) {
      return m.attack.length ? { type: 'attack', card: cheapest(m.attack, tr) } : null;
    }
    if (m.attack.length) {
      const c = cheapest(m.attack, tr);
      const endgame = v.deckCount === 0;
      if (endgame || (suit(c) !== tr && (v.taking || rank(c) <= 11))) return { type: 'attack', card: c };
    }
    if (m.pass) return { type: 'pass' };
    return null;
  }

  return {
    SUITS, RANKS, HAND, MAX_TABLE, MAX_PLAYERS,
    rank, suit, makeDeck, shuffle, beats, nextActive,
    newGame, legalMoves, apply, viewFor, botAction,
  };
});
