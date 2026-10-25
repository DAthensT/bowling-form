// 合成した「投球」と「ボールリターンへ戻る歩き」で検知器と解析器を確認する。 node web/test/sim.mjs
import assert from 'node:assert/strict';
import { ThrowDetector } from '../js/detector.js';
import { analyze } from '../js/analyzer.js';
import { rollPitch } from '../js/guides.js';
import { compare, selectHistory, deviation } from '../js/trend.js';
import { metric, summarize, setRangeOverrides, effectiveRange } from '../js/analyzer.js';
import { collectLabeled, suggestBoundary, applyBoundary, overrideFromInputs, okFromGood } from '../js/tuning.js';
import { summarizeStanding, laneForPoints, deriveThresholds } from '../js/calibration.js';
import { whyNotPlausible } from '../js/presence.js';
import { focusItems, focusSummary, focusKeys, DEFAULT_FOCUS, FOCUS_OPTIONS } from '../js/focus.js';
import { PresenceFilter, isPlausiblePerson } from '../js/presence.js';
import { pickTarget, inLaneRoi, roiHalfWidth, hipCenter } from '../js/target.js';
import { buildPreset, describePreset, validatePreset } from '../js/preset-model.js';

const TORSO = 0.2;
const FPS = 30;

function pose(t, hipX, wristRelY, wristRelX = 0.1) {
  const hipY = 0.6;
  const sh = { x: hipX + 0.03, y: hipY - TORSO };
  return {
    t,
    j: {
      leftShoulder: { x: sh.x - 0.01, y: sh.y }, rightShoulder: { x: sh.x + 0.01, y: sh.y },
      leftHip: { x: hipX - 0.01, y: hipY }, rightHip: { x: hipX + 0.01, y: hipY },
      rightElbow: { x: sh.x + wristRelX / 2, y: sh.y + (wristRelY * TORSO) / 2 },
      rightWrist: { x: sh.x + wristRelX, y: hipY + wristRelY * TORSO },
      leftKnee: { x: hipX + 0.04, y: hipY + 0.14 }, leftAnkle: { x: hipX + 0.02, y: hipY + 0.3 },
      nose: { x: sh.x + 0.02, y: sh.y - 0.06 }
    }
  };
}

/** 立ち止まり 1.5s → 助走 2.2s(スイングあり) → 停止 2.5s */
function makeThrow(t0, backY = -0.5, followY = -0.3) {
  const frames = [];
  for (let i = 0; i < FPS * 6.2; i++) {
    const t = t0 + i / FPS;
    const s = i / FPS;
    let hipX, wy;
    if (s < 1.5) { hipX = 0.2; wy = 0.3; }
    else if (s < 3.7) {
      const p = (s - 1.5) / 2.2;
      hipX = 0.2 + 0.5 * p * (2 - p); // 減速しながら進む
      // 0→0.5: 押し出し〜バックスイング頂点(-0.5)、0.5→0.85: リリース(+1.1)、以降フォロースルー(-0.3)
      wy = p < 0.5 ? 0.3 + (backY - 0.3) * (p / 0.5) : p < 0.85 ? backY + (1.1 - backY) * ((p - 0.5) / 0.35) : 1.1 + (followY - 1.1) * ((p - 0.85) / 0.15);
    } else { hipX = 0.7; wy = followY; }
    frames.push(pose(t, hipX, wy));
  }
  return frames;
}

function run(frames) {
  const d = new ThrowDetector();
  let started = null, ended = null;
  for (const f of frames) {
    const ev = d.process(f, f.t);
    if (ev && ev.type === 'started') started = ev.at;
    if (ev && ev.type === 'ended') ended = ev.at;
  }
  return { started, ended };
}

// 1) 投球を検知して解析できる
{
  const frames = makeThrow(100);
  const { started, ended } = run(frames);
  assert.ok(started !== null, 'started');
  assert.ok(ended !== null && ended > started, 'ended');
  const inRange = frames.filter(f => f.t >= started - 1 && f.t <= ended + 1);
  const report = analyze({ frames: inRange, hand: 'right', throwStart: started });
  console.log('throw:', { started, ended, valid: report.isValidThrow });
  console.log(report.metrics.map(m => `${m.title}=${m.display}(${m.status})`).join('\n'));
  console.log('summary:', report.summary);
  assert.ok(report.isValidThrow, 'valid throw');
  assert.ok(report.releaseTime > report.backswingTime, 'release after backswing');
}

// 2) 腕を振らずに歩いて戻るだけの動きは投球と認めない
{
  const frames = [];
  for (let i = 0; i < FPS * 4; i++) frames.push(pose(200 + i / FPS, 0.7 - 0.1 * (i / FPS), 0.6 + 0.1 * Math.sin(i / 5)));
  const { started, ended } = run(frames);
  const inRange = frames.filter(f => f.t >= (started ?? 200) && f.t <= (ended ?? 204));
  const report = analyze({ frames: inRange, hand: 'right', throwStart: started ?? 200 });
  console.log('walk-back:', { started, ended, valid: report.isValidThrow });
  assert.equal(report.isValidThrow, false, 'walking must not count as a throw');
}

