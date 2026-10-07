// 画面と操作。ルールは engine.js、CPU は ai.js。
(function () {
  'use strict';
  const E = window.Engine;
  const AI = window.AI;

  const GLYPH = { K: '王', R: '飛', B: '角', G: '金', S: '銀', N: '桂', L: '香', P: '歩' };
  const PROMO_GLYPH = { R: '竜', B: '馬', S: '全', N: '圭', L: '杏', P: 'と' };
  const NAME = { K: '玉', R: '飛', B: '角', G: '金', S: '銀', N: '桂', L: '香', P: '歩' };
  const PROMO_NAME = { R: '竜', B: '馬', S: '成銀', N: '成桂', L: '成香', P: 'と' };
  const RANKS = '一二三四五六七八九';
  const ARROWS = {
    '0,-1': '↑', '1,-1': '↗', '1,0': '→', '1,1': '↘',
    '0,1': '↓', '-1,1': '↙', '-1,0': '←', '-1,-1': '↖',
  };
  const SIDE = ['先手', '後手'];
  const MARK = ['▲', '△'];
  const SIDE_CLASS = ['sente', 'gote'];
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const $ = (id) => document.getElementById(id);
  const boardEl = $('board');
  const cellsEl = $('cells');
  const piecesEl = $('pieces');
  const marksEl = $('marks');
  const arrowsEl = $('arrows');
  const pieceEls = new Map();

  let state;
  let mode = 'cpu';
  let level = AI.DEFAULT_LEVEL;
  let sel = null; // {kind:'piece', id} | {kind:'hand', type}
  let targets = new Map(); // "x,y" -> 指示
  let history = [];
  let phaseStart = null; // 指示フェーズ開始時点のスナップショット
  let dirty = false; // このフェーズで成りを行ったか
  let busy = false;
  let log = [];
  let lastMoves = [];
  let gen = 0; // 進行中の非同期処理を打ち切るための世代番号
  let thinking = false; // CPUが指示を選んでいる最中か
  const SAVE_KEY = 'reserveShogi.save';

  const key = (x, y) => x + ',' + y;
  const sq = (x, y) => (9 - x) + RANKS[y];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const MODES = ['cpu', 'cpu-first', 'pvp'];
  const isCpu = (owner) => (mode === 'cpu' && owner === 1) || (mode === 'cpu-first' && owner === 0);
  // 自分が後手のときは盤を180度回し、自分の駒が手前に来るようにする
  const flipped = () => mode === 'cpu-first';
  const view = (v) => (flipped() ? 8 - v : v);
  const cpuOptions = () => (AI.LEVELS.find((l) => l.id === level) || AI.LEVELS[0]).opts;
  const pieceName = (type, promoted) => (promoted ? PROMO_NAME[type] : NAME[type]);

  function glyph(p) {
    if (p.promoted) return PROMO_GLYPH[p.type];
    if (p.type === 'K' && p.owner === 1) return '玉';
    return GLYPH[p.type];
  }

  function dirText(o) {
    const f = flipped() ? -1 : 1; // 矢印は画面上の向きに合わせる
    const a = ARROWS[key(Math.sign(o.dx) * f || 0, Math.sign(o.dy) * f || 0)];
    return o.n > 1 ? a + '×' + o.n : a;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ---- 棋譜 ----

  function addLog(text, cls) {
    log.push({ text, cls });
  }

  function logInstruction(owner, ins) {
    let text;
    if (ins.kind === 'pass') {
      text = 'パス';
    } else if (ins.kind === 'drop') {
      text = sq(ins.x, ins.y) + NAME[ins.type] + ' 打';
    } else {
      const p = E.findPiece(state, ins.id);
      const who = sq(p.x, p.y) + pieceName(p.type, p.promoted);
      text = ins.kind === 'stop' ? who + ' 停止' : who + ' ' + dirText(ins);
    }
    addLog((state.turnCount + 1) + '. ' + MARK[owner] + ' ' + text, SIDE_CLASS[owner]);
  }

  function logEvent(owner, e) {
    let text = '　' + MARK[owner] + ' ' + pieceName(e.type, e.wasPromoted) + ' ' + sq(e.from[0], e.from[1]) + '→' + sq(e.to[0], e.to[1]);
    if (e.captured) text += ' ' + pieceName(e.captured.type, e.captured.promoted) + 'を取る';
    if (e.forcedPromotion) text += ' 成';
    else if (e.stopped) text += '(盤端で停止)';
    addLog(text, 'auto');
  }

  // ---- CPUの思考 ----
  // 「最強」は1手に数秒かかることがあるので、画面が固まらないよう別スレッド(Web Worker)で考えさせる。
  // Worker が使えない環境では、その場で計算する(その間は画面が止まる)。

  let worker = null;
  let workerOk = null; // null: 未確認 / true: 使える / false: 使えない
  let pending = null; // 進行中の思考の resolve

  function startWorker() {
    return new Promise((resolve) => {
      let w;
      const fail = () => {
        if (w) w.terminate();
        resolve(null);
      };
      try {
        const parts = [...document.querySelectorAll('script[data-worker]')].map((sc) =>
          sc.src ? 'importScripts(' + JSON.stringify(sc.src) + ');\n' : sc.textContent + '\n'
        );
        parts.push('onmessage = (e) => postMessage({ ins: AI.choose(e.data.state, e.data.opts) }); postMessage({ ready: true });');
        w = new Worker(URL.createObjectURL(new Blob(parts, { type: 'text/javascript' })));
      } catch (e) {
        fail();
        return;
      }
      const timer = setTimeout(fail, 3000);
      w.onerror = () => {
        clearTimeout(timer);
        fail();
      };
      w.onmessage = (e) => {
        if (!e.data || !e.data.ready) return;
        clearTimeout(timer);
        resolve(w);
      };
    });
  }

  async function chooseCpu() {
    const snap = E.clone(state);
    const opts = cpuOptions();
    if (workerOk !== false && !worker) {
      worker = await startWorker();
      workerOk = !!worker;
    }
    if (!worker) return AI.choose(snap, opts);
    return new Promise((resolve) => {
      pending = resolve;
      const done = (ins) => {
        if (pending !== resolve) return;
        pending = null;
        resolve(ins);
      };
      worker.onmessage = (e) => done(e.data.ins);
      worker.onerror = () => {
        worker.terminate();
        worker = null;
        workerOk = false;
        done(AI.choose(snap, opts));
      };
      worker.postMessage({ state: snap, opts });
    });
  }

  // 対局をやり直すとき、考え中の Worker は捨てる(古い局面の答えを待たない)
  function cancelThinking() {
    thinking = false;
    if (!pending) return;
    const resolve = pending;
    pending = null;
    worker.terminate();
    worker = null;
    resolve(null);
  }

  // ---- 進行 ----

  function snapshot() {
    return { state: E.clone(state), logLen: log.length };
  }

  function restore(snap) {
    state = E.clone(snap.state);
    log.length = snap.logLen;
    lastMoves = [];
    clearSel();
  }

  function clearSel() {
    sel = null;
    targets = new Map();
  }

  // 再読み込みやページ更新をまたいで続きから指せるよう、指示待ちの局面を保存する
  function saveData() {
    if (!state) return null;
    if (state.winner !== null || !phaseStart) return { mode, level, state: E.clone(state), log: log.slice() };
    return { mode, level, state: phaseStart.state, log: log.slice(0, phaseStart.logLen) };
  }

  function persist() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(saveData()));
    } catch (e) {
      // 保存できない環境でもそのまま遊べる
    }
  }

  function resume(data) {
    gen++;
    cancelThinking();
    mode = MODES.includes(data.mode) ? data.mode : 'cpu';
    if (AI.LEVELS.some((l) => l.id === data.level)) level = data.level;
    $('mode').value = mode;
    $('level').value = level;
    state = E.clone(data.state);
    if (state.winner === null && isCpu(state.turn)) throw new Error('CPUの番の局面は再開できない');
    log = data.log.slice();
    history = [];
    lastMoves = [];
    clearSel();
    phaseStart = snapshot();
    dirty = false;
    busy = false;
    render();
  }

  function newGame() {
    gen++;
    cancelThinking();
    state = E.createInitialState();
    history = [];
    log = [];
    lastMoves = [];
    phaseStart = null;
    clearSel();
    beginTurn(gen);
  }

  // ターン開始: 予約行動を一斉に実行し、人間なら指示待ち、CPUなら指示まで進める
  async function beginTurn(token) {
    busy = true;
    const me = state.turn;
    const events = E.startTurn(state);
    lastMoves = events.filter((e) => e.moved);
    events.forEach((e) => logEvent(me, e));
    render();
    await sleep(lastMoves.length ? 420 : 120);
    if (token !== gen) return;

    if (state.winner === null) E.declareMate(state);
    if (state.winner !== null) {
      addLog((state.mate ? '詰み — ' : '') + SIDE[state.winner] + 'の勝ち', 'result');
      busy = false;
      persist();
      render();
      return;
    }

    if (isCpu(me)) {
      for (const id of state.promotable.slice()) doPromote(id);
      thinking = true;
      render();
      await sleep(200);
      if (token !== gen) return;
      const ins = await chooseCpu();
      if (token !== gen || !ins) return;
      thinking = false;
      logInstruction(me, ins);
      E.applyInstruction(state, ins);
      render();
      await sleep(250);
      if (token !== gen) return;
      return beginTurn(token);
    }

    phaseStart = snapshot();
    dirty = false;
    busy = false;
    persist();
    render();
  }

  function issue(ins) {
    if (busy || state.winner !== null) return;
    history.push(phaseStart);
    logInstruction(state.turn, ins);
    E.applyInstruction(state, ins);
    clearSel();
    beginTurn(gen);
  }

  function doPromote(id) {
    const p = E.findPiece(state, id);
    const before = sq(p.x, p.y) + pieceName(p.type, false);
    if (!E.promote(state, id)) return;
    addLog('　' + MARK[p.owner] + ' ' + before + ' 成', 'auto');
  }

  function undo() {
    if (busy) return;
    if (dirty) {
      restore(phaseStart);
      dirty = false;
    } else if (history.length) {
      phaseStart = history.pop();
      restore(phaseStart);
    }
    persist();
    render();
  }

  // ---- 操作 ----

  function selectPiece(p) {
    sel = { kind: 'piece', id: p.id };
    targets = new Map();
    for (const ins of E.pieceInstructions(state, p)) {
      targets.set(key(p.x + ins.dx * ins.n, p.y + ins.dy * ins.n), ins);
    }
  }

  function selectHand(type) {
    if (sel && sel.kind === 'hand' && sel.type === type) {
      clearSel();
      return;
    }
    sel = { kind: 'hand', type };
    targets = new Map();
    for (const ins of E.dropInstructions(state, type)) targets.set(key(ins.x, ins.y), ins);
  }

  function isCurrentOrder(ins) {
    if (ins.kind !== 'move') return false;
    const p = E.findPiece(state, ins.id);
    return !!p && E.sameOrder(p.order, ins);
  }

  function cellFromEvent(ev) {
    const r = cellsEl.getBoundingClientRect();
    const x = Math.floor(((ev.clientX - r.left) / r.width) * 9);
    const y = Math.floor(((ev.clientY - r.top) / r.height) * 9);
    return [view(Math.min(8, Math.max(0, x))), view(Math.min(8, Math.max(0, y)))];
  }

  // 指示先のマスは、味方の駒がいても指示を優先する(その駒がどくまで待機する指示になる)。
  // そのため指示先に当たっている味方へ選択を移すときは、いったん選択を外してから選び直す。
  function onBoardClick(ev) {
    if (busy || state.winner !== null) return;
    const [x, y] = cellFromEvent(ev);
    const p = E.at(state, x, y);
    const own = p && p.owner === state.turn;
    const t = targets.get(key(x, y));
    if (t) {
      if (!isCurrentOrder(t)) issue(t);
      return;
    }
    if (own && !(sel && sel.kind === 'piece' && sel.id === p.id)) selectPiece(p);
    else clearSel();
    render();
  }

  // ---- 描画 ----

  function buildBoard() {
    for (let i = 0; i < 81; i++) {
      const c = el('div', 'cell');
      const y = Math.floor(i / 9);
      if (y === 2 || y === 5) c.classList.add('zone-edge');
      cellsEl.appendChild(c);
    }
    for (let i = 0; i < 9; i++) {
      $('files').appendChild(el('span'));
      $('ranks').appendChild(el('span'));
    }
    for (const l of AI.LEVELS) {
      const o = el('option', '', l.name);
      o.value = l.id;
      $('level').appendChild(o);
    }
    $('level').value = level;
  }

  function renderFrame() {
    boardEl.classList.toggle('flipped', flipped());
    for (let i = 0; i < 9; i++) {
      $('files').children[i].textContent = String(9 - view(i));
      $('ranks').children[i].textContent = RANKS[view(i)];
    }
    $('levelLabel').hidden = mode === 'pvp';
  }

  function renderCells() {
    const from = new Set(lastMoves.map((e) => key(e.from[0], e.from[1])));
    const to = new Set(lastMoves.map((e) => key(e.to[0], e.to[1])));
    for (let i = 0; i < 81; i++) {
      const k = key(view(i % 9), view(Math.floor(i / 9)));
      cellsEl.children[i].classList.toggle('moved-from', from.has(k));
      cellsEl.children[i].classList.toggle('moved-to', to.has(k));
    }
  }

  function renderPieces() {
    const alive = new Set();
    const canAct = !busy && state.winner === null;
    for (const p of state.board) {
      if (!p) continue;
      alive.add(p.id);
      let node = pieceEls.get(p.id);
      if (!node) {
        node = el('div', 'piece');
        node.appendChild(el('div', 'face'));
        pieceEls.set(p.id, node);
        piecesEl.appendChild(node);
      }
      node.style.left = (view(p.x) * 100) / 9 + '%';
      node.style.top = (view(p.y) * 100) / 9 + '%';
      node.firstChild.textContent = glyph(p);
      node.className = 'piece ' + SIDE_CLASS[p.owner];
      node.classList.toggle('far', p.owner !== (flipped() ? 1 : 0));
      node.classList.toggle('promoted', p.promoted);
      node.classList.toggle('selected', !!sel && sel.kind === 'piece' && sel.id === p.id);
      node.classList.toggle('promotable', canAct && state.promotable.includes(p.id));
      node.classList.toggle('mated', !!state.mate && state.mate.kingId === p.id);
      node.classList.toggle('mating', !!state.mate && state.mate.attackerId === p.id);
    }
    for (const [id, node] of pieceEls) {
      if (!alive.has(id)) {
        node.remove();
        pieceEls.delete(id);
      }
    }
  }

  function renderArrows() {
    arrowsEl.textContent = '';
    for (const p of state.board) {
      if (!p || !p.order) continue;
      const { dx, dy, n } = p.order;
      // full: 指示どおりに進める最大マス数 / now: 今の盤面のままなら実際に進むマス数
      let full = 0;
      while (full < n && E.inBoard(p.x + dx * (full + 1), p.y + dy * (full + 1))) full++;
      let now = 0;
      while (now < full) {
        const t = E.at(state, p.x + dx * (now + 1), p.y + dy * (now + 1));
        if (t && t.owner === p.owner) break;
        now++;
        if (t) break;
      }
      const len = Math.hypot(dx, dy);
      const ux = dx / len;
      const uy = dy / len;
      const x1 = p.x + 0.5 + ux * 0.3;
      const y1 = p.y + 0.5 + uy * 0.3;
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'arrow ' + SIDE_CLASS[p.owner]);
      const addLine = (x2, y2, cls) => {
        const line = document.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', x1);
        line.setAttribute('y1', y1);
        line.setAttribute('x2', x2);
        line.setAttribute('y2', y2);
        if (cls) line.setAttribute('class', cls);
        g.appendChild(line);
      };
      if (now < full) {
        addLine(p.x + 0.5 + dx * full - ux * 0.2, p.y + 0.5 + dy * full - uy * 0.2, 'blocked');
      }
      if (now) {
        const tx = p.x + 0.5 + dx * now - ux * 0.08;
        const ty = p.y + 0.5 + dy * now - uy * 0.08;
        const head = 0.2;
        const bx = tx - ux * head;
        const by = ty - uy * head;
        addLine(bx, by);
        const tip = document.createElementNS(SVG_NS, 'polygon');
        const w = head * 0.55;
        tip.setAttribute('points', [
          tx + ',' + ty,
          (bx - uy * w) + ',' + (by + ux * w),
          (bx + uy * w) + ',' + (by - ux * w),
        ].join(' '));
        g.appendChild(tip);
      }
      arrowsEl.appendChild(g);
    }
  }

  function renderMarks() {
    marksEl.textContent = '';
    for (const [k, ins] of targets) {
      const [x, y] = k.split(',').map(Number);
      const m = el('div', 'mark');
      m.style.left = (view(x) * 100) / 9 + '%';
      m.style.top = (view(y) * 100) / 9 + '%';
      const p = E.at(state, x, y);
      if (p) m.classList.add('occupied', p.owner === state.turn ? 'ally' : 'enemy');
      if (isCurrentOrder(ins)) m.classList.add('current');
      marksEl.appendChild(m);
    }
  }

  function renderHands() {
    for (const owner of [0, 1]) {
      const box = $(owner === (flipped() ? 1 : 0) ? 'handBottom' : 'handTop');
      box.textContent = '';
      box.appendChild(el('span', 'who ' + SIDE_CLASS[owner], MARK[owner] + SIDE[owner] + (isCpu(owner) ? '(CPU)' : '') + ' 持ち駒'));
      const usable = !busy && state.winner === null && state.turn === owner && !isCpu(owner);
      let any = false;
      for (const type of E.HAND_TYPES) {
        const n = state.hands[owner][type];
        if (!n) continue;
        any = true;
        const b = el('button', '', GLYPH[type]);
        b.type = 'button';
        b.appendChild(el('span', 'n', '×' + n));
        b.disabled = !usable;
        if (usable && sel && sel.kind === 'hand' && sel.type === type) b.classList.add('selected');
        b.addEventListener('click', () => {
          selectHand(type);
          render();
        });
        box.appendChild(b);
      }
      if (!any) box.appendChild(el('span', 'none', 'なし'));
    }
  }

  function renderStatus() {
    const s = $('status');
    if (state.winner !== null) {
      s.className = 'status ' + SIDE_CLASS[state.winner];
      s.textContent = state.mate
        ? '詰み — ' + MARK[state.winner] + SIDE[state.winner] + 'の勝ち'
        : MARK[state.winner] + SIDE[state.winner] + 'の勝ち(玉を取りました)';
      return;
    }
    s.className = 'status ' + SIDE_CLASS[state.turn] + (thinking ? ' thinking' : '');
    const head = '第' + (state.turnCount + 1) + '手 ' + MARK[state.turn] + SIDE[state.turn];
    if (!isCpu(state.turn)) s.textContent = head + 'の番 — 指示を1つ出してください';
    else s.textContent = head + (thinking ? '(CPU)が考えています' : '(CPU)の番');
  }

  function renderPanel() {
    const panel = $('panel');
    panel.textContent = '';
    const canAct = !busy && state.winner === null;

    if (canAct && state.promotable.length) {
      const row = el('div', 'row');
      row.appendChild(el('span', '', '成れる駒(指示を消費しません):'));
      for (const id of state.promotable) {
        const p = E.findPiece(state, id);
        const b = el('button', 'primary', sq(p.x, p.y) + NAME[p.type] + ' を成る');
        b.type = 'button';
        b.addEventListener('click', () => {
          doPromote(id);
          dirty = true;
          clearSel();
          render();
        });
        row.appendChild(b);
      }
      panel.appendChild(row);
    }

    if (canAct && sel && sel.kind === 'piece') {
      const p = E.findPiece(state, sel.id);
      const row = el('div', 'row');
      const order = p.order ? '進行中 ' + dirText(p.order) : '静止';
      row.appendChild(el('span', '', sq(p.x, p.y) + pieceName(p.type, p.promoted) + ' — ' + order));
      if (p.order) {
        const b = el('button', '', '停止させる');
        b.type = 'button';
        b.addEventListener('click', () => issue({ kind: 'stop', id: p.id }));
        row.appendChild(b);
      }
      panel.appendChild(row);
      panel.appendChild(el('p', 'hint', '進める先のマスを選ぶと、毎ターンその動きを繰り返します。'));
      const allyTargets = [...targets.keys()].some((k) => {
        const [x, y] = k.split(',').map(Number);
        const q = E.at(state, x, y);
        return q && q.owner === state.turn;
      });
      if (allyTargets) {
        panel.appendChild(el('p', 'hint', '破線の丸は味方のいるマスです。選ぶと、その駒がどくまで待機する指示になります。そのマスの駒を選び直したいときは、選択中の駒をもう一度選んで選択を外してください。'));
      }
    } else if (canAct && sel && sel.kind === 'hand') {
      panel.appendChild(el('p', '', NAME[sel.type] + ' を打つマスをクリックしてください。'));
    } else if (canAct) {
      panel.appendChild(el('p', 'hint', '駒をクリックして方向を指示するか、持ち駒をクリックして打ちます。矢印は各駒が次のターンに進む予定を表します。'));
    } else if (state.winner !== null) {
      if (state.mate) {
        const k = E.findPiece(state, state.mate.kingId);
        const a = E.findPiece(state, state.mate.attackerId);
        panel.appendChild(el('p', '', sq(k.x, k.y) + 'の玉は、次の' + SIDE[state.winner] + 'の行動で' + sq(a.x, a.y) + 'の' + pieceName(a.type, a.promoted) + 'に取られます。どの指示を出しても防げません。'));
        panel.appendChild(el('p', 'hint', '「待った」で、詰みになる直前の指示に戻れます。「新規対局」で始め直せます。'));
      } else {
        panel.appendChild(el('p', '', '対局終了。「待った」で戻すか「新規対局」で始め直せます。'));
      }
    }
  }

  function renderLog() {
    const list = $('log');
    list.textContent = '';
    for (const entry of log) list.appendChild(el('li', entry.cls, entry.text));
    list.scrollTop = list.scrollHeight;
  }

  function render() {
    renderFrame();
    renderCells();
    renderPieces();
    renderArrows();
    renderMarks();
    renderHands();
    renderStatus();
    renderPanel();
    renderLog();
    $('pass').disabled = busy || state.winner !== null;
    $('undo').disabled = busy || (!dirty && !history.length);
  }

  // ---- 初期化 ----

  boardEl.addEventListener('click', onBoardClick);
  $('pass').addEventListener('click', () => issue({ kind: 'pass' }));
  $('undo').addEventListener('click', undo);
  $('newGame').addEventListener('click', newGame);
  $('mode').addEventListener('change', (ev) => {
    mode = ev.target.value;
    newGame();
  });
  // 強さの変更は次のCPUの手から効く(対局はそのまま続く)
  $('level').addEventListener('change', (ev) => {
    level = ev.target.value;
    persist();
  });

  function start(data) {
    let saved = data && data.state ? data : null;
    if (!saved) {
      try {
        saved = JSON.parse(localStorage.getItem(SAVE_KEY));
      } catch (e) {
        saved = null;
      }
    }
    try {
      if (saved && saved.state) {
        resume(saved);
        return;
      }
    } catch (e) {
      // 保存データが壊れていたら新しく始める
    }
    newGame();
  }

  buildBoard();
  // アーティファクトとして開かれている場合、ページ更新時に対局を引き継ぐ
  const hot = window.claude && window.claude.hot;
  if (hot && hot.snapshot) hot.snapshot(saveData);
  if (hot && hot.ready) hot.ready(start);
  else start((hot && hot.data) || {});
})();
