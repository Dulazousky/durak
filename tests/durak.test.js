// Rules checks for Durak. Run with: node tests/durak.test.js
'use strict';
const assert = require('assert');
const E = require('../engine.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error('FAIL ' + name + '\n  ' + (e && e.stack || e));
    process.exitCode = 1;
  }
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build a deck so that the given hands are dealt (round-robin from the top)
// and `rest` stays in the deck, rest[0] being the face-up trump.
function rigged(hands, rest) {
  const top = [];
  for (let r = 0; r < E.HAND; r++) for (const h of hands) top.push(h[r]);
  return rest.concat(top.reverse());
}

function totalCards(st) {
  let n = st.deck.length + st.discard;
  for (const p of st.players) n += p.hand.length;
  for (const x of st.table) n += x.d ? 2 : 1;
  return n;
}

test('beats', () => {
  assert(E.beats('7H', '6H', 'S'));
  assert(!E.beats('6H', '7H', 'S'));
  assert(E.beats('6S', '14H', 'S'));
  assert(!E.beats('14H', '6S', 'S'));
  assert(!E.beats('14C', '6H', 'S'));
  assert(E.beats('8S', '7S', 'S'));
});

test('deal and lowest trump attacks first', () => {
  const deck = rigged(
    [['14H', '13H', '12H', '11H', '10H', '9H'], ['7S', '14C', '13C', '12C', '11C', '10C']],
    ['6S', '6H', '7H', '8H', '6C', '7C', '8C', '9C', '6D', '7D']
  );
  const st = E.newGame(['A', 'B'], { deck });
  assert.strictEqual(st.trump, 'S');
  assert.deepStrictEqual(st.players[0].hand, ['14H', '13H', '12H', '11H', '10H', '9H']);
  assert.strictEqual(st.attacker, 1);
  assert.strictEqual(st.defender, 0);
  assert.strictEqual(st.deck.length, 10);
  assert.strictEqual(totalCards(st) + 36 - 22, 36);
});

test('six players: everything is dealt and trump is the last dealt card', () => {
  const st = E.newGame(['a', 'b', 'c', 'd', 'e', 'f'], { rng: rng(3) });
  assert.strictEqual(st.deck.length, 0);
  assert.strictEqual(E.suit(st.players[5].hand[5]), st.trump);
  assert.strictEqual(totalCards(st), 36);
});

function twoPlayer(opts) {
  const deck = rigged(
    [['6H', '6C', '7H', '8D', '9D', '14S'], ['7S', '6D', '10H', '11C', '12C', '13C']],
    ['8S', '9S', '10S', '11S', '12S', '13S', '6S', '14D', '13D', '12D']
  );
  return E.newGame(['A', 'B'], Object.assign({ deck }, opts));
}

test('attack, defend, throw-in by rank, bito, refill order', () => {
  const st = E.newGame(['A', 'B'], {
    deck: rigged(
      [['6H', '6C', '7H', '8D', '9D', '14D'], ['7D', '6D', '10H', '11C', '12C', '13C']],
      ['8S', '9S', '10S', '11S', '12S', '13S', '6S', '7S', '13D', '12D']
    ),
  });
  // Trump spades, no one holds one: seat 0 starts.
  assert.strictEqual(st.attacker, 0);
  assert.strictEqual(E.apply(st, 1, { type: 'attack', card: '7D' }), 'Эту карту сейчас нельзя положить');
  assert.strictEqual(E.apply(st, 0, { type: 'attack', card: '6H' }), null);
  assert.ok(E.apply(st, 1, { type: 'defend', target: 0, card: '6D' }));
  assert.strictEqual(E.apply(st, 1, { type: 'defend', target: 0, card: '10H' }), null);
  // 6 and 10 are on the table: 6C may be thrown, 8D may not.
  const m = E.legalMoves(st, 0);
  assert.deepStrictEqual(m.attack.sort(), ['6C']);
  assert(m.pass);
  assert.strictEqual(E.apply(st, 0, { type: 'pass' }), null);
  // Bout over: attacker draws first.
  assert.strictEqual(st.discard, 2);
  assert.strictEqual(st.attacker, 1);
  assert.strictEqual(st.defender, 0);
  assert.strictEqual(st.players[0].hand.length, 6);
  assert.strictEqual(st.players[1].hand.length, 6);
  assert(st.players[0].hand.includes('12D'));
  assert(st.players[1].hand.includes('13D'));
  assert.strictEqual(totalCards(st), 22);
});

test('taking: throw-ins until passes, defender picks up and loses the turn', () => {
  const st = twoPlayer();
  assert.strictEqual(st.attacker, 1); // 7S lowest trump
  E.apply(st, 1, { type: 'attack', card: '6D' });
  assert.strictEqual(E.apply(st, 0, { type: 'take' }), null);
  assert.deepStrictEqual(E.legalMoves(st, 0), { attack: [], defend: {}, transfer: [], take: false, pass: false });
  // B has no other 6, so B counts as passed and the bout ends at once.
  assert.strictEqual(st.table.length, 0);
  assert.strictEqual(st.players[0].hand.length, 7);
  assert.strictEqual(st.attacker, 1);
  assert.strictEqual(st.defender, 0);
  assert.strictEqual(totalCards(st), 22);
});

test('no more cards than the defender holds', () => {
  const st = E.newGame(['A', 'B'], {
    deck: rigged(
      [['6H', '6C', '6D', '7H', '7C', '7D'], ['8S', '9S', '10S', '11S', '12S', '13S']],
      ['14S']
    ),
  });
  // Seat 1 has the lowest trump (8S) and attacks; seat 0 defends with 6 cards.
  assert.strictEqual(st.limit, 6);
  st.players[0].hand = ['6S'];
  st.limit = 1;
  E.apply(st, 1, { type: 'attack', card: '8S' });
  assert.deepStrictEqual(E.legalMoves(st, 1).attack, []);
});