// ---------------------------------------------------------------- 後方撮影

/** カメラから距離 d(m) の位置に立つ右投げの人物を後ろから見た姿勢。d が大きいほど小さく映る。 */
function rearPose(t, d, wy, armOut = 0.1, tiltDeg = 12) {
  const k = 3 / d;
  const torso = 0.3 * k, sw = 0.14 * k, hipY = 0.75 - 0.1 * (1 - k);
  const tilt = Math.tan((tiltDeg * Math.PI) / 180) * sw;
  const ls = { x: 0.5 - sw / 2, y: hipY - torso - tilt / 2 }; // 左肩(画面左)
  const rs = { x: 0.5 + sw / 2, y: hipY - torso + tilt / 2 }; // 右肩(画面右、投球側が下がる)
  return {
    t,
    j: {
      leftShoulder: ls, rightShoulder: rs,
      leftHip: { x: 0.5 - sw * 0.35, y: hipY }, rightHip: { x: 0.5 + sw * 0.35, y: hipY },
      rightWrist: { x: rs.x + armOut * sw, y: hipY + wy * torso },
      rightElbow: { x: rs.x + armOut * sw, y: (rs.y + hipY + wy * torso) / 2 },
      // 実際の姿勢推定と同様に、頭・膝・足首も含める(人物判定を通る形)
      nose: { x: 0.5, y: hipY - torso - 0.25 * torso },
      leftKnee: { x: 0.5 - sw * 0.3, y: hipY + 0.55 * torso }, rightKnee: { x: 0.5 + sw * 0.3, y: hipY + 0.55 * torso },
      leftAnkle: { x: 0.5 - sw * 0.3, y: hipY + 1.1 * torso }, rightAnkle: { x: 0.5 + sw * 0.3, y: hipY + 1.1 * torso }
    }
  };
}

function makeRearThrow(t0) {
  const frames = [];
  for (let i = 0; i < FPS * 6.2; i++) {
    const s = i / FPS, t = t0 + s;
    let d, wy;
    if (s < 1.5) { d = 3; wy = 0.3; }
    else if (s < 3.7) {
      const p = (s - 1.5) / 2.2;
      d = 3 + 4 * p * (2 - p); // 遠ざかりながら減速
      wy = p < 0.5 ? 0.3 - 0.8 * (p / 0.5) : p < 0.85 ? -0.5 + 1.6 * ((p - 0.5) / 0.35) : 1.1 - 1.4 * ((p - 0.85) / 0.15);
    } else { d = 7; wy = -0.3; }
    frames.push(rearPose(t, d, wy));
  }
  return frames;
}

function runRear(frames) {
  const d = new ThrowDetector({ view: 'rear' });
  let started = null, ended = null;
  for (const f of frames) {
    const ev = d.process(f, f.t);
    if (ev && ev.type === 'started') started = ev.at;
    if (ev && ev.type === 'ended') ended = ev.at;
  }
  return { started, ended };
}

// 3) 後方: 遠ざかる投球を検知して解析できる
{
  const frames = makeRearThrow(300);
  const { started, ended } = runRear(frames);
  assert.ok(started !== null && started < 303, 'rear started');
  assert.ok(ended !== null && ended > started, 'rear ended');
  const inRange = frames.filter(f => f.t >= started - 1 && f.t <= ended + 1);
  const report = analyze({ frames: inRange, hand: 'right', throwStart: started, view: 'rear' });
  console.log('rear throw:', { started, ended, valid: report.isValidThrow });
  console.log(report.metrics.map(m => `${m.title}=${m.display}(${m.status})`).join('\n'));
  assert.ok(report.isValidThrow, 'rear valid throw');
  assert.equal(report.view, 'rear');
  const tilt = report.metrics.find(m => m.key === 'shoulderTilt');
  assert.ok(tilt.value > 8 && tilt.value < 16, `shoulder tilt ~12deg, got ${tilt.value}`);
  assert.ok(!report.metrics.some(m => m.key === 'slideKnee' || m.key === 'trunkLean'), 'no side-only metrics');
}

// 4) 後方: カメラに向かって戻ってくる歩き(近づく)は検知しない
{
  const frames = [];
  for (let i = 0; i < FPS * 5; i++) frames.push(rearPose(400 + i / FPS, 7 - 0.8 * (i / FPS), 0.5));
  const { started } = runRear(frames);
  console.log('rear walk-back:', { started });
  assert.equal(started, null, 'approaching camera must not start');
}

// 5) 後方: 立ち止まったまま腕だけ動かしても検知しない
{
  const frames = [];
  for (let i = 0; i < FPS * 5; i++) frames.push(rearPose(500 + i / FPS, 4, 0.3 + 0.6 * Math.sin(i / 6)));
  assert.equal(runRear(frames).started, null, 'standing still must not start');
}

