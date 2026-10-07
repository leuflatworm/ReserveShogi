// ReserveShogi ルールエンジン(DOM非依存。ブラウザでは window.Engine、Node では require で使う)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIZE = 9;
  const HAND_TYPES = ['R', 'B', 'G', 'S', 'N', 'L', 'P'];

  // 先手(owner 0)視点の動き。前 = dy -1。後手は180度回転して使う。
  const ORTH = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  const DIAG = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  const GOLD = [[0, -1], [-1, -1], [1, -1], [-1, 0], [1, 0], [0, 1]];
  const MOVES = {
    K: { step: ORTH.concat(DIAG) },
    G: { step: GOLD },
    S: { step: [[0, -1], [-1, -1], [1, -1], [-1, 1], [1, 1]] },
    N: { step: [[-1, -2], [1, -2]] },
    L: { slide: [[0, -1]] },
    P: { step: [[0, -1]] },
    R: { slide: ORTH },
    B: { slide: DIAG },
  };
  const PROMOTED_MOVES = {
    R: { slide: ORTH, step: DIAG },
    B: { slide: DIAG, step: ORTH },
    S: { step: GOLD },
    N: { step: GOLD },
    L: { step: GOLD },
    P: { step: GOLD },
  };

  function inBoard(x, y) {
    return x >= 0 && x < SIZE && y >= 0 && y < SIZE;
  }

  function at(s, x, y) {
    return s.board[y * SIZE + x];
  }

  function emptyHand() {
    return { R: 0, B: 0, G: 0, S: 0, N: 0, L: 0, P: 0 };
  }

  function createEmptyState() {
    return {
      board: new Array(SIZE * SIZE).fill(null),
      hands: [emptyHand(), emptyHand()],
      turn: 0,
      turnCount: 0,
      seq: 0,
      nextId: 1,
      winner: null,
      mate: null, // 詰みで終局したとき { kingId, attackerId }
      promotable: [],
    };
  }

  function place(s, type, owner, x, y, promoted) {
    const p = { id: s.nextId++, type, owner, promoted: !!promoted, x, y, order: null };
    s.board[y * SIZE + x] = p;
    return p;
  }

  function createInitialState() {
    const s = createEmptyState();
    const back = ['L', 'N', 'S', 'G', 'K', 'G', 'S', 'N', 'L'];
    for (let x = 0; x < SIZE; x++) {
      place(s, back[x], 1, x, 0);
      place(s, 'P', 1, x, 2);
      place(s, 'P', 0, x, 6);
      place(s, back[x], 0, x, 8);
    }
    place(s, 'R', 1, 1, 1);
    place(s, 'B', 1, 7, 1);
    place(s, 'B', 0, 1, 7);
    place(s, 'R', 0, 7, 7);
    return s;
  }

  function clone(s) {
    return {
      board: s.board.map((p) =>
        p
          ? {
              id: p.id,
              type: p.type,
              owner: p.owner,
              promoted: p.promoted,
              x: p.x,
              y: p.y,
              order: p.order ? { dx: p.order.dx, dy: p.order.dy, n: p.order.n, seq: p.order.seq } : null,
            }
          : null
      ),
      hands: [Object.assign({}, s.hands[0]), Object.assign({}, s.hands[1])],
      turn: s.turn,
      turnCount: s.turnCount,
      seq: s.seq,
      nextId: s.nextId,
      winner: s.winner,
      mate: s.mate ? { kingId: s.mate.kingId, attackerId: s.mate.attackerId } : null,
      promotable: s.promotable.slice(),
    };
  }

  function findPiece(s, id) {
    for (const p of s.board) if (p && p.id === id) return p;
    return null;
  }

  function moveDirs(p) {
    const def = (p.promoted ? PROMOTED_MOVES : MOVES)[p.type];
    const sign = p.owner === 0 ? 1 : -1;
    const out = [];
    for (const [dx, dy] of def.slide || []) out.push({ dx: dx * sign || 0, dy: dy * sign || 0, slide: true });
    for (const [dx, dy] of def.step || []) out.push({ dx: dx * sign || 0, dy: dy * sign || 0, slide: false });
    return out;
  }

  // 敵陣の最奥段までの距離(0 = 最奥段)
  function distToEnd(owner, y) {
    return owner === 0 ? y : SIZE - 1 - y;
  }

  function inZone(owner, y) {
    return distToEnd(owner, y) <= 2;
  }

  function canPromote(p) {
    return !p.promoted && p.type !== 'K' && p.type !== 'G';
  }

  // 行き所のない駒は成るしかない
  function mustPromote(p) {
    if (p.promoted) return false;
    const d = distToEnd(p.owner, p.y);
    return ((p.type === 'P' || p.type === 'L') && d === 0) || (p.type === 'N' && d <= 1);
  }

  function capture(s, mover, target) {
    if (target.type === 'K') s.winner = mover.owner;
    else s.hands[mover.owner][target.type]++;
  }

  // 手番側の予約行動を一斉に実行する。指示の古い順に解決。
  function startTurn(s) {
    const events = [];
    s.promotable = [];
    if (s.winner !== null) return events;
    const me = s.turn;
    const units = s.board
      .filter((p) => p && p.owner === me && p.order)
      .sort((a, b) => a.order.seq - b.order.seq);

    for (const p of units) {
      if (s.winner !== null) break;
      const { dx, dy, n } = p.order;
      const from = [p.x, p.y];
      const wasPromoted = p.promoted;
      let captured = null;
      let moved = 0;
      for (let i = 0; i < n; i++) {
        const nx = p.x + dx;
        const ny = p.y + dy;
        if (!inBoard(nx, ny)) break;
        const t = at(s, nx, ny);
        if (t && t.owner === me) break; // 味方がいれば待機(指示は残る)
        s.board[p.y * SIZE + p.x] = null;
        s.board[ny * SIZE + nx] = p;
        p.x = nx;
        p.y = ny;
        moved++;
        if (t) {
          capture(s, p, t);
          captured = { type: t.type, promoted: t.promoted };
          break; // 取ったマスで今回の行動は終わり(指示は継続)
        }
      }

      // 盤端: これ以上待っても進めないので自動停止
      let stopped = false;
      if (!inBoard(p.x + dx, p.y + dy)) {
        p.order = null;
        stopped = true;
      }

      let forcedPromotion = false;
      if (moved && canPromote(p) && (inZone(me, from[1]) || inZone(me, p.y))) {
        if (mustPromote(p)) {
          p.promoted = true;
          p.order = null;
          forcedPromotion = true;
        } else {
          s.promotable.push(p.id);
        }
      }

      if (moved || stopped) {
        events.push({
          id: p.id,
          type: p.type,
          wasPromoted,
          from,
          to: [p.x, p.y],
          moved: moved > 0,
          captured,
          stopped,
          forcedPromotion,
        });
      }
    }
    return events;
  }

  // 成りは指示を消費しない。成ったら自動で停止。
  function promote(s, id) {
    const i = s.promotable.indexOf(id);
    if (i < 0) return false;
    const p = findPiece(s, id);
    s.promotable.splice(i, 1);
    if (!p) return false;
    p.promoted = true;
    p.order = null;
    return true;
  }

  function pieceInstructions(s, p) {
    const out = [];
    for (const d of moveDirs(p)) {
      const max = d.slide ? SIZE - 1 : 1;
      for (let n = 1; n <= max; n++) {
        if (!inBoard(p.x + d.dx * n, p.y + d.dy * n)) break;
        out.push({ kind: 'move', id: p.id, dx: d.dx, dy: d.dy, n });
      }
    }
    return out;
  }

  function canDrop(s, type, x, y) {
    if (!inBoard(x, y) || at(s, x, y)) return false;
    const me = s.turn;
    if (!s.hands[me][type]) return false;
    const d = distToEnd(me, y);
    if ((type === 'P' || type === 'L') && d === 0) return false;
    if (type === 'N' && d <= 1) return false;
    if (type === 'P') {
      for (let yy = 0; yy < SIZE; yy++) {
        const q = at(s, x, yy);
        if (q && q.owner === me && q.type === 'P' && !q.promoted) return false; // 二歩
      }
    }
    return true;
  }

  function dropInstructions(s, type) {
    const out = [];
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (canDrop(s, type, x, y)) out.push({ kind: 'drop', type, x, y });
      }
    }
    return out;
  }

  function sameOrder(order, ins) {
    return !!order && order.dx === ins.dx && order.dy === ins.dy && order.n === ins.n;
  }

  function listInstructions(s) {
    const out = [{ kind: 'pass' }];
    if (s.winner !== null) return out;
    const me = s.turn;
    for (const p of s.board) {
      if (!p || p.owner !== me) continue;
      if (p.order) out.push({ kind: 'stop', id: p.id });
      for (const ins of pieceInstructions(s, p)) {
        if (!sameOrder(p.order, ins)) out.push(ins);
      }
    }
    for (const type of HAND_TYPES) {
      if (s.hands[me][type]) Array.prototype.push.apply(out, dropInstructions(s, type));
    }
    return out;
  }

  // 1ターンに出せる指示は1つ。適用すると手番が相手に移る。
  function applyInstruction(s, ins) {
    if (s.winner !== null) return false;
    const me = s.turn;
    if (ins.kind === 'move' || ins.kind === 'stop') {
      const p = findPiece(s, ins.id);
      if (!p || p.owner !== me) return false;
      if (ins.kind === 'stop') {
        p.order = null;
      } else {
        if (!inBoard(p.x + ins.dx, p.y + ins.dy)) return false;
        p.order = { dx: ins.dx, dy: ins.dy, n: ins.n, seq: ++s.seq };
      }
    } else if (ins.kind === 'drop') {
      if (!canDrop(s, ins.type, ins.x, ins.y)) return false;
      s.hands[me][ins.type]--;
      place(s, ins.type, me, ins.x, ins.y);
    } else if (ins.kind !== 'pass') {
      return false;
    }
    s.promotable = [];
    s.turn = 1 - me;
    s.turnCount++;
    return true;
  }

  // 手番側の指示フェーズで、どの指示を出しても次の相手の行動で玉を取られるなら詰み。
  // 指示した動きは相手の行動より後にしか実行されないので、間に合うのは「打つ」(合駒)だけ。
  // したがってパスと打つ手だけ調べれば全指示を調べたことになる。
  function findMate(s) {
    if (s.winner !== null) return null;
    const me = s.turn;
    const probe = (ins) => {
      const c = clone(s);
      applyInstruction(c, ins);
      const events = startTurn(c);
      return c.winner === 1 - me ? events : null;
    };
    const events = probe({ kind: 'pass' });
    if (!events) return null;
    for (const type of HAND_TYPES) {
      if (!s.hands[me][type]) continue;
      for (const ins of dropInstructions(s, type)) {
        if (!probe(ins)) return null;
      }
    }
    const king = s.board.find((p) => p && p.owner === me && p.type === 'K');
    const hit = events.find((e) => e.captured && e.captured.type === 'K');
    return { kingId: king.id, attackerId: hit.id };
  }

  // 詰みならその場で終局させる
  function declareMate(s) {
    const mate = findMate(s);
    if (!mate) return null;
    s.winner = 1 - s.turn;
    s.mate = mate;
    return mate;
  }

  return {
    SIZE,
    HAND_TYPES,
    findMate,
    declareMate,
    inBoard,
    at,
    createEmptyState,
    createInitialState,
    place,
    clone,
    findPiece,
    moveDirs,
    inZone,
    canPromote,
    startTurn,
    promote,
    pieceInstructions,
    dropInstructions,
    canDrop,
    sameOrder,
    listInstructions,
    applyInstruction,
  };
});
