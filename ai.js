// CPU。指示の候補を「以後は両者パス」で数手先まで進めて駒得で評価するのが基本。
// 上位の段階は、その評価を末端に使って相手の応手まで読む。
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
  // time: 指定すると持ち時間(ミリ秒)の範囲で深さを伸ばしながら読む(反復深化)。maxDepth: その上限 / qdepth: 末端で駒の取り合いを読む深さ
  // lmp1〜lmp4: 残り深さ1〜4以上の局面で読む「駒を取らない手」の数 / roDepth: 残り深さがこれ以上の局面で、駒を取らない手を数ターン動かした結果で並べる
  const DEFAULTS = {
    top: 10, depth: 4, noise: 0.2, plies: 0, beam: 14,
    time: 0, maxDepth: 12, qdepth: 3, lmp1: 6, lmp2: 10, lmp3: 16, lmp4: 24, roDepth: 1,
  };
  // 強さの段階。隣どうしを対戦させて、上の段階が勝ち越すことを確かめてある。
  const LEVELS = [
    { id: 'intro', name: '入門', opts: { top: 0, noise: 4 } },
    { id: 'weak', name: '弱い', opts: { top: 0 } },
    { id: 'normal', name: '普通', opts: {} },
    { id: 'strong', name: '強い', opts: { plies: 3, beam: 14 } },
    { id: 'top', name: 'とても強い', opts: { plies: 5, beam: 6 } },
    { id: 'master', name: '最強', opts: { time: 2000 } },
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

  // ---- 反復深化 + αβ探索 + 静止探索 ----
  // 局面は「手番側の指示フェーズ」(自動行動と成りが済んだ状態)。値はつねに手番側から見た評価(negamax)。
  // 指示した動きは相手の自動行動のあとに実行されるので、子局面は「指示 → 相手の自動行動」まで進めて作る。

  const ORDER_VALUE = { P: 1, L: 3, N: 3, S: 5, G: 6, B: 8, R: 10, K: 1000 };
  const TIMEOUT = { timeout: true };
  const EPS = 0.001;

  function insKey(ins) {
    if (ins.kind === 'move') return 'm' + ins.id + ':' + ins.dx + ',' + ins.dy + ',' + ins.n;
    if (ins.kind === 'stop') return 's' + ins.id;
    if (ins.kind === 'drop') return 'd' + ins.type + ins.x + ',' + ins.y;
    return 'p';
  }

  function makeChild(s, ins) {
    const c = Engine.clone(s);
    Engine.applyInstruction(c, ins);
    Engine.startTurn(c);
    if (c.winner === null) promoteAll(c);
    return c;
  }

  // 駒 p が (dx,dy) 方向へ最大 n マス進んだとき、今の盤面で最初に当たる敵駒
  function firstHit(s, p, dx, dy, n) {
    let x = p.x;
    let y = p.y;
    for (let i = 0; i < n; i++) {
      x += dx;
      y += dy;
      if (!Engine.inBoard(x, y)) return null;
      const t = s.board[y * 9 + x];
      if (t) return t.owner === p.owner ? null : t;
    }
    return null;
  }

  // side が新しい指示1つで次に届くマス(reach)と、side の走り駒が相手玉へ届く線上の空きマス(block)
  function reachMap(s, side) {
    const reach = new Uint8Array(81);
    const block = new Uint8Array(81);
    for (const p of s.board) {
      if (!p || p.owner !== side) continue;
      for (const d of Engine.moveDirs(p)) {
        const max = d.slide ? 8 : 1;
        let x = p.x;
        let y = p.y;
        const path = [];
        for (let i = 0; i < max; i++) {
          x += d.dx;
          y += d.dy;
          if (!Engine.inBoard(x, y)) break;
          const idx = y * 9 + x;
          const t = s.board[idx];
          if (t && t.owner === side) break;
          reach[idx] = 1;
          if (t) {
            if (t.type === 'K') for (const b of path) block[b] = 1;
            break;
          }
          path.push(idx);
        }
      }
    }
    return { reach, block };
  }

  function kingOf(s, side) {
    for (const p of s.board) if (p && p.owner === side && p.type === 'K') return p;
    return null;
  }

  // 静止探索で読む手: 今の盤面で最初の一歩が敵駒に当たる指示(当たる位置ちょうどのマス数で1つだけ)。
  // 玉が危ないときは、合駒と玉の移動も加える。
  function tacticalMoves(s, desperate) {
    const me = s.turn;
    const out = [];
    for (const p of s.board) {
      if (!p || p.owner !== me) continue;
      for (const d of Engine.moveDirs(p)) {
        const max = d.slide ? 8 : 1;
        let x = p.x;
        let y = p.y;
        for (let i = 1; i <= max; i++) {
          x += d.dx;
          y += d.dy;
          if (!Engine.inBoard(x, y)) break;
          const t = s.board[y * 9 + x];
          if (!t) continue;
          if (t.owner !== me) {
            out.push({ ins: { kind: 'move', id: p.id, dx: d.dx, dy: d.dy, n: i }, score: ORDER_VALUE[t.type] * 100 - ORDER_VALUE[p.type] });
          }
          break;
        }
        if (desperate && p.type === 'K' && Engine.inBoard(p.x + d.dx, p.y + d.dy)) {
          out.push({ ins: { kind: 'move', id: p.id, dx: d.dx, dy: d.dy, n: 1 }, score: 50 });
        }
      }
    }
    if (desperate) {
      const { block } = reachMap(s, 1 - me);
      for (const type of Engine.HAND_TYPES) {
        if (!s.hands[me][type]) continue;
        for (let i = 0; i < 81; i++) {
          if (block[i] && Engine.canDrop(s, type, i % 9, Math.floor(i / 9))) {
            out.push({ ins: { kind: 'drop', type, x: i % 9, y: Math.floor(i / 9) }, score: 60 - VALUE[type] });
          }
        }
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.map((m) => m.ins);
  }

  // 主探索の手の並べ替え。tactical の手は枝刈りしない。
  // 指示を出してから両者パスで数ターン進めたときの評価(指示した側から見た値)。並べ替えの目安に使う。
  function quickScore(s, ins, depth) {
    const c = Engine.clone(s);
    Engine.applyInstruction(c, ins);
    return rollout(c, s.turn, depth);
  }

  function orderedMoves(s, ttKey, hist, rolloutOrder) {
    const me = s.turn;
    const { reach, block } = reachMap(s, 1 - me);
    const king = kingOf(s, me);
    const danger = !!king && reach[king.y * 9 + king.x] === 1;
    const enemyKing = kingOf(s, 1 - me);
    const byId = new Map();
    for (const p of s.board) if (p) byId.set(p.id, p);
    const out = [];
    for (const ins of Engine.listInstructions(s)) {
      const key = insKey(ins);
      const h = hist.get(key) || 0;
      let score = h;
      let tactical = false;
      if (key === ttKey) {
        score = 1e9;
        tactical = true;
      } else if (ins.kind === 'move') {
        const p = byId.get(ins.id);
        const hit = firstHit(s, p, ins.dx, ins.dy, ins.n);
        if (hit) {
          tactical = true;
          score = hit.type === 'K' ? 1e8 : 1e6 + ORDER_VALUE[hit.type] * 1000 - ORDER_VALUE[p.type];
        } else if (p.type === 'K' && danger) {
          tactical = true;
          score = 3e5 + h;
        } else if (p.type !== 'K' && reach[p.y * 9 + p.x]) {
          score = 2e4 + ORDER_VALUE[p.type] * 100 + h; // 狙われている駒を逃がす
        }
      } else if (ins.kind === 'pass') {
        score = 1e4 + h;
      } else if (ins.kind === 'stop') {
        score = h - 5;
      } else if (ins.kind === 'drop') {
        if (danger && block[ins.y * 9 + ins.x]) {
          tactical = true;
          score = 2e5 + h;
        } else {
          score = h - 50;
          if (enemyKing && Math.abs(enemyKing.x - ins.x) <= 1 && Math.abs(enemyKing.y - ins.y) <= 2) score += 500;
        }
      }
      out.push({ ins, key, score, tactical, tie: Math.random() });
    }
    if (rolloutOrder) {
      // 静かな手(駒を取らない手)は、数ターン動かした結果の良い順に並べる。tactical な手は先頭のまま。
      for (const m of out) if (!m.tactical) m.score = 1e4 + quickScore(s, m.ins, rolloutOrder);
    }
    out.sort((a, b) => b.score - a.score || a.tie - b.tie);
    return out;
  }

  function lossValue(ply) {
    return -(WIN + 100 - ply);
  }

  function chooseIterative(s, o) {
    const start = Date.now();
    const deadline = start + o.time;
    const hist = new Map();
    const best = new Map(); // 読み筋(ルートからの指示列) → その局面で最善だった指示
    let nodes = 0;
    const lmp = (depth) => (depth <= 1 ? o.lmp1 : depth === 2 ? o.lmp2 : depth === 3 ? o.lmp3 : o.lmp4);

    const tick = () => {
      if ((++nodes & 127) === 0 && Date.now() > deadline) throw TIMEOUT;
    };

    const standPat = (st) => {
      const c = Engine.clone(st);
      Engine.applyInstruction(c, PASS);
      return rollout(c, st.turn, o.depth);
    };

    function qsearch(st, alpha, beta, qd, ply) {
      tick();
      const stand = standPat(st);
      if (qd === 0 || stand >= beta) return stand;
      let bestV = stand;
      if (stand > alpha) alpha = stand;
      for (const ins of tacticalMoves(st, stand <= -WIN / 2)) {
        const c = makeChild(st, ins);
        const v = c.winner !== null ? lossValue(ply) : -qsearch(c, -beta, -alpha, qd - 1, ply + 1);
        if (v > bestV) {
          bestV = v;
          if (v > alpha) alpha = v;
          if (alpha >= beta) break;
        }
      }
      return bestV;
    }

    function negamax(st, depth, alpha, beta, ply, path) {
      if (depth <= 0) return qsearch(st, alpha, beta, o.qdepth, ply);
      tick();
      let bestV = -Infinity;
      let bestKey = null;
      let quiet = 0;
      let i = 0;
      for (const m of orderedMoves(st, best.get(path), hist, depth >= o.roDepth ? o.depth : 0)) {
        if (!m.tactical && ++quiet > lmp(depth)) continue;
        const c = makeChild(st, m.ins);
        let v;
        if (c.winner !== null) {
          v = lossValue(ply);
        } else {
          const key = path + '|' + m.key;
          const r = depth >= 3 && i >= 3 && !m.tactical ? 1 : 0;
          if (i === 0) {
            v = -negamax(c, depth - 1, -beta, -alpha, ply + 1, key);
          } else {
            v = -negamax(c, depth - 1 - r, -alpha - EPS, -alpha, ply + 1, key);
            if (v > alpha && (r || v < beta)) v = -negamax(c, depth - 1, -beta, -alpha, ply + 1, key);
          }
        }
        i++;
        if (v > bestV) {
          bestV = v;
          bestKey = m.key;
        }
        if (v > alpha) alpha = v;
        if (alpha >= beta) {
          if (!m.tactical) hist.set(m.key, (hist.get(m.key) || 0) + depth * depth);
          break;
        }
      }
      if (bestKey) best.set(path, bestKey);
      return bestV;
    }

    let rootMoves = orderedMoves(s, null, hist, o.depth);
    let chosen = rootMoves[0];
    let completed = 0;
    for (let d = 1; d <= o.maxDepth; d++) {
      let alpha = -Infinity;
      let iterBest = null;
      const scores = new Map();
      try {
        let i = 0;
        for (const m of rootMoves) {
          const c = makeChild(s, m.ins);
          let v;
          if (c.winner !== null) {
            v = lossValue(0);
          } else {
            const r = d >= 3 && i >= 6 && !m.tactical ? 1 : 0;
            if (i === 0) {
              v = -negamax(c, d - 1, -Infinity, Infinity, 1, m.key);
            } else {
              v = -negamax(c, d - 1 - r, -alpha - EPS, -alpha, 1, m.key);
              if (v > alpha) v = -negamax(c, d - 1, -Infinity, -alpha, 1, m.key);
            }
          }
          scores.set(m.key, v);
          i++;
          if (v > alpha) {
            alpha = v;
            iterBest = m;
          }
        }
      } catch (e) {
        if (e !== TIMEOUT) throw e;
        // 前回の最善手を最初に読み終えていれば、それ以上の手が見つかった場合だけ採用する
        if (iterBest) chosen = iterBest;
        break;
      }
      chosen = iterBest;
      completed = d;
      // 次の反復では、今回の評価順に並べ直して読む
      rootMoves = rootMoves.slice().sort((a, b) => (scores.get(b.key) ?? -Infinity) - (scores.get(a.key) ?? -Infinity));
      // 勝ち負けを探索で読み切れたら終える。末端の見積もり(両者パス)で出た勝ち負けは WIN+depth 程度なので含めない。
      if (Math.abs(alpha) > WIN + 50) break;
      if (Date.now() - start > o.time * 0.5) break; // 次の反復は終わらない見込み
    }
    if (o.stats) o.stats.push({ depth: completed, nodes, ms: Date.now() - start });
    return chosen.ins;
  }

  function choose(s, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    if (o.time) return chooseIterative(s, o);
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
