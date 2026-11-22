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

// 間引いても、投球の検知は遅れない。実際の撮影ループと同じく、
//   推定に procMs かかる → 待ち(idleDelay)→ その後の最初のカメラのコマ、の順で次の推定が走る、として確かめる。
// (以前は 30fps のカメラで、後方撮影の動き量が計算できる枚数に届かず、検知しなくなった)
import { ThrowDetector } from '../js/detector.js';
import { idleDelay } from '../js/power.js';
const walk = (view, fps, procMs, throttle) => {
  const det = new ThrowDetector({ view });
  const gov = new RateGovernor();
  gov.reset(-10);
  const cfg = det.config, sig = view === 'rear' ? cfg.rearStartSlope : cfg.startSpeed;
  const nextFrame = (s) => Math.ceil(s * fps - 1e-9) / fps;
  let t = 0, startedAt = null, n = 0, idleN = 0;
  while (t < 12) {
    const moving = t >= 6;                           // 6 秒に助走が始まる
    const x = view === 'side' ? 0.2 + (moving ? (t - 6) * 0.6 : 0) : 0.5;
    const size = view === 'rear' ? 0.3 * Math.exp(moving ? -(t - 6) * 0.4 : 0) : 0.3;
    const frame = { j: {
      leftShoulder: { x: x - 0.05, y: 0.30 }, rightShoulder: { x: x + 0.05, y: 0.30 },
      leftHip: { x: x - 0.04, y: 0.30 + size }, rightHip: { x: x + 0.04, y: 0.30 + size },
    } };
    const ev = det.process(frame, t);
    if (ev && ev.type === 'started' && startedAt === null) startedAt = ev.at;
    const wait = throttle ? gov.next(t, { active: det.isActive, motion: Math.abs(det.signal) / sig }) : 0;
    if (t > 3 && t < 6) { n++; if (wait) idleN++; }
    const done = t + procMs / 1000;
    const fire = done + (wait ? idleDelay(wait, procMs) : 0) / 1000;
    t = Math.max(nextFrame(fire), nextFrame(t + 1e-6));   // 同じコマは二度処理しない
  }
  return { startedAt, idleRate: n / 3, throttled: idleN > n * 0.8 };
};
for (const view of ['side', 'rear']) for (const fps of [30, 60]) for (const procMs of [5, 25]) {
  const label = `${view} ${fps}fps proc${procMs}ms`;
  const full = walk(view, fps, procMs, false).startedAt;
  assert.ok(full !== null && full >= 6, label + ': detects (reference)');
  const r = walk(view, fps, procMs, true);
  assert.ok(r.throttled, label + ': idle is actually throttled');
  assert.ok(r.idleRate >= 14 && r.idleRate <= 22, `${label}: idle rate ${r.idleRate.toFixed(1)}/s`);
  assert.ok(r.startedAt !== null, label + ': still detects with throttling');
  assert.ok(Math.abs(r.startedAt - full) < 0.25, `${label}: start ${r.startedAt} vs full ${full}`);
}
// 人がいない・画面を見ていないとき(IdleWatch)
import { IdleWatch } from '../js/power.js';
const w = new IdleWatch({ recordHoldSec: 5 });
w.reset(0);
const opt = { sleepSec: 300, dimSec: 60 };
assert.equal(w.decide(1, opt).record, true);            // 始めは録画を回す
assert.equal(w.decide(5.1, opt).record, false);         // 5秒、人がいなければ止める
w.person(6);
assert.equal(w.decide(6, opt).record, true);            // 人が映ったら、すぐ再開
assert.equal(w.decide(10.9, opt).record, true);         // 少し見えなくなっても、5秒は回す(手前を人が横切るなど)
assert.equal(w.decide(11.1, opt).record, false);
assert.equal(w.decide(59, opt).dim, false);
assert.equal(w.decide(60, opt).dim, true);              // 1分触れなければ暗くする
w.touch(61);
assert.equal(w.decide(62, opt).dim, false);             // 触れたら戻る(次の1分を数え直す)
assert.equal(w.decide(305, opt).sleep, false);          // 人が最後に見えたのは6秒 → 306秒まで休止しない
assert.equal(w.decide(306, opt).sleep, true);
assert.equal(w.decide(306, { sleepSec: 0, dimSec: 0 }).sleep, false);   // 「しない」
assert.equal(w.decide(10000, { sleepSec: 0, dimSec: 0 }).dim, false);
// 確認前の姿勢(seen)でも、録画は再開する。ただし休止の判断には使わない(人と誤認したものでずっと起きていないように)
const w3 = new IdleWatch({ recordHoldSec: 5 }); w3.reset(0);
assert.equal(w3.decide(10, opt).record, false);
w3.seen(10);
assert.equal(w3.decide(10, opt).record, true);
for (let t = 10; t < 400; t += 1) w3.seen(t);
assert.equal(w3.decide(400, opt).sleep, true);
// 投球の最中・解析中は、人が見えなくても録画を止めず、休止もしない
const w2 = new IdleWatch(); w2.reset(0);
for (let t = 0; t < 400; t += 1) { const d = w2.decide(t, { busy: true, sleepSec: 300 }); assert.equal(d.record, true); assert.equal(d.sleep, false); }

// 録画の一時停止(ThrowRecorder.pause/resume): MediaRecorder の代わりを使う
class FakeRec {
  constructor() { this.state = 'inactive'; FakeRec.live.add(this); }
  start() { this.state = 'recording'; this.onstart && this.onstart(); }
  stop() { this.state = 'inactive'; FakeRec.live.delete(this); this.onstop && this.onstop(); }
}
FakeRec.live = new Set();
FakeRec.isTypeSupported = () => true;
globalThis.window = { MediaRecorder: FakeRec };
globalThis.MediaRecorder = FakeRec;
globalThis.performance ??= { now: () => Date.now() };
const { ThrowRecorder } = await import('../js/recorder.js');
const tr = new ThrowRecorder({});
tr.start();
assert.equal(FakeRec.live.size, 1);
tr.pause();
assert.equal(FakeRec.live.size, 0);                    // 止めたらエンコーダーは0本
assert.equal(tr.armed, false);
tr.resume();
assert.equal(FakeRec.live.size, 1);
assert.ok(tr.lock(performance.now() / 1000) !== null);
tr.pause();                                            // 確保中は止めない
assert.equal(FakeRec.live.size, 1);
await tr.finish();                                     // 終わったら次の待機録画をすぐ始める
assert.equal(FakeRec.live.size, 1);
tr.pause(); tr.resume(); tr.resume();                  // 二重に再開しても1本
assert.equal(FakeRec.live.size, 1);
tr.stop();
assert.equal(FakeRec.live.size, 0);
await tr.discard();                                    // 止めたあとに破棄しても、録画は始まらない
assert.equal(FakeRec.live.size, 0);
console.log('power OK');