// ---------------------------------------------------------------- プリセット

function sideReport(t0, backY, followY = -0.3) {
  const frames = makeThrow(t0, backY, followY);
  const { started, ended } = run(frames);
  const inRange = frames.filter(f => f.t >= started - 1 && f.t <= ended + 1);
  return { frames: inRange, started, report: analyze({ frames: inRange, hand: 'right', throwStart: started }) };
}

// 6) 複数の投球から平均・ばらつき・良い範囲を作り、それを適用すると同じ投球は「良い」になる
{
  const throws = [-0.45, -0.5, -0.55].map((b, i) => sideReport(600 + i * 20, b));
  assert.ok(throws.every(t => t.report.isValidThrow));
  const preset = buildPreset({ name: 'テスト', view: 'side', hand: 'right', reports: throws.map(t => t.report) });
  assert.equal(preset.throwsCount, 3);
  assert.ok(validatePreset(JSON.parse(JSON.stringify(preset))), 'preset survives JSON round trip');
  const bh = preset.stats.backswingHeight;
  console.log('preset backswingHeight:', bh, preset.ranges.backswingHeight);
  assert.ok(bh.n === 3 && bh.sd > 0, 'sd computed');
  console.log(describePreset(preset).map(r => `${r.title}: ${r.mean} ${r.sd} → ${r.range}`).join('\n'));

  const again = analyze({ frames: throws[1].frames, hand: 'right', throwStart: throws[1].started, preset });
  const m = again.metrics.find(x => x.key === 'backswingHeight');
  assert.equal(m.status, 'good');
  assert.ok(m.target, 'target shown');

  // バックスイングが大きく違う投球はお手本の範囲から外れる
  const high = sideReport(700, -1.4);
  const off = analyze({ frames: high.frames, hand: 'right', throwStart: high.started, preset });
  const mo = off.metrics.find(x => x.key === 'backswingHeight');
  console.log('off-preset backswingHeight:', mo.display, mo.status, mo.advice);
  assert.notEqual(mo.status, 'good');
  assert.ok(mo.advice.includes('お手本'), 'advice mentions the reference');
}

// 7) 1投球だけでも既定の許容幅で範囲が作られる
{
  const t = sideReport(800, -0.5);
  const preset = buildPreset({ name: '1本', view: 'side', hand: 'right', reports: [t.report] });
  assert.equal(preset.stats.backswingHeight.sd, 0);
  const r = preset.ranges.backswingHeight.good;
  assert.ok(r[1] - r[0] > 0.2, 'minimum tolerance applied');
  const ft = preset.ranges.followThrough.good;
  assert.ok(ft[1] >= 1e9, 'one-sided range stays open');
}

// ---------------------------------------------------------------- 水平器
{
  const g = 9.8, deg = (d) => (d * Math.PI) / 180;
  const close = (a, b, eps = 0.01) => Math.abs(a - b) < eps;
  let r = rollPitch(g, 0, 0);
  assert.ok(close(r.roll, 0) && close(r.pitch, 0), 'level landscape');
  r = rollPitch(g * Math.cos(deg(3)), g * Math.sin(deg(3)), 0);
  assert.ok(close(r.roll, 3), `roll 3deg, got ${r.roll}`);
  // 反対向きの横持ち(重力が -x 方向)でも同じ大きさ・同じ折り返し
  r = rollPitch(-g * Math.cos(deg(3)), -g * Math.sin(deg(3)), 0);
  assert.ok(close(r.roll, 3), `roll folded for the other landscape, got ${r.roll}`);
  r = rollPitch(g * Math.cos(deg(4)), 0, g * Math.sin(deg(4)));
  assert.ok(close(r.pitch, 4) && close(r.roll, 0), `pitch 4deg, got ${r.pitch}`);
}

