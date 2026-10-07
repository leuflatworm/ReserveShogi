// 簡易CPU。指示の候補を「以後は両者パス」で数手先まで進めて駒得で評価する。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.AI = factory(root.Engine);
})(typeof self !== 'undefined' ? self : this, function (Engine) {
  'use strict';

  const PASS = { kind: 'pass' };
  const VALUE = { P: 1, L: 3, N: 3, S: 5, G: 6, B: 8, R: 10, K: 0 };
  const PROMO_BONUS = { P: 5, L: 3, N: 3, S: 1, B: 3, R: 3 };
  const WIN = 10000;
  const MAX_FALLBACK = 250;
  // top: 相手の応手まで調べる候補数(0なら調べない) / depth: 先読みする半ターン数 / noise: 評価の揺らぎ
  // plies: 指定すると「自分の指示→相手の応手→自分の受け…」を plies 手先まで読む / beam: そのとき各手番で読む候補数
  const DEFAULTS = { top: 10, depth: 4, noise: 0.2, plies: 0, beam: 14 };
  // 強さの段階。隣どうしを対戦させて、上の段階が勝ち越すことを確かめてある。
  const LEVELS = [
    { id: 'intro', name: '入門', opts: { top: 0, noise: 4 } },
    { id: 'weak', name: '弱い', opts: { top: 0 } },
    { id: 'normal', name: '普通', opts: {} },
    { id: 'strong', name: '強い', opts: { plies: 3, beam: 14 } },
    { id: 'top', name: '最強(考える時間が長い)', opts: { plies: 5, beam: 6 } },
  ];
  const DEFAULT_LEVEL = 'normal';

  function evaluate(s, me) {
    if (s.winner !== null) return s.winner === me ? WIN : -WIN;
    let v = 0;
    for (const p of s.board) {
      if (!p) continue;
      const adv = p.owner === 0 ? 8 - p.y : p.y;
      let val = VALUE[p.type] + (p.promoted ? PROMO_BONUS[p.type] : 0);
      val += p.type === 'K' ? -0.2 * adv : 0.04 * adv;
      v += p.owner === me ? val : -val;
    }
    for (const t of Engine.HAND_TYPES) {
      v += (s.hands[me][t] - s.hands[1 - me][t]) * VALUE[t];
    }
    return v;
  }

  function promoteAll(s) {
    for (const id of s.promotable.slice()) Engine.promote(s, id);
  }

  // 両者が新しい指示を出さないと仮定して depth 半ターン進める
  function rollout(s, me, depth) {
    for (let i = 0; i < depth; i++) {
      Engine.startTurn(s);
      if (s.winner !== null) return (s.winner === me ? 1 : -1) * (WIN + depth - i);
      promoteAll(s);
      Engine.applyInstruction(s, PASS);
    }
    return evaluate(s, me);
  }

  function worstReply(s, me, ins, depth) {
    const c = Engine.clone(s);
    Engine.applyInstruction(c, ins);
    Engine.startTurn(c);
    if (c.winner !== null) return c.winner === me ? WIN : -WIN;
    promoteAll(c);
    let worst = Infinity;
    for (const reply of Engine.listInstructions(c)) {
      if (reply.kind === 'drop') continue;
      const d = Engine.clone(c);
      Engine.applyInstruction(d, reply);
      const v = rollout(d, me, depth);
      if (v < worst) worst = v;
    }
    return worst;
  }

  // 手番 p から見て良さそうな順に並べた指示の一覧
  function scoreMoves(s, p, depth) {
    return Engine.listInstructions(s)
      .map((ins) => {
        const c = Engine.clone(s);
        Engine.applyInstruction(c, ins);
        return { ins, score: rollout(c, p, depth) };
      })
      .sort((a, b) => b.score - a.score);
  }

  // 指示 ins を出し、相手の自動行動まで進めた局面の評価値(me 視点)。plies は残りの読みの深さ。
  function searchChild(s, ins, me, plies, o, alpha, beta) {
    const c = Engine.clone(s);
    Engine.applyInstruction(c, ins);
    Engine.startTurn(c);
    if (c.winner !== null) return (c.winner === me ? 1 : -1) * (WIN + plies);
    promoteAll(c);
    return searchNode(c, me, plies, o, alpha, beta);
  }

  // s は手番側の指示フェーズ。両者が上位 beam 個の指示から最善を選ぶと仮定して読む。
  function searchNode(s, me, plies, o, alpha, beta) {
    if (plies === 0) {
      const c = Engine.clone(s);
      Engine.applyInstruction(c, PASS);
      return rollout(c, me, o.depth);
    }
    const maximizing = s.turn === me;
    let best = maximizing ? -Infinity : Infinity;
    for (const cand of scoreMoves(s, s.turn, o.depth).slice(0, o.beam)) {
      const v = searchChild(s, cand.ins, me, plies - 1, o, alpha, beta);
      if (maximizing) {
        if (v > best) best = v;
        if (best > alpha) alpha = best;
      } else {
        if (v < best) best = v;
        if (best < beta) beta = best;
      }
      if (alpha >= beta) break;
    }
    return best;
  }

  // 自分の指示 → 相手の応手 → 自分の受け…と plies 手先まで読む
  function chooseSearch(s, o) {
    const me = s.turn;
    const scored = scoreMoves(s, me, o.depth);
    for (const cand of scored) cand.score += Math.random() * o.noise;
    scored.sort((a, b) => b.score - a.score);
    let best = null;
    const consider = (cand) => {
      const v = searchChild(s, cand.ins, me, o.plies - 1, o, best ? best.v : -Infinity, Infinity);
      if (!best || v > best.v) best = { ins: cand.ins, v };
    };
    scored.slice(0, o.beam).forEach(consider);
    if (best.v < -WIN / 2) scored.slice(o.beam, MAX_FALLBACK).forEach(consider);
    return best.ins;
  }

  function choose(s, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    if (o.plies) return chooseSearch(s, o);
    const me = s.turn;
    const scored = Engine.listInstructions(s).map((ins) => {
      const c = Engine.clone(s);
      Engine.applyInstruction(c, ins);
      return { ins, score: rollout(c, me, o.depth) + Math.random() * o.noise };
    });
    scored.sort((a, b) => b.score - a.score);
    if (!o.top) return scored[0].ins;

    let best = null;
    const consider = (cand) => {
      const total = worstReply(s, me, cand.ins, o.depth - 1) + 0.05 * cand.score;
      if (!best || total > best.total) best = { ins: cand.ins, total };
    };
    scored.slice(0, o.top).forEach(consider);
    // 上位候補がすべて玉を取られる筋なら、残りの候補からも逃げ道を探す
    if (best.total < -WIN / 2) scored.slice(o.top, MAX_FALLBACK).forEach(consider);
    return best.ins;
  }

  return { choose, evaluate, LEVELS, DEFAULT_LEVEL };
});
