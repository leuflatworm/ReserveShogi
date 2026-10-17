// node test.js で実行
'use strict';
const assert = require('assert');
const E = require('./engine.js');
const AI = require('./ai.js');

const PASS = { kind: 'pass' };
let count = 0;
function test(name, fn) {
  fn();
  count++;
  console.log('ok - ' + name);
}

// 手番側が ins を出し、相手はパスして、再び手番側の自動行動が終わるところまで進める
function orderAndAdvance(s, ins) {
  assert.ok(E.applyInstruction(s, ins));
  E.startTurn(s);
  E.applyInstruction(s, PASS);
  return E.startTurn(s);
}
function advance(s) {
  E.applyInstruction(s, PASS);
  E.startTurn(s);
  E.applyInstruction(s, PASS);
  return E.startTurn(s);
}
function countPieces(s) {
  let n = s.board.filter(Boolean).length;
  for (const h of s.hands) for (const t of E.HAND_TYPES) n += h[t];
  return n;
}

test('初期配置は40枚', () => {
  const s = E.createInitialState();
  assert.strictEqual(countPieces(s), 40);
  assert.strictEqual(E.at(s, 7, 7).type, 'R');
  assert.strictEqual(E.at(s, 1, 1).type, 'R');
  assert.strictEqual(E.at(s, 4, 8).type, 'K');
});

test('指示は次の自ターン開始時に動き、以後も進み続ける', () => {
  const s = E.createInitialState();
  const pawn = E.at(s, 4, 6);
  E.applyInstruction(s, { kind: 'move', id: pawn.id, dx: 0, dy: -1, n: 1 });
  assert.deepStrictEqual([pawn.x, pawn.y], [4, 6], '指示直後はまだ動かない');
  E.startTurn(s);
  E.applyInstruction(s, PASS);
  E.startTurn(s);
  assert.deepStrictEqual([pawn.x, pawn.y], [4, 5]);
  advance(s);
  advance(s);
  assert.deepStrictEqual([pawn.x, pawn.y], [4, 3]);
  advance(s);
  assert.deepStrictEqual([pawn.x, pawn.y], [4, 2], '敵の歩を取る');
  assert.strictEqual(s.hands[0].P, 1);
  assert.ok(s.promotable.includes(pawn.id), '敵陣に入ったので成れる');
  assert.ok(pawn.order, '取っても指示は継続');
  advance(s);
  advance(s);
  assert.strictEqual(s.winner, 0, '玉を取って勝ち');
});

test('走り駒は指定マス数ずつ進み、盤端で自動停止', () => {
  const s = E.createEmptyState();
  const r = E.place(s, 'R', 0, 0, 8);
  orderAndAdvance(s, { kind: 'move', id: r.id, dx: 0, dy: -1, n: 3 });
  assert.strictEqual(r.y, 5);
  assert.deepStrictEqual(s.promotable, []);
  advance(s);
  assert.strictEqual(r.y, 2);
  assert.deepStrictEqual(s.promotable, [r.id]);
  assert.ok(r.order);
  const ev = advance(s);
  assert.strictEqual(r.y, 0);
  assert.strictEqual(r.order, null);
  assert.strictEqual(ev[0].stopped, true);
});

test('味方に塞がれたら待機し、指示は残る', () => {
  const s = E.createEmptyState();
  const r = E.place(s, 'R', 0, 0, 8);
  const p = E.place(s, 'P', 0, 0, 6);
  orderAndAdvance(s, { kind: 'move', id: r.id, dx: 0, dy: -1, n: 3 });
  assert.strictEqual(r.y, 7);
  assert.ok(r.order);
  advance(s);
  assert.strictEqual(r.y, 7);
  assert.ok(r.order);
  assert.strictEqual(p.y, 6);
});

test('味方同士は指示の古い順に解決', () => {
  // 前の歩が先に指示されていれば、後ろの飛車も同じターンに進める
  let s = E.createEmptyState();
  let r = E.place(s, 'R', 0, 0, 8);
  let p = E.place(s, 'P', 0, 0, 7);
  E.applyInstruction(s, { kind: 'move', id: p.id, dx: 0, dy: -1, n: 1 });
  E.startTurn(s);
  E.applyInstruction(s, PASS);
  E.startTurn(s);
  orderAndAdvance(s, { kind: 'move', id: r.id, dx: 0, dy: -1, n: 1 });
  assert.strictEqual(p.y, 5);
  assert.strictEqual(r.y, 7);

  // 飛車が先だと、歩が動く前に解決されるので1ターン待つ
  s = E.createEmptyState();
  r = E.place(s, 'R', 0, 0, 8);
  p = E.place(s, 'P', 0, 0, 7);
  E.applyInstruction(s, { kind: 'move', id: r.id, dx: 0, dy: -1, n: 1 });
  E.startTurn(s);
  E.applyInstruction(s, PASS);
  E.startTurn(s);
  assert.strictEqual(r.y, 8);
  orderAndAdvance(s, { kind: 'move', id: p.id, dx: 0, dy: -1, n: 1 });
  assert.strictEqual(r.y, 8);
  assert.strictEqual(p.y, 6);
  advance(s);
  assert.strictEqual(r.y, 7);
  assert.strictEqual(p.y, 5);
});

