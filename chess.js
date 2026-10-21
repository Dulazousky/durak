// Chess rules engine and bot. No DOM, no network: the host runs it, and the
// tests run it under Node. Squares are 0..63, a1 = 0, h1 = 7, a8 = 56.
// Pieces are letters, upper case for white: P N B R Q K.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChessEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FILES = 'abcdefgh';
  const N_OFF = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const K_OFF = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  const colorOf = (p) => (p ? (p === p.toUpperCase() ? 'w' : 'b') : null);
  const other = (c) => (c === 'w' ? 'b' : 'w');
  const sqName = (s) => FILES[s & 7] + ((s >> 3) + 1);
  const onBoard = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
  const own = (p, c) => (c === 'w' ? p.toUpperCase() : p.toLowerCase());

  function initialPosition() {
    return fromFEN('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  }

  function fromFEN(fen) {
    const [rows, turn, castling, ep, half, full] = fen.trim().split(/\s+/);
    const board = new Array(64).fill(null);
    rows.split('/').forEach((row, i) => {
      const r = 7 - i;
      let f = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) f += Number(ch);
        else board[r * 8 + f++] = ch;
      }
    });
    return {
      board,
      turn: turn || 'w',
      castling: castling && castling !== '-' ? castling : '',
      ep: ep && ep !== '-' ? FILES.indexOf(ep[0]) + (Number(ep[1]) - 1) * 8 : -1,
      half: Number(half) || 0,
      full: Number(full) || 1,
    };
  }

  // Is square s attacked by any piece of colour `by`?
  function attacked(b, s, by) {
    const f = s & 7;
    const r = s >> 3;
    const pr = r + (by === 'w' ? -1 : 1);
    const P = own('p', by);
    for (const df of [-1, 1]) if (onBoard(f + df, pr) && b[pr * 8 + f + df] === P) return true;
    const N = own('n', by);
    for (const [df, dr] of N_OFF) if (onBoard(f + df, r + dr) && b[(r + dr) * 8 + f + df] === N) return true;
    const K = own('k', by);
    for (const [df, dr] of K_OFF) if (onBoard(f + df, r + dr) && b[(r + dr) * 8 + f + df] === K) return true;
    const slide = (dirs, a, q) => {
      for (const [df, dr] of dirs) {
        let x = f + df;
        let y = r + dr;
        while (onBoard(x, y)) {
          const p = b[y * 8 + x];
          if (p) {
            if (p === a || p === q) return true;
            break;
          }
          x += df;
          y += dr;
        }
      }
      return false;
    };
    const Q = own('q', by);
    return slide(DIAG, own('b', by), Q) || slide(ORTH, own('r', by), Q);
  }

  function kingSquare(b, c) {
    const K = own('k', c);
    return b.indexOf(K);
  }

  function inCheck(pos, c) {
    c = c || pos.turn;
    const k = kingSquare(pos.board, c);
    return k >= 0 && attacked(pos.board, k, other(c));
  }

  // Moves that obey piece movement but may leave the own king in check.
  function pseudoMoves(pos) {
    const b = pos.board;
    const c = pos.turn;
    const moves = [];
    const add = (from, to, flag) => {
      const r = to >> 3;
      if ((b[from] === 'P' && r === 7) || (b[from] === 'p' && r === 0)) {
        for (const promo of ['q', 'r', 'b', 'n']) moves.push({ from, to, promo, flag });
      } else moves.push({ from, to, flag });
    };
    for (let s = 0; s < 64; s++) {
      const p = b[s];
      if (!p || colorOf(p) !== c) continue;
      const f = s & 7;
      const r = s >> 3;
      const kind = p.toLowerCase();
      if (kind === 'p') {
        const dir = c === 'w' ? 1 : -1;
        const start = c === 'w' ? 1 : 6;
        const one = s + dir * 8;
        if (onBoard(f, r + dir) && !b[one]) {
          add(s, one);
          const two = s + dir * 16;
          if (r === start && !b[two]) moves.push({ from: s, to: two, flag: 'double' });
        }
        for (const df of [-1, 1]) {
          if (!onBoard(f + df, r + dir)) continue;
          const t = (r + dir) * 8 + f + df;
          if (b[t] && colorOf(b[t]) !== c) add(s, t);
          else if (t === pos.ep) moves.push({ from: s, to: t, flag: 'ep' });
        }
      } else if (kind === 'n' || kind === 'k') {
        for (const [df, dr] of kind === 'n' ? N_OFF : K_OFF) {
          if (!onBoard(f + df, r + dr)) continue;
          const t = (r + dr) * 8 + f + df;
          if (!b[t] || colorOf(b[t]) !== c) moves.push({ from: s, to: t });
        }
      } else {
        const dirs = kind === 'b' ? DIAG : kind === 'r' ? ORTH : DIAG.concat(ORTH);
        for (const [df, dr] of dirs) {
          let x = f + df;
          let y = r + dr;
          while (onBoard(x, y)) {
            const t = y * 8 + x;
            if (b[t]) {
              if (colorOf(b[t]) !== c) moves.push({ from: s, to: t });
              break;
            }
            moves.push({ from: s, to: t });
            x += df;
            y += dr;
          }
        }
      }
    }
    // Castling: king and rook unmoved, squares between empty, and the king
    // neither in check nor passing through or landing on an attacked square.
    const home = c === 'w' ? 0 : 56;
    const them = other(c);
    if (b[home + 4] === own('k', c)) {
      const R = own('r', c);
      if (pos.castling.includes(c === 'w' ? 'K' : 'k') && b[home + 7] === R && !b[home + 5] && !b[home + 6] &&
        !attacked(b, home + 4, them) && !attacked(b, home + 5, them) && !attacked(b, home + 6, them)) {
        moves.push({ from: home + 4, to: home + 6, flag: 'castle' });
      }
      if (pos.castling.includes(c === 'w' ? 'Q' : 'q') && b[home] === R && !b[home + 1] && !b[home + 2] && !b[home + 3] &&
        !attacked(b, home + 4, them) && !attacked(b, home + 3, them) && !attacked(b, home + 2, them)) {
        moves.push({ from: home + 4, to: home + 2, flag: 'castle' });
      }
    }
    return moves;
  }

  function makeMove(pos, m) {
    const b = pos.board.slice();
    const p = b[m.from];
    const c = pos.turn;
    const captured = m.flag === 'ep' ? b[m.to + (c === 'w' ? -8 : 8)] : b[m.to];
    b[m.to] = m.promo ? own(m.promo, c) : p;
    b[m.from] = null;
    if (m.flag === 'ep') b[m.to + (c === 'w' ? -8 : 8)] = null;
    if (m.flag === 'castle') {
      const home = c === 'w' ? 0 : 56;
      if (m.to === home + 6) { b[home + 5] = b[home + 7]; b[home + 7] = null; }
      else { b[home + 3] = b[home]; b[home] = null; }
    }
    let castling = pos.castling;
    const drop = (ch) => { castling = castling.replace(ch, ''); };
    if (p === 'K') { drop('K'); drop('Q'); }
    if (p === 'k') { drop('k'); drop('q'); }
    for (const s of [m.from, m.to]) {
      if (s === 0) drop('Q');
      if (s === 7) drop('K');
      if (s === 56) drop('q');
      if (s === 63) drop('k');
    }
    return {
      board: b,
      turn: other(c),
      castling,
      ep: m.flag === 'double' ? (m.from + m.to) / 2 : -1,
      half: p.toLowerCase() === 'p' || captured ? 0 : pos.half + 1,
      full: pos.full + (c === 'b' ? 1 : 0),
      captured: captured || null,
    };
  }

  function legalMoves(pos) {
    const c = pos.turn;
    return pseudoMoves(pos).filter((m) => !inCheck(makeMove(pos, m), c));
  }

  function perft(pos, depth) {
    if (depth === 0) return 1;
    let n = 0;
    for (const m of legalMoves(pos)) n += depth === 1 ? 1 : perft(makeMove(pos, m), depth - 1);
    return n;
  }

  function san(pos, m, legal) {
    if (m.flag === 'castle') return ((m.to & 7) === 6 ? 'O-O' : 'O-O-O') + checkSuffix(makeMove(pos, m));
    const p = pos.board[m.from].toUpperCase();
    const capture = !!pos.board[m.to] || m.flag === 'ep';
    let s = '';
    if (p === 'P') {
      if (capture) s += FILES[m.from & 7] + 'x';
      s += sqName(m.to);
      if (m.promo) s += '=' + m.promo.toUpperCase();
    } else {
      s = p;
      const twins = legal.filter((o) => o.to === m.to && o.from !== m.from && pos.board[o.from] === pos.board[m.from]);
      if (twins.length) {
        const sameFile = twins.some((o) => (o.from & 7) === (m.from & 7));
        const sameRank = twins.some((o) => (o.from >> 3) === (m.from >> 3));
        if (!sameFile) s += FILES[m.from & 7];
        else if (!sameRank) s += (m.from >> 3) + 1;
        else s += sqName(m.from);
      }
      if (capture) s += 'x';
      s += sqName(m.to);
    }
    return s + checkSuffix(makeMove(pos, m));
  }

  function checkSuffix(next) {
    if (!inCheck(next)) return '';
    return legalMoves(next).length ? '+' : '#';
  }

  function insufficient(b) {
    const rest = b.filter((p) => p && p.toLowerCase() !== 'k');
    if (!rest.length) return true;
    return rest.length === 1 && 'nb'.includes(rest[0].toLowerCase());
  }

  const posKey = (pos) => pos.board.map((p) => p || '.').join('') + pos.turn + pos.castling + pos.ep;

  // ---- game (two seats) -------------------------------------------------

  // names: two player names. opts.white: index of the white player.
  function newGame(names, opts) {
    opts = opts || {};
    const pos = opts.fen ? fromFEN(opts.fen) : initialPosition();
    return {
      names: names.slice(0, 2),
      white: opts.white === 1 ? 1 : 0,
      pos,
      history: [],
      reps: { [posKey(pos)]: 1 },
      captured: { w: [], b: [] },
      last: null,
      drawOffer: -1,
      over: false,
      result: null, // 'w' | 'b' | 'draw'
      reason: null, // mate | stalemate | resign | agreement | repetition | fifty | material
      log: [],
    };
  }

  const seatColor = (st, i) => (i === st.white ? 'w' : i === 1 - st.white ? 'b' : null);
  const colorSeat = (st, c) => (c === 'w' ? st.white : 1 - st.white);

  function log(st, entry) {
    entry.at = Date.now();
    st.log.push(entry);
    if (st.log.length > 80) st.log.shift();
  }

  function finish(st, result, reason) {
    st.over = true;
    st.result = result;
    st.reason = reason;
    st.drawOffer = -1;
    log(st, { t: 'over', result, reason });
  }

  function apply(st, i, a) {
    if (st.over) return 'over';
    if (!a || typeof a.type !== 'string') return 'bad';
    const c = seatColor(st, i);
    if (!c) return 'bad';
    switch (a.type) {
      case 'move': {
        if (st.pos.turn !== c) return 'notYourTurn';
        const legal = legalMoves(st.pos);
        const cands = legal.filter((m) => m.from === a.from && m.to === a.to);
        if (!cands.length) return 'illegal';
        const m = cands.find((x) => (x.promo || null) === (a.promo || null)) || (cands[0].promo ? cands.find((x) => x.promo === 'q') : null);
        if (!m) return 'illegal';
        const text = san(st.pos, m, legal);
        const next = makeMove(st.pos, m);
        if (next.captured) st.captured[c].push(next.captured);
        delete next.captured;
        st.pos = next;
        st.history.push(text);
        st.last = { from: m.from, to: m.to };
        if (st.drawOffer !== i) st.drawOffer = -1; // moving on declines the opponent's offer
        log(st, { t: 'move', p: i, san: text, n: Math.ceil(st.history.length / 2) });
        const key = posKey(next);
        st.reps[key] = (st.reps[key] || 0) + 1;
        if (!legalMoves(next).length) {
          if (inCheck(next)) finish(st, c, 'mate');
          else finish(st, 'draw', 'stalemate');
        } else if (st.reps[key] >= 3) finish(st, 'draw', 'repetition');
        else if (next.half >= 100) finish(st, 'draw', 'fifty');
        else if (insufficient(next.board)) finish(st, 'draw', 'material');
        return null;
      }
      case 'resign':
        log(st, { t: 'resign', p: i });
        finish(st, other(c), 'resign');
        return null;
      case 'offerDraw':
        if (st.drawOffer === i) return null;
        if (st.drawOffer === 1 - i) { finish(st, 'draw', 'agreement'); return null; }
        st.drawOffer = i;
        log(st, { t: 'offer', p: i });
        return null;
      case 'acceptDraw':
        if (st.drawOffer !== 1 - i) return 'bad';
        finish(st, 'draw', 'agreement');
        return null;
      case 'declineDraw':
        if (st.drawOffer !== 1 - i) return 'bad';
        st.drawOffer = -1;
        log(st, { t: 'decline', p: i });
        return null;
    }
    return 'bad';
  }

  function viewFor(st, i) {
    const me = i === 0 || i === 1 ? i : -1;
    const c = me >= 0 ? seatColor(st, me) : null;
    const check = inCheck(st.pos) ? kingSquare(st.pos.board, st.pos.turn) : -1;
    return {
      you: me,
      color: c,
      names: st.names,
      white: st.white,
      pos: { board: st.pos.board.slice(), turn: st.pos.turn, castling: st.pos.castling, ep: st.pos.ep, half: st.pos.half, full: st.pos.full },
      moves: c && c === st.pos.turn && !st.over ? legalMoves(st.pos).map((m) => ({ from: m.from, to: m.to, promo: m.promo })) : [],
      history: st.history.slice(),
      captured: { w: st.captured.w.slice(), b: st.captured.b.slice() },
      last: st.last,
      check,
      drawOffer: st.drawOffer,
      over: st.over,
      result: st.result,
      reason: st.reason,
      winner: st.result && st.result !== 'draw' ? colorSeat(st, st.result) : -1,
      log: st.log.slice(-40),
    };
  }

  // ---- bot: small alpha-beta search -------------------------------------

  const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
  const CENTER = [];
  for (let s = 0; s < 64; s++) {
    const f = s & 7;
    const r = s >> 3;
    CENTER.push(6 - Math.abs(3.5 - f) - Math.abs(3.5 - r)); // 0 at corners, 6 in the middle
  }

  // Static score from white's point of view.
  function evaluate(b) {
    let score = 0;
    let queens = 0;
    for (const p of b) if (p === 'q' || p === 'Q') queens++;
    for (let s = 0; s < 64; s++) {
      const p = b[s];
      if (!p) continue;
      const k = p.toLowerCase();
      const sign = p === k ? -1 : 1;
      const r = s >> 3;
      let v = VALUE[k];
      if (k === 'n' || k === 'b') v += CENTER[s] * 5;
      else if (k === 'p') v += (sign > 0 ? r - 1 : 6 - r) * 6 + ((s & 7) >= 2 && (s & 7) <= 5 ? 6 : 0);
      else if (k === 'q') v += CENTER[s] * 2;
      else if (k === 'k') v += queens ? -CENTER[s] * 6 : CENTER[s] * 4;
      score += sign * v;
    }
    return score;
  }

  const MATE = 100000;

  function ordered(pos, moves) {
    const b = pos.board;
    const key = (m) => (b[m.to] ? VALUE[b[m.to].toLowerCase()] * 10 - VALUE[b[m.from].toLowerCase()] : 0) + (m.promo ? 800 : 0);
    return moves.sort((x, y) => key(y) - key(x));
  }

  function quiesce(pos, alpha, beta, depth) {
    const sign = pos.turn === 'w' ? 1 : -1;
    const stand = sign * evaluate(pos.board);
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    if (depth <= 0) return alpha;
    const caps = ordered(pos, legalMoves(pos).filter((m) => pos.board[m.to] || m.promo));
    for (const m of caps) {
      const score = -quiesce(makeMove(pos, m), -beta, -alpha, depth - 1);
      if (score >= beta) return score;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  function search(pos, depth, alpha, beta, ply) {
    const moves = legalMoves(pos);
    if (!moves.length) return inCheck(pos) ? -MATE + ply : 0;
    if (depth === 0) return quiesce(pos, alpha, beta, 4);
    for (const m of ordered(pos, moves)) {
      const score = -search(makeMove(pos, m), depth - 1, -beta, -alpha, ply + 1);
      if (score >= beta) return score;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  function bestMove(pos, depth, rng) {
    rng = rng || Math.random;
    const moves = ordered(pos, legalMoves(pos));
    let best = null;
    let bestScore = -Infinity;
    for (const m of moves) {
      // A little noise so the bot doesn't play the same game every time.
      const score = -search(makeMove(pos, m), depth - 1, -Infinity, -bestScore + 15, 1) + rng() * 12;
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return best;
  }

  function botAction(v) {
    if (v.over || !v.color) return null;
    if (v.drawOffer === 1 - v.you) {
      const sign = v.color === 'w' ? 1 : -1;
      return sign * evaluate(v.pos.board) < -150 ? { type: 'acceptDraw' } : { type: 'declineDraw' };
    }
    if (v.pos.turn !== v.color) return null;
    const m = bestMove(v.pos, 3);
    return m ? { type: 'move', from: m.from, to: m.to, promo: m.promo } : null;
  }

  // Cheap check for the host's bot scheduler: does this bot have something to do?
  function botWants(v) {
    if (v.over || !v.color) return false;
    return v.drawOffer === 1 - v.you || v.pos.turn === v.color;
  }

  return {
    FILES, colorOf, sqName, fromFEN, initialPosition, attacked, inCheck,
    pseudoMoves, legalMoves, makeMove, perft, san, evaluate, bestMove,
    newGame, apply, viewFor, botAction, botWants, seatColor,
  };
});