// ---------------------------------------------------------------- 人物の確認(誤検知対策)
{
  const person = pose(0, 0.5, 0.3).j;
  assert.ok(isPlausiblePerson(person), 'normal person is plausible');
  // 体がほぼ水平(横倒しの物)、極端に小さい物、関節が少ない物は人物とみなさない
  const lying = { ...person, leftShoulder: { x: 0.2, y: 0.6 }, rightShoulder: { x: 0.2, y: 0.62 } };
  assert.equal(isPlausiblePerson(lying), false, 'horizontal body');
  const tiny = Object.fromEntries(Object.entries(person).map(([k, v]) => [k, { x: 0.5 + (v.x - 0.5) * 0.1, y: 0.5 + (v.y - 0.6) * 0.1 }]));
  assert.equal(isPlausiblePerson(tiny), false, 'tiny body');
  assert.equal(isPlausiblePerson({ leftShoulder: person.leftShoulder, rightShoulder: person.rightShoulder, leftHip: person.leftHip, rightHip: person.rightHip }), false, 'too few joints');

  // 一瞬だけ・飛び飛びに出る「人らしきもの」は安定とみなさない
  let f = new PresenceFilter();
  let got = 0;
  for (let i = 0; i < 120; i++) {
    const t = 900 + i / 30;
    const spurious = i % 5 === 0 ? { t, j: pose(t, 0.2 + (i % 7) * 0.08, 0.3).j } : null; // 位置もばらばら
    if (f.update(spurious, t)) got++;
  }
  assert.equal(got, 0, 'flickering detections never become stable');

  // 同じ位置に出ても、飛び飛び(約6Hz)にしか出ないものは人物とみなさない
  f = new PresenceFilter();
  got = 0;
  for (let i = 0; i < 120; i++) {
    const t = 950 + i / 30;
    if (f.update(i % 5 === 0 ? { t, j: pose(t, 0.5, 0.3).j } : null, t)) got++;
  }
  assert.equal(got, 0, 'sparse detections at a fixed position never become stable');

  // 同じ場所に連続して出れば、一定枚数のあと安定する
  f = new PresenceFilter();
  const stableAt = [];
  for (let i = 0; i < 20; i++) { const t = 1000 + i / 30; if (f.update({ t, j: pose(t, 0.5, 0.3).j }, t)) stableAt.push(i); }
  assert.equal(stableAt[0], 5, 'stable after 6 consecutive frames');

  // 位置が急に飛んだら別物として数え直す
  const t0 = 1000 + 20 / 30;
  assert.equal(f.update({ t: t0, j: pose(t0, 0.9, 0.3).j }, t0), null, 'jump resets');

  // 検知器に渡る入力が全部 null なら何も起きない(人がいない場面)
  for (const view of ['side', 'rear']) {
    const d = new ThrowDetector({ view });
    for (let i = 0; i < 300; i++) assert.equal(d.process(null, 1100 + i / 30), null);
  }
}

// 8) 立ち止まったまま腕だけ大きく振っても、助走がなければ投球として認めない(解析側の検査)
{
  const frames = [];
  for (let i = 0; i < FPS * 5; i++) {
    const s = i / FPS;
    const wy = s < 1.5 ? 0.3 : s < 2.5 ? 0.3 - 0.8 * ((s - 1.5) / 1.0) : s < 3.2 ? -0.5 + 1.6 * ((s - 2.5) / 0.7) : 1.1 - 1.4 * Math.min(1, (s - 3.2) / 0.5);
    frames.push(pose(1200 + s, 0.5, wy));
  }
  const side = analyze({ frames, hand: 'right', throwStart: 1200, view: 'side' });
  assert.equal(side.isValidThrow, false, 'no approach (side)');
  const rframes = [];
  for (let i = 0; i < FPS * 5; i++) {
    const s = i / FPS;
    const wy = s < 1.5 ? 0.3 : s < 2.5 ? 0.3 - 0.8 * ((s - 1.5) / 1.0) : s < 3.2 ? -0.5 + 1.6 * ((s - 2.5) / 0.7) : 1.1 - 1.4 * Math.min(1, (s - 3.2) / 0.5);
    rframes.push(rearPose(1300 + s, 4, wy));
  }
  const rear = analyze({ frames: rframes, hand: 'right', throwStart: 1300, view: 'rear' });
  assert.equal(rear.isValidThrow, false, 'no approach (rear)');
}

// ---------------------------------------------------------------- 利用場所(自宅 / ボウリング場)
{
  const shift = (f, dx) => ({ t: f.t, j: Object.fromEntries(Object.entries(f.j).map(([k, p]) => [k, { x: p.x + dx, y: p.y }])) });
  const bowler = rearPose(0, 5, 0.3);                  // レーン中央、やや遠く(小さい)
  const neighbor = shift(rearPose(0, 3, 0.3), -0.35);  // 隣のレーン、近くて大きい
  const cands = [neighbor, bowler];
  const alley = { mode: 'alley', laneW: 0.30, vpY: 0.40, prev: null };

  // 自宅: 一番大きく映っている人。ボウリング場: 大きくてもレーン外の人は無視してレーン前の人だけ。
  assert.equal(pickTarget(cands, null), neighbor, 'home picks the biggest');
  assert.equal(inLaneRoi(neighbor.j, alley), false, 'neighbor outside lane region');
  assert.equal(inLaneRoi(bowler.j, alley), true, 'bowler inside lane region');
  assert.equal(pickTarget(cands, alley), bowler, 'alley picks the person in front of the lane');

  // レーン範囲に誰もいなければ何も選ばない(人がいない/隣の人しか映っていない)
  assert.equal(pickTarget([neighbor], alley), null, 'only a neighbor -> nobody');
  assert.equal(pickTarget([], alley), null);

  // 範囲内に複数いる場合は、直前まで追っていた人を優先する(中央に近い人に切り替わらない)
  const second = shift(rearPose(0, 5, 0.3), 0.12);
  const prev = hipCenter(second.j);
  assert.equal(pickTarget([bowler, second], { ...alley, prev }), second, 'keeps tracking the previous person');
  assert.equal(pickTarget([bowler, second], alley), bowler, 'first pick prefers the center');

  // 範囲は奥(消失点に近い)ほど狭く、手前(画面下)ほど広い
  assert.ok(roiHalfWidth(0.95, alley) > roiHalfWidth(0.6, alley) && roiHalfWidth(0.6, alley) > roiHalfWidth(0.3, alley));
}

