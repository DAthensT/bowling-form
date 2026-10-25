// 合成した「投球」と「ボールリターンへ戻る歩き」で検知器と解析器を確認する。 node web/test/sim.mjs
import assert from 'node:assert/strict';
import { ThrowDetector } from '../js/detector.js';
import { analyze } from '../js/analyzer.js';
import { compare, selectHistory, deviation } from '../js/trend.js';
import { metric, summarize } from '../js/analyzer.js';
import { whyNotPlausible } from '../js/presence.js';
import { focusItems, focusSummary, focusKeys, DEFAULT_FOCUS, FOCUS_OPTIONS } from '../js/focus.js';
import { PresenceFilter, isPlausiblePerson } from '../js/presence.js';
import { hipAxis, smoothAxes, toBody, angle3 } from '../js/body3d.js';
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

// ---------------------------------------------------------------- 3D(体の向きを基準にした測定)

// 体の模型(メートル)を、カメラに対して yaw だけ斜めに置いて、画像上の2D座標と3D座標の両方を作る。
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * view: 'rear' | 'side'。yawDeg: 体の進行方向が、カメラの基準の向き(後方=レーン方向 / 横=画面の左右)からずれている角度。
 * armOut: 投球腕の、肩に対する「体の外側」への真の横ずれ(m)。0 = 肩の真後ろ・真下を通る。負 = 内側(背負い)。
 */
function make3dThrow({ t0, view, yawDeg, hand = 'right', armOut = 0, leanDeg = 25, noise2 = 0, noise3 = 0, seed = 1, withWorld = true }) {
  const R = rng(seed), psi = (yawDeg * Math.PI) / 180, sg = hand === 'right' ? 1 : -1;
  const F = view === 'rear' ? [Math.sin(psi), 0, Math.cos(psi)] : [Math.cos(psi), 0, Math.sin(psi)];
  const U = [0, -1, 0];
  const L = cross(F, U); // 体の右
  const base = view === 'rear' ? [0, 0, 3] : [-2, 0, 4];
  const f = 0.9; // 焦点距離(画像幅=1 に対する比)
  const sf = 0.5 * Math.sin((leanDeg * Math.PI) / 180), su = 0.5 * Math.cos((leanDeg * Math.PI) / 180);
  const domName = hand === 'right' ? 'right' : 'left', othName = hand === 'right' ? 'left' : 'right';
  const ARM = 0.75;
  const frames = [];
  for (let i = 0; i < FPS * 6.2; i++) {
    const s = i / FPS;
    let walk = 0, phi;
    if (s < 1.5) phi = 60;
    else if (s < 3.7) {
      const p = (s - 1.5) / 2.2;
      walk = 4 * p * (2 - p);
      phi = p < 0.5 ? 60 + (-105 - 60) * (p / 0.5) : p < 0.85 ? -105 + 105 * ((p - 0.5) / 0.35) : 0 + 140 * ((p - 0.85) / 0.15);
    } else { walk = 4; phi = 140; }
    const ph = (phi * Math.PI) / 180;
    const domLat = sg * 0.2;
    const wristLat = domLat + sg * armOut;
    const body = {
      [`${domName}Shoulder`]: [domLat, sf, su], [`${othName}Shoulder`]: [-domLat, sf, su],
      [`${domName}Wrist`]: [wristLat, sf + ARM * Math.sin(ph), su - ARM * Math.cos(ph)],
      [`${domName}Elbow`]: [wristLat, sf + 0.4 * Math.sin(ph), su - 0.4 * Math.cos(ph)],
      leftHip: [-0.11, 0, 0], rightHip: [0.11, 0, 0],
      neck: [0, sf, su], nose: [0, sf + 0.03, su + 0.22],
      // スライド脚(投球腕と反対側)は膝を曲げて前へ(膝角度 130°)。もう片方は後ろ
      [`${othName}Knee`]: [-sg * 0.11, 0.322, -0.27], [`${othName}Ankle`]: [-sg * 0.11, 0.322, -0.69],
      [`${domName}Knee`]: [sg * 0.11, -0.1, -0.4], [`${domName}Ankle`]: [sg * 0.11, -0.3, -0.78]
    };
    const P = [base[0] + F[0] * walk, base[1], base[2] + F[2] * walk];
    const j = {}, w = {};
    for (const [k, [lat, fwd, up]] of Object.entries(body)) {
      const v = [lat * L[0] + fwd * F[0] + up * U[0], lat * L[1] + fwd * F[1] + up * U[1], lat * L[2] + fwd * F[2] + up * U[2]];
      const C = [P[0] + v[0], P[1] + v[1], P[2] + v[2]];
      j[k] = { x: 0.5 + (f * C[0]) / C[2] + noise2 * gauss(R), y: 0.5 + (f * C[1]) / C[2] + noise2 * gauss(R) };
      w[k] = { x: v[0] + noise3 * gauss(R), y: v[1] + noise3 * gauss(R), z: v[2] + 4 * noise3 * gauss(R) };
    }
    frames.push(withWorld ? { t: t0 + s, j, w } : { t: t0 + s, j });
  }
  return frames;
}
const metricVal = (rep, key) => (rep.metrics.find(m => m.key === key) || {}).value;
const run3d = (opts) => analyze({ frames: make3dThrow(opts), hand: opts.hand || 'right', throwStart: opts.t0 + 1.5, view: opts.view });

