// 手番の有利不利を CPU 同士の対局で実測する。 node sim.js [1設定あたりの対局数]
'use strict';
const { fork } = require('child_process');
const os = require('os');
const E = require('./engine.js');
const AI = require('./ai.js');

const MAX_TURNS = 400; // これを超えたら引き分け扱い

// first: 先に指示を出す側(0=盤の下側, 1=上側)。上側を先番にした対局は、CPUや実装の向きによる偏りの対照。
const level = (id) => AI.LEVELS.find((l) => l.id === id).opts;
const CONFIGS = [
  { name: '弱い', ai: level('weak'), first: 0 },
  { name: '普通', ai: level('normal'), first: 0 },
  { name: '普通・上側が先番(対照)', ai: level('normal'), first: 1 },
  { name: '強い', ai: level('strong'), first: 0 },
];

function playGame(cfg) {
  const s = E.createInitialState();
  s.turn = cfg.first;
  let firstCapture = null;
  for (let t = 0; t < MAX_TURNS; t++) {
    const mover = s.turn;
    const events = E.startTurn(s);
    if (firstCapture === null && events.some((e) => e.captured)) firstCapture = mover;
    if (s.winner === null) E.declareMate(s);
    if (s.winner !== null) break;
    for (const id of s.promotable.slice()) E.promote(s, id);
    E.applyInstruction(s, AI.choose(s, cfg.ai));
  }
  return { winner: s.winner, turns: s.turnCount, firstCapture };
}

function runChunk(cfg, games) {
  const r = { first: 0, second: 0, draw: 0, turns: 0, capFirst: 0, capSecond: 0 };
  for (let g = 0; g < games; g++) {
    const res = playGame(cfg);
    if (res.winner === null) r.draw++;
    else if (res.winner === cfg.first) r.first++;
    else r.second++;
    r.turns += res.turns;
    if (res.firstCapture === cfg.first) r.capFirst++;
    else if (res.firstCapture !== null) r.capSecond++;
  }
  return r;
}

// 勝率の95%信頼区間(Wilson)
function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - h) / d, (c + h) / d];
}

if (process.argv[2] === '--worker') {
  const { cfg, games } = JSON.parse(process.argv[3]);
  process.send(runChunk(cfg, games));
} else {
  const total = parseInt(process.argv[2], 10) || 400;
  const workers = Math.max(1, os.cpus().length - 1);
  const chunk = Math.ceil(total / Math.min(workers, 8));
  const tasks = [];
  CONFIGS.forEach((cfg, i) => {
    for (let left = total; left > 0; left -= chunk) tasks.push({ i, cfg, games: Math.min(chunk, left) });
  });
  const sums = CONFIGS.map(() => ({ first: 0, second: 0, draw: 0, turns: 0, capFirst: 0, capSecond: 0 }));
  let running = 0;
  const started = Date.now();

  const report = () => {
    console.log(`\n${total}局ずつ / ${((Date.now() - started) / 1000).toFixed(0)}秒`);
    CONFIGS.forEach((cfg, i) => {
      const r = sums[i];
      const n = r.first + r.second + r.draw;
      const decided = r.first + r.second;
      const [lo, hi] = wilson(r.first, decided);
      const pct = (x) => (x * 100).toFixed(1) + '%';
      console.log(
        `${cfg.name}\n  先番 ${r.first}勝 / 後番 ${r.second}勝 / 引分 ${r.draw}` +
          `  先番勝率 ${pct(r.first / decided)} (95%CI ${pct(lo)}–${pct(hi)})` +
          `  平均 ${(r.turns / n).toFixed(0)}手` +
          `  最初に駒を取った側: 先番 ${pct(r.capFirst / (r.capFirst + r.capSecond))}`
      );
    });
  };

  const next = () => {
    if (!tasks.length) {
      if (!running) report();
      return;
    }
    const task = tasks.shift();
    running++;
    const child = fork(__filename, ['--worker', JSON.stringify({ cfg: task.cfg, games: task.games })]);
    child.on('message', (r) => {
      for (const k of Object.keys(r)) sums[task.i][k] += r[k];
    });
    child.on('exit', () => {
      running--;
      next();
    });
  };
  for (let w = 0; w < workers; w++) next();
}