// ---------------------------------------------------------------- 前の投球との比較
{
  const mk = (vals) => ({ isValidThrow: true, metrics: Object.entries(vals).map(([k, v]) => metric(k, v)) });
  // 目標は良い範囲の中央: 前傾 27.5° / 膝 127.5° / 肘 165°
  const prev = [ // 新しい順
    mk({ trunkLean: 6, slideKnee: 128, elbow: 165 }), mk({ trunkLean: 5, slideKnee: 127, elbow: 164 }),
    mk({ trunkLean: 7, slideKnee: 129, elbow: 166 }), mk({ trunkLean: 6, slideKnee: 126, elbow: 165 }),
    mk({ trunkLean: 5, slideKnee: 128, elbow: 165 })
  ];
  const cur = mk({ trunkLean: 26, slideKnee: 160, elbow: 165 });
  const c = compare(cur, prev);
  const by = Object.fromEntries(c.items.map(i => [i.key, i]));
  console.log('compare:', c.summary);
  assert.equal(c.n, 5);
  assert.equal(by.trunkLean.verdict, 'better', 'lean moved toward the target');
  assert.equal(by.slideKnee.verdict, 'worse', 'knee moved away from the target');
  assert.equal(by.elbow.verdict, 'same', 'elbow unchanged');
  assert.ok(c.summary.includes('良くなっています') && c.summary.includes('悪化しています'));
  assert.equal(compare(cur, []).n, 0, 'no history -> no comparison');

  // ぶれ程度の変化は改善/悪化と言わない
  const jitter = compare(mk({ trunkLean: 6.5, slideKnee: 127, elbow: 164 }), prev);
  assert.ok(jitter.items.every(i => i.verdict === 'same'), 'small changes are not a verdict');
  assert.ok(jitter.summary.includes('大きな変化はありません'));

  // 推移: 5,8,12,16,20 → 24 と改善し続けている / 逆なら悪化傾向。投球数が少ないと傾向は言わない
  const series = (arr) => arr.map(v => mk({ trunkLean: v })); // 古い順
  const up = compare(mk({ trunkLean: 24 }), series([5, 8, 12, 16, 20]).reverse());
  assert.equal(up.items[0].trend, 'improving');
  const down = compare(mk({ trunkLean: 5 }), series([24, 20, 16, 12, 8]).reverse());
  assert.equal(down.items[0].trend, 'declining');
  assert.equal(compare(mk({ trunkLean: 24 }), series([5, 8]).reverse()).items[0].trend, null, 'too few throws for a trend');

  // お手本があれば、その平均が目標になる(良い範囲の中央ではなく)
  const preset = { ranges: { trunkLean: { good: [8, 16], ok: [4, 20] } }, stats: { trunkLean: { mean: 12 } } };
  assert.ok(deviation('trunkLean', 12, preset) < deviation('trunkLean', 27.5, preset), 'preset target is used');

  // 履歴は同じ撮影位置・利き手の解析済みだけ、新しい順で使う
  const recs = [
    { date: 1, view: 'side', hand: 'right', report: mk({ trunkLean: 1 }) },
    { date: 3, view: 'side', hand: 'right', report: mk({ trunkLean: 3 }) },
    { date: 2, view: 'rear', hand: 'right', report: mk({ trunkLean: 2 }) },
    { date: 4, view: 'side', hand: 'left', report: mk({ trunkLean: 4 }) },
    { date: 5, hand: 'right', report: mk({ trunkLean: 5 }) } // view 未記録は side 扱い
  ];
  const sel = selectHistory(recs, { view: 'side', hand: 'right' });
  assert.deepEqual(sel.map(r => r.metrics[0].value), [5, 3, 1]);
}

