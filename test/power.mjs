// 撮影中の省電力(js/power.js): 動きがないあいだは間引き、動きが出たらすぐ全コマに戻ること
import assert from 'node:assert/strict';
import { RateGovernor } from '../js/power.js';

const g = new RateGovernor({ idleMs: 50, holdSec: 1.5, motionFrac: 0.3 });
g.reset(0);
// 始めの2秒は全コマ
assert.equal(g.next(1, { active: false, motion: 0 }), 0);
// 動きがないまま2秒たつと、間引く
assert.equal(g.next(2.1, { active: false, motion: 0 }), 50);
assert.equal(g.isFull(2.1), false);
// しきい値の3割を超える動きが出たら、すぐ全コマ(しきい値に届く前)
assert.equal(g.next(10, { active: false, motion: 0.31 }), 0);
assert.equal(g.isFull(10), true);
// 動きが止まっても、1.5秒は全コマのまま(行ったり来たりしない)
assert.equal(g.next(11, { active: false, motion: 0 }), 0);
assert.equal(g.next(11.6, { active: false, motion: 0 }), 50);
// 投球の最中・解析中は、動きの量にかかわらず全コマ
for (let t = 20; t < 30; t += 0.5) assert.equal(g.next(t, { active: true, motion: 0 }), 0);
assert.equal(g.next(30.5, { active: false, motion: 0 }), 0);   // 終わった直後(1.5秒)は全コマ
assert.equal(g.next(31.1, { active: false, motion: 0 }), 50);
// 弱い動き(しきい値の3割以下)では、間引いたまま
assert.equal(g.next(40, { active: false, motion: 0.2 }), 50);

// 20回/秒でも、投球の検知は遅れない(間引いた状態から、助走の動きを検知する)
import { ThrowDetector } from '../js/detector.js';
const walk = (view, hz) => {
  const det = new ThrowDetector({ view });
  const gov = new RateGovernor();
  gov.reset(-10);
  let t = 0, startedAt = null, nextAt = 0;
  const cfg = det.config, sig = view === 'rear' ? cfg.rearStartSlope : cfg.startSpeed;
  for (let k = 0; k < 60 * 12; k++) {
    t = k / 60;
    if (t < nextAt) continue;                       // 間引き
    const moving = t >= 6;                           // 6 秒に助走が始まる
    const x = view === 'side' ? 0.2 + (moving ? (t - 6) * 0.6 : 0) : 0.5;
    const size = view === 'rear' ? 0.3 * Math.exp(moving ? -(t - 6) * 0.4 : 0) : 0.3;
    const frame = { j: {
      leftShoulder: { x: x - 0.05, y: 0.30 }, rightShoulder: { x: x + 0.05, y: 0.30 },
      leftHip: { x: x - 0.04, y: 0.30 + size }, rightHip: { x: x + 0.04, y: 0.30 + size },
    } };
    const ev = det.process(frame, t);
    if (ev && ev.type === 'started' && startedAt === null) startedAt = ev.at;
    const m = Math.abs(det.signal) / sig;
    nextAt = t + gov.next(t, { active: det.isActive, motion: m }) / 1000;
  }
  return startedAt;
};
for (const view of ['side', 'rear']) {
  const full = walk(view, 60);
  assert.ok(full !== null && full >= 6, view + ' detects (reference)');
  const t20 = walk(view, 20);
  assert.ok(t20 !== null, view + ' still detects with throttling');
  assert.ok(Math.abs(t20 - full) < 0.25, `${view}: start time with throttling (${t20}) close to full rate (${full})`);
}
console.log('power OK');
