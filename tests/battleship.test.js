// Battleship rules checks. Run with: node tests/battleship.test.js
'use strict';
const assert = require('assert');
const B = require('../battleship.js');

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

// A fixed legal fleet: ships along even rows, spaced apart.
const FLEET = [[0, 1, 2, 3], [5, 6, 7], [20, 21, 22], [24, 25], [27, 28], [40, 41], [43], [45], [47], [49]];

test('fleet validation', () => {
  assert(B.validFleet(FLEET));
  assert(!B.validFleet(FLEET.slice(1)), 'missing ship');
  const touching = FLEET.map((s) => s.slice());
  touching[1] = [4, 5, 6];
  assert(!B.validFleet(touching), 'ships touching');
  const diagonal = FLEET.map((s) => s.slice());
  diagonal[6] = [14];
  assert(!B.validFleet(diagonal), 'corner touch');
  const bent = FLEET.map((s) => s.slice());
  bent[0] = [0, 1, 2, 12];
  assert(!B.validFleet(bent), 'bent ship');
  const wrap = FLEET.map((s) => s.slice());
  wrap[0] = [60, 70, 80, 90];
  assert(B.validFleet(wrap), 'vertical ship');
  wrap[0] = [8, 9, 10, 11];
  assert(!B.straight(wrap[0]), 'wrapping row');
  for (let k = 1; k <= 50; k++) assert(B.validFleet(B.randomFleet(rng(k))));
});

test('setup, hits keep the turn, misses pass it, sinking marks around', () => {
  const st = B.newGame(['A', 'B'], { first: 0 });
  assert.strictEqual(B.apply(st, 0, { type: 'shoot', cell: 0 }), 'bad');
  assert.strictEqual(B.apply(st, 0, { type: 'place', ships: FLEET.slice(1) }), 'badFleet');
  assert.strictEqual(B.apply(st, 0, { type: 'place', ships: FLEET }), null);
  assert.strictEqual(st.phase, 'setup');
  assert.strictEqual(B.apply(st, 1, { type: 'place', ships: FLEET }), null);
  assert.strictEqual(st.phase, 'play');
  assert.strictEqual(st.turn, 0);
  assert.strictEqual(B.apply(st, 1, { type: 'shoot', cell: 0 }), 'notYourTurn');
  assert.strictEqual(B.apply(st, 0, { type: 'shoot', cell: 43 }), null); // single-decker: sunk
  assert.strictEqual(st.turn, 0);
  for (const n of B.neighbours(43)) assert.strictEqual(st.shots[0][n], B.MISS);
  assert.strictEqual(B.apply(st, 0, { type: 'shoot', cell: 42 }), 'alreadyShot');
  assert.strictEqual(B.apply(st, 0, { type: 'shoot', cell: 99 }), null); // miss
  assert.strictEqual(st.turn, 1);
  const v = B.viewFor(st, 1);
  assert.strictEqual(v.boards[1].ships.length, 10, 'own ships visible');
  assert.strictEqual(v.boards[0].ships.length, 0, 'enemy ships hidden');
  const v0 = B.viewFor(st, 0);
  assert.deepStrictEqual(v0.boards[1].ships, [[43]], 'sunk enemy ship visible');
});

test('sinking the whole fleet wins; spectators see no ships', () => {
  const st = B.newGame(['A', 'B'], { first: 1 });
  B.apply(st, 0, { type: 'place', ships: FLEET });
  B.apply(st, 1, { type: 'place', ships: B.randomFleet(rng(5)) });
  assert.strictEqual(B.viewFor(st, -1).boards[0].ships.length, 0);
  for (const s of FLEET) for (const x of s) {
    st.turn = 1;
    assert.strictEqual(B.apply(st, 1, { type: 'shoot', cell: x }), null);
  }
  assert(st.over);
  assert.strictEqual(st.winner, 1);
  assert.strictEqual(B.viewFor(st, -1).boards[1].ships.length, 10, 'revealed at the end');
});

test('bots always finish, and shoot each cell at most once', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const r = rng(seed);
    const st = B.newGame(['A', 'B'], { rng: r });
    let steps = 0;
    while (!st.over) {
      if (++steps > 400) throw new Error('bot game did not finish, seed ' + seed);
      let acted = false;
      for (const i of [0, 1]) {
        const v = B.viewFor(st, i);
        if (!B.botWants(v)) continue;
        const a = B.botAction(v, r);
        assert.strictEqual(B.apply(st, i, a), null, JSON.stringify(a));
        acted = true;
        break;
      }
      assert(acted, 'nobody to move');
    }
    assert(st.winner === 0 || st.winner === 1);
  }
});

console.log(process.exitCode ? 'battleship tests failed' : 'battleship: ' + passed + ' tests passed');