// ---------------------------------------------------------------- 直したい点(重点項目)
{
  // 解析結果に、背負い/体からの離れを測る指標が含まれる
  const rearFrames = makeRearThrow(1500);
  const rr = runRear(rearFrames);
  const rrep = analyze({ frames: rearFrames.filter(f => f.t >= rr.started - 1 && f.t <= rr.ended + 1), hand: 'right', throwStart: rr.started, view: 'rear' });
  assert.ok(rrep.metrics.some(m => m.key === 'armSeparation'), 'rear has armSeparation');
  const srep = sideReport(1600, -0.5).report;
  assert.ok(srep.metrics.some(m => m.key === 'backswingBehind'), 'side has backswingBehind');

  const rear = (vals) => ({ view: 'rear', metrics: Object.entries(vals).map(([k, v]) => metric(k, v)) });
  const side = (vals) => ({ view: 'side', metrics: Object.entries(vals).map(([k, v]) => metric(k, v)) });

  // 背負い: 腕が内側(背中側)に入る → 問題。外側に開くのは「背負い」ではないので問題にしない
  let items = focusItems(rear({ backswingOffset: -0.9, armSeparation: 0.1, releaseOffset: 0.1 }), ['carry', 'away']);
  assert.equal(items.find(i => i.id === 'carry').status, 'bad', 'carrying the ball is flagged');
  assert.equal(items.find(i => i.id === 'away').status, 'good', 'arm not away from body');
  items = focusItems(rear({ backswingOffset: 1.2, armSeparation: 0.1, releaseOffset: 0.1 }), ['carry']);
  assert.equal(items[0].status, 'good', 'arm opening outward is not "carry"');

  // 体からの離れ: 外側に離れている → 問題。内側に入るのは「離れ」ではない
  items = focusItems(rear({ backswingOffset: 0.1, armSeparation: 0.9, releaseOffset: 0.8 }), ['away']);
  assert.equal(items[0].status, 'bad', 'arm away from body is flagged');
  items = focusItems(rear({ backswingOffset: 0.1, armSeparation: -0.7, releaseOffset: -0.6 }), ['away']);
  assert.equal(items[0].status, 'good', 'arm inside is not "away"');

  // 横撮影では「離れ」は判定できない(その旨を出す)。背負いは手首が肩より後ろへ引かれる量で見る
  items = focusItems(side({ backswingBehind: 1.6, trunkLean: 25 }), ['carry', 'away']);
  assert.equal(items.find(i => i.id === 'carry').status, 'bad', 'side carry: wrist pulled too far behind');
  assert.ok(items.find(i => i.id === 'away').unavailable.includes('後方'), 'away unavailable from the side');

  // 要約: 重点項目を先に、判定できない項目は含めない。全体の講評からは重点で扱った指標を除く
  items = focusItems(rear({ backswingOffset: -0.9, armSeparation: 0.1, releaseOffset: 0.1, shoulderTilt: 2 }), DEFAULT_FOCUS);
  const fs = focusSummary(items);
  assert.ok(fs.startsWith('重点項目。') && fs.includes('ボールを背負う癖') && fs.includes('投球時の体からの離れ: 問題ありません'), fs);
  const rest = summarize(rear({ backswingOffset: -0.9, armSeparation: 0.1, releaseOffset: 0.1, shoulderTilt: 2 }).metrics, focusKeys(items));
  assert.ok(rest.includes('肩'), 'general summary still covers other issues');
  assert.equal(summarize(rear({ backswingOffset: -0.9 }).metrics, ['backswingOffset']), '', 'nothing left after excluding focus metrics');
  console.log('focus summary:', fs);

  // 選択肢: 背負い・体からの離れ + 各指標
  assert.ok(FOCUS_OPTIONS.length >= 9 && DEFAULT_FOCUS.every(id => FOCUS_OPTIONS.some(o => o.id === id)));
}