{
  // 体の座標系の作り方: 後方から見た体(yaw 0)では、体の右 = 画像の右、前 = カメラから遠ざかる向き
  const fr = make3dThrow({ t0: 0, view: 'rear', yawDeg: 0 })[10];
  const ax = hipAxis(fr.w);
  assert.ok(Math.abs(ax.x - 1) < 1e-6 && Math.abs(ax.z) < 1e-6, 'hip axis = image right for a rear view');
  const b = toBody(fr.w, ax);
  assert.ok(b.rightShoulder.lat > 0.19 && b.leftShoulder.lat < -0.19 && Math.abs(b.rightShoulder.up - 0.453) < 0.01, 'body frame coordinates');
  // 同じ体を45°斜めから見ても、体の座標は同じ(カメラの向きに依存しない)
  const fr2 = make3dThrow({ t0: 0, view: 'rear', yawDeg: 45 })[10];
  const b2 = toBody(fr2.w, hipAxis(fr2.w));
  assert.ok(Math.abs(b2.rightWrist.lat - b.rightWrist.lat) < 1e-6 && Math.abs(b2.rightWrist.fwd - b.rightWrist.fwd) < 1e-6, 'body coords are camera-independent');
  assert.equal(hipAxis({ leftHip: { x: 0, y: 0, z: 0 }, rightHip: { x: 0.01, y: 0, z: 0.01 } }), null, 'degenerate hip line');
  assert.ok(Math.abs(angle3({ lat: 0, fwd: 0, up: 0 }, { lat: 1, fwd: 0, up: 0 }, { lat: 0, fwd: 1, up: 0 }) - 90) < 1e-9);
}

{
  // 後方: 真っ直ぐ後ろへ引いた腕(真の横ずれ 0)は、進入角度が違っても、3D なら 0 付近に測れる。2D は角度で偏る
  for (const yaw of [-25, -15, 0, 15, 25]) {
    const rep = run3d({ t0: 100, view: 'rear', yawDeg: yaw });
    assert.ok(rep.isValidThrow && rep.method === '3d', `3d used at yaw ${yaw}: ${rep.summary}`);
    assert.ok(Math.abs(metricVal(rep, 'backswingOffset')) < 0.15, `3D backswingOffset at yaw ${yaw}: ${metricVal(rep, 'backswingOffset')}`);
    assert.ok(Math.abs(metricVal(rep, 'releaseOffset')) < 0.15, `3D releaseOffset at yaw ${yaw}: ${metricVal(rep, 'releaseOffset')}`);
  }
  const strip = (fr) => fr.map(({ t, j }) => ({ t, j }));
  const two = (yaw) => analyze({ frames: strip(make3dThrow({ t0: 100, view: 'rear', yawDeg: yaw })), hand: 'right', throwStart: 101.5, view: 'rear' });
  const p = two(25), n = two(-25);
  assert.equal(p.method, '2d');
  const op = metricVal(p, 'backswingOffset'), on = metricVal(n, 'backswingOffset');
  console.log(`rear backswingOffset (true 0): 2D yaw+25=${op.toFixed(2)} yaw-25=${on.toFixed(2)} / 3D yaw+25=${metricVal(run3d({ t0: 100, view: 'rear', yawDeg: 25 }), 'backswingOffset').toFixed(2)}`);
  assert.ok(op < -0.2 && on > 0.2, '2D is biased by the approach angle (opposite signs)');
}

{
  // 背負い(腕が内側 = 真の横ずれ -0.16m = 肩幅比 -0.4)は、どの角度でも 3D で検出される
  for (const yaw of [-20, 0, 20]) {
    const rep = run3d({ t0: 200, view: 'rear', yawDeg: yaw, armOut: -0.16 });
    const m = rep.metrics.find(x => x.key === 'backswingOffset');
    assert.ok(m.value < -0.3 && m.dir === 'low' && m.status !== 'good', `carry detected at yaw ${yaw}: ${m.value}`);
  }
  // 左投げでも同じ(左右反転)
  for (const yaw of [-20, 20]) {
    const straight = run3d({ t0: 300, view: 'rear', yawDeg: yaw, hand: 'left' });
    assert.ok(Math.abs(metricVal(straight, 'backswingOffset')) < 0.15, `left-hander straight at yaw ${yaw}: ${metricVal(straight, 'backswingOffset')}`);
    const carry = run3d({ t0: 300, view: 'rear', yawDeg: yaw, hand: 'left', armOut: -0.16 });
    assert.ok(metricVal(carry, 'backswingOffset') < -0.3, 'left-hander carry');
  }
}

