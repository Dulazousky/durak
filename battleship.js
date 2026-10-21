// Battleship rules engine and bot. No DOM, no network: the host runs it, and
// the tests run it under Node. The board is 10x10, cell = row * 10 + col.
// Classic fleet: one 4-decker, two 3s, three 2s, four 1s; ships may not touch,
// not even at the corners. A hit or a sinking earns another shot.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BattleshipEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIZE = 10;
  const CELLS = SIZE * SIZE;
  const FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
  const MISS = 1;
  const HIT = 2;

  function neighbours(cell) {
    const r = Math.floor(cell / SIZE);
    const c = cell % SIZE;
    const out = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const y = r + dr;
        const x = c + dc;
        if (y >= 0 && y < SIZE && x >= 0 && x < SIZE) out.push(y * SIZE + x);
      }
    }
    return out;
  }

  // A ship is a straight, gapless run of cells.
  function straight(cells) {
    if (!cells.length) return false;
    const s = cells.slice().sort((a, b) => a - b);
    if (s.some((x) => !Number.isInteger(x) || x < 0 || x >= CELLS)) return false;
    if (s.length === 1) return true;
    const row = (x) => Math.floor(x / SIZE);
    if (s.every((x) => row(x) === row(s[0]))) return s.every((x, k) => !k || x === s[k - 1] + 1);
    return s.every((x, k) => !k || x === s[k - 1] + SIZE);
  }

  // Can `cells` join the ships already placed?
  function fits(ships, cells) {
    if (!straight(cells)) return false;
    const taken = new Set();
    for (const ship of ships) for (const x of ship) { taken.add(x); for (const n of neighbours(x)) taken.add(n); }
    return cells.every((x) => !taken.has(x));
  }

  function validFleet(ships) {
    if (!Array.isArray(ships) || ships.length !== FLEET.length) return false;
    const sizes = ships.map((s) => (Array.isArray(s) ? s.length : 0)).sort((a, b) => b - a);
    if (sizes.some((n, k) => n !== FLEET[k])) return false;
    const placed = [];
    for (const ship of ships) {
      if (!fits(placed, ship)) return false;
      placed.push(ship);
    }
    return true;
  }

  function shipCells(start, size, vertical) {
    const r = Math.floor(start / SIZE);
    const c = start % SIZE;
    if (vertical ? r + size > SIZE : c + size > SIZE) return null;
    const cells = [];
    for (let k = 0; k < size; k++) cells.push(start + k * (vertical ? SIZE : 1));
    return cells;
  }

  function randomFleet(rng) {
    rng = rng || Math.random;
    for (;;) {
      const ships = [];
      let ok = true;
      for (const size of FLEET) {
        let placed = false;
        for (let tries = 0; tries < 200 && !placed; tries++) {
          const cells = shipCells(Math.floor(rng() * CELLS), size, rng() < 0.5);
          if (cells && fits(ships, cells)) { ships.push(cells); placed = true; }
        }
        if (!placed) { ok = false; break; }
      }
      if (ok) return ships;
    }
  }

  function log(st, entry) {
    entry.at = Date.now();
    st.log.push(entry);
    if (st.log.length > 80) st.log.shift();
  }

  // names: two player names. opts: {first, rng}
  function newGame(names, opts) {
    opts = opts || {};
    const rng = opts.rng || Math.random;
    return {
      names: names.slice(0, 2),
      phase: 'setup', // setup | play | over
      ships: [null, null],
      ready: [false, false],
      shots: [new Array(CELLS).fill(0), new Array(CELLS).fill(0)], // shots[i]: what player i fired at the other
      first: opts.first != null ? opts.first : (rng() < 0.5 ? 0 : 1),
      turn: -1,
      over: false,
      winner: -1,
      log: [],
    };
  }

  const isSunk = (ship, shots) => ship.every((x) => shots[x] === HIT);

  function apply(st, i, a) {
    if (st.over) return 'over';
    if (i !== 0 && i !== 1) return 'bad';
    if (!a || typeof a.type !== 'string') return 'bad';
    switch (a.type) {
      case 'place': {
        if (st.phase !== 'setup') return 'bad';
        if (!validFleet(a.ships)) return 'badFleet';
        st.ships[i] = a.ships.map((s) => s.slice());
        st.ready[i] = true;
        log(st, { t: 'ready', p: i });
        if (st.ready[0] && st.ready[1]) {
          st.phase = 'play';
          st.turn = st.first;
          log(st, { t: 'start', p: st.turn });
        }
        return null;
      }
      case 'unready':
        if (st.phase !== 'setup' || !st.ready[i]) return 'bad';
        st.ready[i] = false;
        return null;
      case 'shoot': {
        if (st.phase !== 'play') return 'bad';
        if (st.turn !== i) return 'notYourTurn';
        const cell = a.cell;
        if (!Number.isInteger(cell) || cell < 0 || cell >= CELLS) return 'bad';
        const shots = st.shots[i];
        if (shots[cell]) return 'alreadyShot';
        const target = 1 - i;
        const ship = st.ships[target].find((s) => s.includes(cell));
        if (!ship) {
          shots[cell] = MISS;
          st.turn = target;
          log(st, { t: 'miss', p: i, c: cell });
          return null;
        }
        shots[cell] = HIT;
        if (isSunk(ship, shots)) {
          // Nothing can be next to a sunk ship, so mark its surroundings.
          for (const x of ship) for (const n of neighbours(x)) if (!shots[n]) shots[n] = MISS;
          log(st, { t: 'sunk', p: i, c: cell, n: ship.length });
          if (st.ships[target].every((s) => isSunk(s, shots))) {
            st.over = true;
            st.phase = 'over';
            st.winner = i;
            log(st, { t: 'over', p: i });
          }
        } else {
          log(st, { t: 'hit', p: i, c: cell });
        }
        return null;
      }
      case 'resign':
        if (st.phase === 'setup') return 'bad';
        st.over = true;
        st.phase = 'over';
        st.winner = 1 - i;
        log(st, { t: 'resign', p: i });
        return null;
    }
    return 'bad';
  }

  // What player i may see (-1 for spectators). boards[k] is player k's sea:
  // the shots fired at it and the ships on it that this viewer may see.
  function viewFor(st, i) {
    const me = i === 0 || i === 1 ? i : -1;
    const boards = [0, 1].map((k) => {
      const shots = st.shots[1 - k].slice();
      const ships = st.ships[k] || [];
      const visible = k === me || st.over ? ships : ships.filter((s) => isSunk(s, shots));
      return {
        shots,
        ships: visible.map((s) => s.slice()),
        sunk: ships.filter((s) => isSunk(s, shots)).length,
        afloat: ships.length ? ships.length - ships.filter((s) => isSunk(s, shots)).length : FLEET.length,
      };
    });
    return {
      you: me,
      names: st.names,
      phase: st.phase,
      ready: st.ready.slice(),
      turn: st.turn,
      over: st.over,
      winner: st.winner,
      boards,
      log: st.log.slice(-40),
    };
  }

  // ---- bot ----------------------------------------------------------------

  function botAction(v, rng) {
    rng = rng || Math.random;
    const me = v.you;
    if (me < 0 || v.over) return null;
    if (v.phase === 'setup') return v.ready[me] ? null : { type: 'place', ships: randomFleet(rng) };
    if (v.phase !== 'play' || v.turn !== me) return null;
    const sea = v.boards[1 - me];
    const shots = sea.shots;
    const sunkCells = new Set();
    for (const s of sea.ships) for (const x of s) sunkCells.add(x);
    const open = (x) => x >= 0 && x < CELLS && !shots[x];
    const pick = (list) => list[Math.floor(rng() * list.length)];

    // Finish off a wounded ship: extend along its line if two hits are known.
    const wounded = [];
    for (let x = 0; x < CELLS; x++) if (shots[x] === HIT && !sunkCells.has(x)) wounded.push(x);
    if (wounded.length) {
      const sameRow = wounded.length > 1 && wounded.every((x) => Math.floor(x / SIZE) === Math.floor(wounded[0] / SIZE));
      const sameCol = wounded.length > 1 && wounded.every((x) => x % SIZE === wounded[0] % SIZE);
      let cand = [];
      if (sameRow) {
        const lo = Math.min(...wounded);
        const hi = Math.max(...wounded);
        if (lo % SIZE > 0) cand.push(lo - 1);
        if (hi % SIZE < SIZE - 1) cand.push(hi + 1);
      } else if (sameCol) {
        const lo = Math.min(...wounded);
        const hi = Math.max(...wounded);
        cand.push(lo - SIZE, hi + SIZE);
      } else {
        for (const x of wounded) {
          if (x % SIZE > 0) cand.push(x - 1);
          if (x % SIZE < SIZE - 1) cand.push(x + 1);
          cand.push(x - SIZE, x + SIZE);
        }
      }
      cand = cand.filter(open);
      if (cand.length) return { type: 'shoot', cell: pick(cand) };
    }
    // Otherwise hunt on a checkerboard: every ship of 2+ covers a dark square.
    const all = [];
    const dark = [];
    for (let x = 0; x < CELLS; x++) {
      if (!open(x)) continue;
      all.push(x);
      if ((Math.floor(x / SIZE) + x) % 2 === 0) dark.push(x);
    }
    return { type: 'shoot', cell: pick(dark.length ? dark : all) };
  }

  function botWants(v) {
    if (v.over || v.you < 0) return false;
    if (v.phase === 'setup') return !v.ready[v.you];
    return v.phase === 'play' && v.turn === v.you;
  }

  return {
    SIZE, CELLS, FLEET, MISS, HIT,
    neighbours, straight, fits, validFleet, shipCells, randomFleet,
    newGame, apply, viewFor, botAction, botWants,
  };
});