// ---------------------------------------------------------------- キャリブレーション
{
  const shift = (f, dx) => ({ t: f.t, j: Object.fromEntries(Object.entries(f.j).map(([k, p]) => [k, { x: p.x + dx, y: p.y }])) });
  // 不自然と判断した理由が分かる(診断表示用)
  assert.equal(whyNotPlausible(rearPose(0, 5, 0.3).j), '');
  assert.ok(whyNotPlausible({ leftShoulder: { x: 0.4, y: 0.4 } }).includes('揃っていない'));

  // 立ち位置の登録: レーン中心が画面中央からずれていても、その位置を中心にできる
  const standing = [];
  for (let i = 0; i < 30; i++) standing.push(shift(rearPose(i / 30, 4, 0.3), 0.07));
  const stand = summarizeStanding(standing);
  assert.ok(Math.abs(stand.cx - 0.57) < 0.01, `cx ${stand.cx}`);
  assert.equal(summarizeStanding(standing.slice(0, 3)), null, 'too few frames');
  const laneW = laneForPoints([{ x: stand.cx, y: stand.cy, need: Math.max(stand.width * 2.5, 0.12) }], { cx: stand.cx, vpY: 0.4 });
  const cfg = { mode: 'alley', cx: stand.cx, laneW, vpY: 0.4 };
  assert.equal(inLaneRoi(standing[0].j, cfg), true, 'registered position is inside the lane region');
  assert.equal(inLaneRoi(shift(rearPose(0, 3, 0.3), -0.42).j, cfg), false, 'far-left neighbor stays outside');

  // 試し歩き: 遠ざかる速さの実測から検知しきい値を決め、それで投球を検知できる
  const walk = shift({ t: 0, j: {} }, 0); void walk;
  const walkFrames = makeRearThrow(2000).map(f => shift(f, 0.07));
  const th = deriveThresholds(walkFrames);
  console.log('calibrated thresholds:', { peak: th.peak.toFixed(3), start: th.startSlope.toFixed(3), end: th.endSlope.toFixed(3) });
  assert.ok(th.ok && th.peak > 0.1, 'walk measured');
  assert.ok(th.startSlope >= 0.04 && th.startSlope <= 0.15 && th.endSlope < th.startSlope, 'sane thresholds');
  const lane2 = laneForPoints([{ x: stand.cx, y: stand.cy, need: 0.12 }, ...th.path.map(p => ({ x: p.x, y: p.y, need: 0.12 }))], { cx: stand.cx, vpY: 0.4 });
  assert.ok(lane2 >= 0.15 && lane2 <= 0.48);
  const d = new ThrowDetector({ view: 'rear', rearStartSlope: th.startSlope, rearEndSlope: th.endSlope });
  let started = null, ended = null;
  for (const f of walkFrames) { const ev = d.process(f, f.t); if (ev && ev.type === 'started') started = ev.at; if (ev && ev.type === 'ended') ended = ev.at; }
  assert.ok(started !== null && ended !== null, 'calibrated detector detects the throw');
  assert.ok(d.signal !== undefined, 'signal exposed for diagnostics');

  // 動かない/近づく動きでは、しきい値を作れない
  const still = []; for (let i = 0; i < 90; i++) still.push(rearPose(2100 + i / 30, 4, 0.3));
  assert.equal(deriveThresholds(still).ok, false, 'no movement -> no thresholds');
  assert.equal(deriveThresholds(still.slice(0, 5)).ok, false, 'too few frames');
}

// ---------------------------------------------------------------- 判定基準の調整(肉眼ラベル)
{
  // 初期値では「背負い」と判定されない値(-0.1)が、肉眼では背負っている → 基準を調整できる
  const before = metric('backswingOffset', -0.1);
  assert.equal(before.status, 'good', 'default range misses a mild carry');
  assert.ok(before.range.includes('〜'), 'range text is exposed');

  // ラベル付きの投球(新しいものは意味なし。値だけを使う)
  const rec = (v, label) => ({ labels: { carry: label }, report: { metrics: [metric('backswingOffset', v)] } });
  const records = [rec(-0.10, 'bad'), rec(-0.02, 'bad'), rec(0.05, 'bad'), rec(0.35, 'ok'), rec(0.28, 'ok'), { report: { metrics: [metric('backswingOffset', 0.9)] } }];
  const c = collectLabeled(records, 'carry', 'backswingOffset');
  assert.deepEqual(c.bad.sort((a, b) => a - b), [-0.1, -0.02, 0.05]);
  assert.deepEqual(c.ok.sort((a, b) => a - b), [0.28, 0.35]);

  // 「悪い」と「問題なし」の間(0.05 と 0.28 の中間)を境目に提案する。小さい側が悪い(only: low)
  const sg = suggestBoundary({ key: 'backswingOffset', only: 'low', bad: c.bad, ok: c.ok });
  assert.ok(sg.ok && !sg.overlap && Math.abs(sg.boundary - 0.165) < 1e-9, `boundary ${sg.boundary}`);
  const ov = applyBoundary('backswingOffset', 'low', sg.boundary);
  assert.deepEqual(ov.good, [sg.boundary, 0.5], 'only the low side moves; the high side stays default');
  assert.ok(ov.ok[0] < ov.good[0], 'ok range is wider than the good range');

  // 適用すると、同じ値が「背負い(悪い側)」と判定される。解除すると元に戻る
  setRangeOverrides({ backswingOffset: ov });
  const after = metric('backswingOffset', -0.1);
  assert.ok(after.status !== 'good' && after.dir === 'low', 'now flagged as carrying');
  assert.equal(metric('backswingOffset', 0.3).status, 'good', 'the "ok" throws stay good');
  assert.deepEqual(effectiveRange('backswingOffset').good, ov.good);
  // 優先順位: ユーザー設定 > お手本
  const preset = { ranges: { backswingOffset: { good: [-5, 5], ok: [-9, 9] } } };
  assert.deepEqual(effectiveRange('backswingOffset', preset).good, ov.good, 'user override beats the preset');
  setRangeOverrides({});
  assert.deepEqual(effectiveRange('backswingOffset', preset).good, [-5, 5], 'preset applies without an override');
  assert.deepEqual(effectiveRange('backswingOffset').good, [-0.3, 0.5], 'default restored');

  // ラベルが重なる(区別できない)ときは、その旨を返す。片方だけなら余裕を持たせた目安
  const ov2 = suggestBoundary({ key: 'backswingOffset', only: 'low', bad: [0.2, 0.3], ok: [0.1, 0.25] });
  assert.equal(ov2.overlap, true);
  const only = suggestBoundary({ key: 'backswingOffset', only: 'low', bad: [-0.1, 0.0], ok: [] });
  assert.ok(only.onlyOneKind && only.boundary > 0.0, 'margin above the worst "bad"');
  const hi = suggestBoundary({ key: 'armSeparation', only: 'high', bad: [0.5, 0.7], ok: [0.1, 0.2] });
  assert.ok(Math.abs(hi.boundary - 0.35) < 1e-9, 'high-side boundary between 0.2 and 0.5');
  assert.deepEqual(applyBoundary('armSeparation', 'high', hi.boundary).good, [-0.15, hi.boundary]);
  assert.equal(suggestBoundary({ key: 'backswingOffset', only: 'low', bad: [], ok: [] }).ok, false);

  // 手動入力: 片側だけ入力でき、両方空欄なら上書きなし。逆順でも直す
  assert.equal(overrideFromInputs('backswingOffset', null, null), null);
  assert.deepEqual(overrideFromInputs('backswingOffset', 0.1, null).good, [0.1, 0.5]);
  assert.deepEqual(overrideFromInputs('backswingOffset', 0.9, 0.2).good, [0.2, 0.9]);
  assert.deepEqual(okFromGood('backswingOffset', [0, 0.5]), [-0.3, 0.8]);
}