test('transfer passes the attack on and the transferer becomes attacker', () => {
  const deck = rigged(
    [['6H', '9C', '9D', '10D', '11D', '12D'], ['6C', '7C', '8C', '9H', '10C', '11C'], ['6D', '7D', '8D', '13C', '14C', '13H']],
    ['7S', '8S', '9S', '10S', '11S', '12S', '13S', '14S', '6S', '14H', '14D', '7H', '8H', '10H', '11H', '12H', '13D', '12C']
  );
  const st = E.newGame(['A', 'B', 'C'], { deck, transfer: true });
  assert.strictEqual(st.attacker, 0); // no trumps dealt
  E.apply(st, 0, { type: 'attack', card: '6H' });
  const m = E.legalMoves(st, 1);
  assert.deepStrictEqual(m.transfer, ['6C']);
  assert.strictEqual(E.apply(st, 1, { type: 'transfer', card: '6C' }), null);
  assert.strictEqual(st.attacker, 1);
  assert.strictEqual(st.defender, 2);
  assert.strictEqual(st.table.length, 2);
  // C can transfer back to A, who has 5 cards, because 3 <= 5.
  assert.deepStrictEqual(E.legalMoves(st, 2).transfer, ['6D']);
  E.apply(st, 2, { type: 'defend', target: 0, card: '13H' });
  assert.deepStrictEqual(E.legalMoves(st, 2).transfer, []);
});

test('transfer is off unless enabled', () => {
  const st = twoPlayer();
  E.apply(st, 1, { type: 'attack', card: '6D' });
  assert.deepStrictEqual(E.legalMoves(st, 0).transfer, []);
});

test('view hides other hands', () => {
  const st = E.newGame(['A', 'B', 'C'], { rng: rng(9) });
  const v = E.viewFor(st, 1);
  assert.deepStrictEqual(v.hand, st.players[1].hand);
  const json = JSON.stringify(v);
  for (const c of st.players[0].hand) assert(!json.includes('"' + c + '"') || v.hand.includes(c) || c === v.trumpCard);
  assert.strictEqual(E.viewFor(st, -1).hand.length, 0);
});

// Play many full games with random and bot players, checking invariants on
// every step: cards are conserved, someone can always move, games end.
function playOut(seed, n, transfer, botRate) {
  const r = rng(seed);
  const names = Array.from({ length: n }, (_, i) => 'P' + i);
  const st = E.newGame(names, { rng: r, transfer });
  let steps = 0;
  while (!st.over) {
    if (++steps > 5000) throw new Error('game did not finish, seed ' + seed);
    const options = [];
    for (let i = 0; i < n; i++) {
      const v = E.viewFor(st, i);
      const m = v.moves;
      const acts = [];
      if (r() < botRate) {
        const b = E.botAction(v);
        if (b) acts.push(b);
      } else {
        for (const c of m.attack) acts.push({ type: 'attack', card: c });
        for (const c in m.defend) for (const t of m.defend[c]) acts.push({ type: 'defend', card: c, target: t });
        for (const c of m.transfer) acts.push({ type: 'transfer', card: c });
        if (m.take) acts.push({ type: 'take' });
        if (m.pass) acts.push({ type: 'pass' });
      }
      for (const a of acts) options.push([i, a]);
    }
    if (!options.length) {
      // Bots may decline every move; fall back to anything legal.
      for (let i = 0; i < n; i++) {
        const m = E.legalMoves(st, i);
        if (m.take) options.push([i, { type: 'take' }]);
        if (m.pass) options.push([i, { type: 'pass' }]);
        for (const c of m.attack) options.push([i, { type: 'attack', card: c }]);
      }
    }
    if (!options.length) throw new Error('nobody can move, seed ' + seed + ' ' + JSON.stringify(st));
    const [i, a] = options[Math.floor(r() * options.length)];
    const err = E.apply(st, i, a);
    if (err) throw new Error('legal move rejected: ' + err + ' ' + JSON.stringify(a));
    if (totalCards(st) !== 36) throw new Error('card count ' + totalCards(st) + ', seed ' + seed);
    if (!st.over) {
      if (st.players[st.attacker].out || st.players[st.defender].out) throw new Error('out player in bout');
      if (st.attacker === st.defender) throw new Error('attacker is defender');
      const undefended = st.table.filter((x) => !x.d).length;
      if (undefended > st.players[st.defender].hand.length && !st.taking) throw new Error('too many cards on defender');
      if (st.table.length > E.MAX_TABLE) throw new Error('table overflow');
    }
  }
  const left = st.players.filter((p) => !p.out).length;
  assert(left <= 1);
  assert.strictEqual(st.finished.length, n - left);
  return st;
}

test('random and bot games finish cleanly', () => {
  let durak = 0;
  let draws = 0;
  for (let seed = 1; seed <= 600; seed++) {
    const n = 2 + (seed % 5);
    const st = playOut(seed, n, seed % 2 === 0, (seed % 3) / 2);
    if (st.durak >= 0) durak++; else draws++;
  }
  assert(durak > 0);
  assert(draws >= 0);
});

test('bots alone always finish', () => {
  for (let seed = 1; seed <= 200; seed++) playOut(seed * 7, 2 + (seed % 5), seed % 3 === 0, 1);
});

console.log(process.exitCode ? 'durak tests failed' : 'durak: ' + passed + ' tests passed');