{
  // 横: 前傾(真値25°)と膝(真値130°)は、カメラとの角度がずれても 3D ならほぼ一定。2D は大きくずれる
  const row = [];
  for (const yaw of [0, 20, 40]) {
    const rep = run3d({ t0: 400, view: 'side', yawDeg: yaw });
    assert.ok(rep.isValidThrow && rep.method === '3d', `side 3d at yaw ${yaw}: ${rep.summary}`);
    row.push([yaw, metricVal(rep, 'trunkLean'), metricVal(rep, 'slideKnee')]);
    assert.ok(Math.abs(metricVal(rep, 'trunkLean') - 25) < 4, `3D lean at yaw ${yaw}: ${metricVal(rep, 'trunkLean')}`);
    assert.ok(Math.abs(metricVal(rep, 'slideKnee') - 130) < 6, `3D knee at yaw ${yaw}: ${metricVal(rep, 'slideKnee')}`);
  }
  const two40 = analyze({ frames: make3dThrow({ t0: 400, view: 'side', yawDeg: 40 }).map(({ t, j }) => ({ t, j })), hand: 'right', throwStart: 401.5, view: 'side' });
  console.log('side lean (true 25): 3D', row.map(r => `${r[0]}°:${r[1].toFixed(1)}`).join(' '), '/ 2D yaw40:', metricVal(two40, 'trunkLean').toFixed(1));
  assert.ok(Math.abs(metricVal(two40, 'trunkLean') - 25) > 4, '2D lean drifts at a large angle');
}

{
  // 3D の座標にぶれがあっても(横/縦 1cm、奥行き 4cm、2D も 0.3%)、後方の腕の位置は大きく外れない
  for (const yaw of [-20, 0, 20]) {
    const rep = run3d({ t0: 500, view: 'rear', yawDeg: yaw, noise2: 0.003, noise3: 0.01, seed: 7 + yaw });
    assert.ok(rep.isValidThrow && rep.method === '3d', `noisy 3d valid at yaw ${yaw}`);
    assert.ok(Math.abs(metricVal(rep, 'backswingOffset')) < 0.25, `noisy 3D backswingOffset at yaw ${yaw}: ${metricVal(rep, 'backswingOffset')}`);
  }
}

{
  // 3D 座標が足りないときは 2D に戻る。一部のフレームだけに 3D が付いていても 2D
  const full = make3dThrow({ t0: 600, view: 'rear', yawDeg: 0 });
  const partial = full.map((f, i) => (i % 2 ? { t: f.t, j: f.j } : f)); // 半分に 3D なし
  const rep = analyze({ frames: partial, hand: 'right', throwStart: 601.5, view: 'rear' });
  assert.equal(rep.method, '3d' === rep.method ? '3d' : '2d');
  assert.equal(rep.method, '2d', 'insufficient 3D coverage -> 2D');
  assert.deepEqual(rep.notes, [], 'no 3D attempt -> no note');

  // お手本の測定方式が違うときは適用しない(旧方式のお手本は 2D 扱い)
  const frames3 = make3dThrow({ t0: 700, view: 'rear', yawDeg: 0 });
  const old = { ranges: { backswingOffset: { good: [5, 6], ok: [4, 7] } }, stats: { backswingOffset: { mean: 5.5 } } }; // method なし = 2D
  const r3 = analyze({ frames: frames3, hand: 'right', throwStart: 701.5, view: 'rear', preset: old });
  assert.equal(r3.method, '3d');
  assert.equal(r3.presetSkipped, true, 'a 2D preset is not applied to a 3D analysis');
  assert.ok(r3.notes.some(n => n.includes('お手本は測定方式が違う')));
  assert.equal(r3.metrics.find(m => m.key === 'backswingOffset').target, '', 'no preset target shown');
  const same = analyze({ frames: frames3, hand: 'right', throwStart: 701.5, view: 'rear', preset: { ...old, method: '3d' } });
  assert.equal(same.presetSkipped, false);
  assert.ok(same.metrics.find(m => m.key === 'backswingOffset').target !== '');

  // 比較は同じ測定方式の履歴だけ
  const mkRec = (method, date) => ({ date, view: 'rear', hand: 'right', report: { isValidThrow: true, method, metrics: [] } });
  const sel = selectHistory([mkRec('3d', 1), mkRec('2d', 2), { date: 3, view: 'rear', hand: 'right', report: { isValidThrow: true, metrics: [] } }], { view: 'rear', hand: 'right', method: '3d' });
  assert.equal(sel.length, 1, 'only the same method is compared (no method = 2d)');
}

console.log('OK');
