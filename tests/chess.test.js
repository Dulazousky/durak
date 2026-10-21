// Chess rules checks. Run with: node tests/chess.test.js
'use strict';
const assert = require('assert');
const C = require('../chess.js');

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

const sq = (n) => C.FILES.indexOf(n[0]) + (Number(n[1]) - 1) * 8;
const mv = (st, i, from, to, promo) => C.apply(st, i, { type: 'move', from: sq(from), to: sq(to), promo });

// Perft counts from https://www.chessprogramming.org/Perft_Results
test('perft: start position', () => {
  const p = C.initialPosition();
  assert.strictEqual(C.perft(p, 1), 20);
  assert.strictEqual(C.perft(p, 2), 400);
  assert.strictEqual(C.perft(p, 3), 8902);
});
test('perft: kiwipete (castling, pins, en passant)', () => {
  const p = C.fromFEN('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  assert.strictEqual(C.perft(p, 1), 48);
  assert.strictEqual(C.perft(p, 2), 2039);
  assert.strictEqual(C.perft(p, 3), 97862);
});
test('perft: position 3 (en passant edge cases)', () => {
  const p = C.fromFEN('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1');
  assert.strictEqual(C.perft(p, 1), 14);
  assert.strictEqual(C.perft(p, 2), 191);
  assert.strictEqual(C.perft(p, 3), 2812);
  assert.strictEqual(C.perft(p, 4), 43238);
});
test('perft: position 4 (promotions)', () => {
  const p = C.fromFEN('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1');
  assert.strictEqual(C.perft(p, 1), 6);
  assert.strictEqual(C.perft(p, 2), 264);
  assert.strictEqual(C.perft(p, 3), 9467);
});
test('perft: position 5', () => {
  const p = C.fromFEN('rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8');
  assert.strictEqual(C.perft(p, 1), 44);
  assert.strictEqual(C.perft(p, 2), 1486);
  assert.strictEqual(C.perft(p, 3), 62379);
});

test("fool's mate, turn order and SAN", () => {
  const st = C.newGame(['A', 'B'], { white: 1 });
  assert.strictEqual(mv(st, 0, 'e2', 'e4'), 'notYourTurn');
  assert.strictEqual(mv(st, 1, 'f2', 'f3'), null);
  assert.strictEqual(mv(st, 0, 'e7', 'e5'), null);
  assert.strictEqual(mv(st, 1, 'g2', 'g5'), 'illegal');
  assert.strictEqual(mv(st, 1, 'g2', 'g4'), null);
  assert.strictEqual(mv(st, 0, 'd8', 'h4'), null);
  assert.deepStrictEqual(st.history, ['f3', 'e5', 'g4', 'Qh4#']);
  assert(st.over);
  assert.strictEqual(st.result, 'b');
  assert.strictEqual(st.reason, 'mate');
  assert.strictEqual(C.viewFor(st, 0).winner, 0);
});

test('promotion defaults to a queen, underpromotion works', () => {
  const st = C.newGame(['A', 'B'], { fen: '8/P6k/8/8/8/8/8/K7 w - - 0 1' });
  const st2 = C.newGame(['A', 'B'], { fen: '8/P6k/8/8/8/8/8/K7 w - - 0 1' });
  assert.strictEqual(mv(st, 0, 'a7', 'a8'), null);
  assert.strictEqual(st.pos.board[sq('a8')], 'Q');
  assert.strictEqual(mv(st2, 0, 'a7', 'a8', 'n'), null);
  assert.strictEqual(st2.pos.board[sq('a8')], 'N');
  assert.strictEqual(st2.history[0], 'a8=N');
});

test('castling rights and SAN', () => {
  const st = C.newGame(['A', 'B'], { fen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1' });
  assert.strictEqual(mv(st, 0, 'e1', 'g1'), null);
  assert.strictEqual(st.pos.board[sq('f1')], 'R');
  assert.strictEqual(mv(st, 1, 'e8', 'c8'), null);
  assert.strictEqual(st.pos.board[sq('d8')], 'r');
  assert.deepStrictEqual(st.history, ['O-O', 'O-O-O']);
  assert.strictEqual(st.pos.castling, '');
});

test('stalemate, insufficient material, draw offers, resign', () => {
  const st = C.newGame(['A', 'B'], { fen: 'k7/8/1Q6/8/8/8/8/7K w - - 0 1' });
  mv(st, 0, 'b6', 'c7');
  assert(st.over && st.result === 'draw' && st.reason === 'stalemate');

  const st2 = C.newGame(['A', 'B'], { fen: 'k7/8/8/8/8/8/1q6/K7 w - - 0 1' });
  mv(st2, 0, 'a1', 'b2');
  assert(st2.over && st2.reason === 'material');

  const st3 = C.newGame(['A', 'B']);
  assert.strictEqual(C.apply(st3, 0, { type: 'offerDraw' }), null);
  mv(st3, 0, 'e2', 'e4');
  assert.strictEqual(st3.drawOffer, 0); // the offer survives the offerer's own move
  assert.strictEqual(C.apply(st3, 1, { type: 'declineDraw' }), null);
  assert.strictEqual(st3.drawOffer, -1);
  C.apply(st3, 1, { type: 'offerDraw' });
  assert.strictEqual(C.apply(st3, 0, { type: 'acceptDraw' }), null);
  assert(st3.over && st3.reason === 'agreement');

  const st4 = C.newGame(['A', 'B']);
  C.apply(st4, 1, { type: 'resign' });
  assert(st4.over && st4.result === 'w' && C.viewFor(st4, 0).winner === 0);
});

test('threefold repetition', () => {
  const st = C.newGame(['A', 'B']);
  for (let k = 0; k < 2; k++) {
    mv(st, 0, 'g1', 'f3'); mv(st, 1, 'g8', 'f6');
    mv(st, 0, 'f3', 'g1'); mv(st, 1, 'f6', 'g8');
  }
  assert(st.over && st.reason === 'repetition');
});

test('view: only the side to move gets moves', () => {
  const st = C.newGame(['A', 'B'], { white: 0 });
  assert.strictEqual(C.viewFor(st, 0).moves.length, 20);
  assert.strictEqual(C.viewFor(st, 1).moves.length, 0);
  assert.strictEqual(C.viewFor(st, -1).moves.length, 0);
});

test('bot takes a free queen and finds mate in one', () => {
  const st = C.newGame(['A', 'B'], { fen: '4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1' });
  assert.deepStrictEqual(C.botAction(C.viewFor(st, 0)), { type: 'move', from: sq('d1'), to: sq('d5'), promo: undefined });
  const st2 = C.newGame(['A', 'B'], { fen: '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1' });
  const a = C.botAction(C.viewFor(st2, 0));
  assert.strictEqual(C.apply(st2, 0, a), null);
  assert.strictEqual(st2.reason, 'mate');
});

test('bot vs bot games end without errors', () => {
  for (let g = 0; g < 1; g++) {
    const st = C.newGame(['A', 'B'], { white: g });
    let plies = 0;
    while (!st.over && plies < 60) {
      const i = C.seatColor(st, 0) === st.pos.turn ? 0 : 1;
      const a = C.botAction(C.viewFor(st, i));
      assert.strictEqual(C.apply(st, i, a), null);
      plies++;
    }
  }
});

console.log(process.exitCode ? 'chess tests failed' : 'chess: ' + passed + ' tests passed');