// ---------------------------------------------------------------- フォロースルー
{
  // フォロースルーで手首がバックスイング頂点(-0.5)より高く、肩(-1.0)より上(-1.2)まで上がる現実的なフォーム
  const hi = sideReport(3000, -0.5, -1.2);
  assert.ok(hi.report.isValidThrow, `high follow-through must still be a valid throw: ${hi.report.summary}`);
  const bh = hi.report.metrics.find(m => m.key === 'backswingHeight');
  assert.ok(bh.value > 0.3 && bh.value < 0.7, `backswing top is not confused with the follow-through peak, got ${bh.value}`);
  const ft = hi.report.metrics.find(m => m.key === 'followThrough');
  assert.ok(ft && ft.value > 0.1 && ft.status === 'good', `follow-through measured, got ${ft && ft.value}`);
  assert.ok(hi.report.releaseTime > hi.report.backswingTime, 'release after the backswing top');
  assert.ok(hi.report.diag.afterRelease >= 10, 'frames after the release are used');
}

// 手首が一瞬取れなくても(腕が速く動く局面)、そのフレームごと捨てずに補って解析できる
{
  const full = makeThrow(3200, -0.5, -1.2);
  const run1 = run(full);
  const win = full.filter(f => f.t >= run1.started - 1 && f.t <= run1.ended + 1.5);
  const rel0 = analyze({ frames: win, hand: 'right', throwStart: run1.started });
  // リリース後の手首を、間欠的に欠けさせる(2フレーム欠け→1フレーム有り)
  let k = 0;
  const gappy = win.map(f => (f.t > rel0.releaseTime && (k++ % 3) !== 0) ? { t: f.t, j: { ...f.j, rightWrist: undefined } } : f);
  const g = analyze({ frames: gappy, hand: 'right', throwStart: run1.started });
  assert.ok(g.isValidThrow, 'still valid with intermittent wrist loss');
  assert.ok(g.diag.interpolated > 0, 'gaps were filled');
  const gft = g.metrics.find(m => m.key === 'followThrough');
  assert.ok(gft && gft.value > 0.1, 'follow-through still measured with gaps');

  // リリース後に手首がまったく取れなければ、「悪い」ではなく「測れなかった」(指標なし)にする
  const none = win.map(f => (f.t > rel0.releaseTime ? { t: f.t, j: { ...f.j, rightWrist: undefined, rightElbow: undefined } } : f));
  const n = analyze({ frames: none, hand: 'right', throwStart: run1.started });
  assert.ok(n.isValidThrow, 'the throw itself is still valid');
  assert.equal(n.metrics.some(m => m.key === 'followThrough'), false, 'not measurable -> no metric (not a false "bad")');
  assert.equal(n.diag.followMeasured, false);
  // 重点項目に「フォロースルー」を選んでいる場合は、判定できなかった旨が出る
  const fi = focusItems(n, ['followThrough'])[0];
  assert.ok(fi.unavailable && fi.unavailable.includes('判定できませんでした'), fi.unavailable);

  // 後方撮影でも、フォロースルーが高いフォームが捨てられない
  const rear = makeRearThrow(3400).map(f => f); // 既存の後方生成(フォロースルーは低め)
  const rr = runRear(rear);
  const rrep = analyze({ frames: rear.filter(f => f.t >= rr.started - 1 && f.t <= rr.ended + 1.5), hand: 'right', throwStart: rr.started, view: 'rear' });
  assert.ok(rrep.isValidThrow && rrep.diag.followMeasured, 'rear follow-through measured');
}

console.log('OK');