test('敵駒を取ったマスでその回は止まり、指示は継続', () => {
  const s = E.createEmptyState();
  const r = E.place(s, 'R', 0, 0, 8);
  E.place(s, 'S', 1, 0, 5, true);
  const ev = orderAndAdvance(s, { kind: 'move', id: r.id, dx: 0, dy: -1, n: 8 });
  assert.strictEqual(r.y, 5);
  assert.strictEqual(s.hands[0].S, 1);
  assert.deepStrictEqual(ev[0].captured, { type: 'S', promoted: true });
  assert.ok(r.order);
  advance(s);
  assert.strictEqual(r.y, 0);
  assert.strictEqual(r.order, null);
});

test('行き所のない駒は強制的に成る', () => {
  const s = E.createEmptyState();
  const p = E.place(s, 'P', 0, 3, 1);
  const n = E.place(s, 'N', 0, 6, 3);
  E.applyInstruction(s, { kind: 'move', id: p.id, dx: 0, dy: -1, n: 1 });
  E.startTurn(s);
  E.applyInstruction(s, PASS);
  E.startTurn(s);
  orderAndAdvance(s, { kind: 'move', id: n.id, dx: -1, dy: -2, n: 1 });
  assert.strictEqual(p.promoted, true);
  assert.strictEqual(p.order, null);
  assert.deepStrictEqual([n.x, n.y], [5, 1]);
  assert.strictEqual(n.promoted, true);
  assert.strictEqual(n.order, null);
});

test('成りは任意で、成ると停止する', () => {
  const s = E.createEmptyState();
  const sv = E.place(s, 'S', 0, 3, 3);
  orderAndAdvance(s, { kind: 'move', id: sv.id, dx: 0, dy: -1, n: 1 });
  assert.strictEqual(sv.y, 2);
  assert.strictEqual(sv.promoted, false);
  assert.deepStrictEqual(s.promotable, [sv.id]);
  assert.ok(sv.order);
  const turn = s.turn;
  assert.ok(E.promote(s, sv.id));
  assert.strictEqual(s.turn, turn, '成りは指示を消費しない');
  assert.strictEqual(sv.promoted, true);
  assert.strictEqual(sv.order, null);
  assert.strictEqual(E.promote(s, sv.id), false);
});

test('成らずに指示を出すと、その回の成りの機会は消える', () => {
  const s = E.createEmptyState();
  const sv = E.place(s, 'S', 0, 3, 3);
  orderAndAdvance(s, { kind: 'move', id: sv.id, dx: 0, dy: -1, n: 1 });
  E.applyInstruction(s, { kind: 'stop', id: sv.id });
  assert.deepStrictEqual(s.promotable, []);
  assert.strictEqual(sv.order, null);
});

test('後手は向きが反転する', () => {
  const s = E.createEmptyState();
  s.turn = 1;
  const p = E.place(s, 'P', 1, 4, 2);
  const moves = E.pieceInstructions(s, p);
  assert.deepStrictEqual(moves, [{ kind: 'move', id: p.id, dx: 0, dy: 1, n: 1 }]);
  orderAndAdvance(s, moves[0]);
  assert.strictEqual(p.y, 3);
});

test('打つ: 二歩と行き所のないマスは不可、打った駒は静止', () => {
  const s = E.createEmptyState();
  E.place(s, 'P', 0, 4, 6);
  s.hands[0].P = 1;
  s.hands[0].N = 1;
  assert.strictEqual(E.canDrop(s, 'P', 4, 4), false);
  assert.strictEqual(E.canDrop(s, 'P', 5, 0), false);
  assert.strictEqual(E.canDrop(s, 'N', 5, 1), false);
  assert.strictEqual(E.canDrop(s, 'N', 5, 2), true);
  assert.strictEqual(E.canDrop(s, 'G', 5, 4), false, '持っていない駒');
  assert.ok(E.applyInstruction(s, { kind: 'drop', type: 'P', x: 5, y: 4 }));
  assert.strictEqual(s.hands[0].P, 0);
  assert.strictEqual(E.at(s, 5, 4).order, null);
  assert.strictEqual(s.turn, 1);
});

// 先手玉5九・後手玉5一に、後手の攻め駒を1枚置いて前進を指示済みにした、先手の指示フェーズの局面
function threat(type, x, y, n) {
  const s = E.createEmptyState();
  E.place(s, 'K', 0, 4, 8);
  E.place(s, 'K', 1, 4, 0);
  const a = E.place(s, type, 1, x, y);
  a.order = { dx: 0, dy: 1, n, seq: ++s.seq };
  return { s, a };
}

test('詰み: 隣の駒の次の一歩が玉に届くと、どの指示でも防げない', () => {
  const { s, a } = threat('G', 4, 7, 1);
  s.hands[0].G = 1; // 合駒を打つ場所がない
  const king = E.at(s, 4, 8);
  assert.deepStrictEqual(E.findMate(s), { kingId: king.id, attackerId: a.id });
  assert.strictEqual(s.winner, null, 'findMate は局面を変えない');
  assert.ok(E.declareMate(s));
  assert.strictEqual(s.winner, 1);
  assert.deepStrictEqual(E.clone(s).mate, { kingId: king.id, attackerId: a.id });
});

test('詰みではない: 玉に届くのが2ターン先なら逃げる指示が間に合う', () => {
  const { s } = threat('G', 4, 6, 1);
  assert.strictEqual(E.findMate(s), null);
  assert.strictEqual(E.declareMate(s), null);
  assert.strictEqual(s.winner, null);
});

test('詰みではない: 走り駒の進路に合駒を打てる', () => {
  const { s } = threat('R', 4, 4, 8);
  assert.ok(E.findMate(s), '持ち駒がなければ詰み');
  s.hands[0].S = 1;
  assert.strictEqual(E.findMate(s), null);
});

test('詰み: 合駒が二歩でしか打てないなら防げない', () => {
  const { s } = threat('R', 4, 4, 8);
  s.hands[0].P = 1;
  assert.strictEqual(E.findMate(s), null, '歩の合駒が利く');
  E.place(s, 'P', 0, 4, 2); // 同じ筋に自分の歩がいると二歩で打てない
  assert.ok(E.findMate(s));
});

test('詰みの判定は全指示の総当たりと一致する', () => {
  let checked = 0;
  let mates = 0;
  for (let g = 0; g < 4; g++) {
    const s = E.createInitialState();
    for (let t = 0; t < 300; t++) {
      E.startTurn(s);
      if (s.winner !== null) break;
      for (const id of s.promotable.slice()) E.promote(s, id);
      const me = s.turn;
      const anySave = E.listInstructions(s).some((ins) => {
        const c = E.clone(s);
        E.applyInstruction(c, ins);
        E.startTurn(c);
        return c.winner !== 1 - me;
      });
      assert.strictEqual(!!E.findMate(s), !anySave);
      checked++;
      if (!anySave) mates++;
      E.applyInstruction(s, AI.choose(s));
    }
  }
  console.log(`   ${checked}局面を照合、うち詰み${mates}`);
  assert.ok(mates > 0, '詰みの局面を少なくとも1つ照合している');
});

test('CPUはどの強さでも合法な指示を返す', () => {
  for (const lv of AI.LEVELS) {
    const s = E.createInitialState();
    for (let t = 0; t < 20 && s.winner === null; t++) {
      E.startTurn(s);
      if (s.winner === null) E.declareMate(s);
      if (s.winner !== null) break;
      const legal = E.listInstructions(s).map((l) => JSON.stringify(l));
      // 持ち時間で読む段階は、テストを速くするため持ち時間を短くする
      const ins = AI.choose(s, lv.opts.time ? Object.assign({}, lv.opts, { time: 50 }) : lv.opts);
      assert.ok(legal.includes(JSON.stringify(ins)), lv.name);
      E.applyInstruction(s, ins);
    }
  }
});

test('CPU同士の対局で盤面の整合性が保たれる', () => {
  for (let g = 0; g < 5; g++) {
    const s = E.createInitialState();
    for (let t = 0; t < 300 && s.winner === null; t++) {
      E.startTurn(s);
      if (s.winner !== null) break;
      for (const id of s.promotable.slice()) E.promote(s, id);
      const legal = E.listInstructions(s);
      const ins = AI.choose(s);
      assert.ok(legal.some((l) => JSON.stringify(l) === JSON.stringify(ins)), 'CPUの指示は合法');
      assert.ok(E.applyInstruction(s, ins));
      assert.strictEqual(countPieces(s), 40);
      s.board.forEach((p, i) => {
        if (!p) return;
        assert.strictEqual(p.y * 9 + p.x, i, '駒の座標と盤が一致');
        if (p.order) assert.ok(E.inBoard(p.x + p.order.dx, p.y + p.order.dy), '盤外へ向かう指示は残らない');
      });
    }
    assert.strictEqual(countPieces(s), s.winner === null ? 40 : 39);
    console.log(`   game ${g + 1}: ${s.turnCount}手 winner=${s.winner}`);
  }
});

console.log(`\n${count} tests passed`);
