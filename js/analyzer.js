// 2D 姿勢の時系列からフォーム指標を計算する (iOS 版 FormAnalyzer.swift の移植)。
// 座標は 0..1 に正規化、原点は左上(y は下向き)。時刻は秒。

export const SPECS = {
  trunkLean: {
    title: '上体の前傾', unit: '°', digits: 0, good: [15, 40], ok: [8, 50],
    low: '上体の前傾が浅いです。もう少し前に倒して、ボールを前へ押し出しましょう。',
    high: '前傾が深すぎます。胸を少し起こしてバランスを保ちましょう。'
  },
  slideKnee: {
    title: 'スライド脚の膝角度', unit: '°', digits: 0, good: [105, 150], ok: [90, 165],
    low: 'スライド脚の膝を曲げすぎです。もう少し高い姿勢でスライドしましょう。',
    high: 'スライド脚の膝が伸びています。膝をしっかり曲げて低く構えましょう。'
  },
  elbow: {
    title: 'リリース時の肘角度', unit: '°', digits: 0, good: [150, 180], ok: [130, 180],
    low: 'リリースで肘が曲がっています。腕をまっすぐ振り抜きましょう。', high: ''
  },
  backswingHeight: {
    title: 'バックスイングの高さ', unit: '', digits: 2, good: [0.4, 1.2], ok: [0.1, 1.5],
    low: 'バックスイングが低めです。腰より上までしっかり振り上げましょう。',
    high: 'バックスイングが高すぎます。腕の力を抜いて自然な高さに収めましょう。'
  },
  followThrough: {
    title: 'フォロースルーの高さ', unit: '', digits: 2, good: [0, 3], ok: [-0.4, 3],
    low: 'フォロースルーが低いです。リリース後は腕を肩の高さまで振り上げましょう。', high: ''
  },
  // ---- 後方撮影用 ----
  shoulderTilt: {
    title: 'リリース時の肩の傾き', unit: '°', digits: 0, good: [5, 30], ok: [0, 40],
    low: '肩がほぼ水平です(または投球側の肩が上がっています)。投球側の肩を少し下げると、腕が体の横を通りやすくなります。',
    high: '肩が傾きすぎです。上体が横に倒れてスライド脚側へ流れていないか確認しましょう。'
  },
  backswingOffset: {
    title: 'バックスイングの腕の位置(肩基準)', unit: '', digits: 2, good: [-0.3, 0.5], ok: [-0.6, 0.9],
    low: 'バックスイングで腕が体の内側(背中側)に入り、ボールを背負っています。肩の真後ろへ引きましょう。',
    high: 'バックスイングで腕が外側に開いています。肩の真後ろへまっすぐ引きましょう。'
  },
  releaseOffset: {
    title: '腕の通り道(肩基準)', unit: '', digits: 2, good: [-0.35, 0.35], ok: [-0.7, 0.7],
    low: '腕が体の内側に入っています(巻き込み)。肩の真下を通して振りましょう。',
    high: '腕が体の外側に開いています。肩の真下をまっすぐ振り抜きましょう。'
  },
  backswingBehind: {
    title: 'バックスイングで手が肩より後ろへ引かれる量', unit: '', digits: 2, good: [0, 0.8], ok: [-0.3, 1.1],
    low: 'バックスイングで手が肩より前にあります。もう少し後ろへ引きましょう。',
    high: 'ボールを背中側へ引きすぎています(背負い)。肩の真横〜やや後ろで止めましょう。'
  },
  armSeparation: {
    title: '腕の体からの離れ(スイング中の平均)', unit: '', digits: 2, good: [-0.15, 0.4], ok: [-0.45, 0.8],
    low: '腕が体の内側に入りがちです(巻き込み)。肩の真下を通しましょう。',
    high: '腕が体から離れています。肘を体の近くに保って振りましょう。'
  },
  approachDrift: {
    title: '助走の横ぶれ', unit: '', digits: 2, good: [0, 1.0], ok: [0, 2.0],
    low: '', high: '助走が横に流れています。ターゲットに向かってまっすぐ歩きましょう。'
  }
};

// プリセット作成時の許容幅の下限(tol)と、片側だけ制約する指標(side)
const EXTRA = {
  trunkLean: { tol: 4 }, slideKnee: { tol: 8 }, elbow: { tol: 6 }, backswingHeight: { tol: 0.15 },
  followThrough: { tol: 0.25, side: 'min' }, shoulderTilt: { tol: 4 }, backswingOffset: { tol: 0.15 },
  releaseOffset: { tol: 0.12 }, approachDrift: { tol: 0.3, side: 'max' },
  backswingBehind: { tol: 0.2 }, armSeparation: { tol: 0.15 }
};
for (const [k, v] of Object.entries(EXTRA)) Object.assign(SPECS[k], v);

const inRange = (v, [a, b]) => v >= a && v <= b;

// ユーザーが設定した判定基準(良い範囲の上書き)。優先順位: ユーザー設定 > お手本 > 初期値
let overrides = {};
export function setRangeOverrides(o) { overrides = o || {}; }

/** 指標の良い範囲/注意の範囲。 */
export function effectiveRange(key, preset = null) {
  const s = SPECS[key];
  const r = overrides[key] || (preset && preset.ranges && preset.ranges[key]);
  return r ? { good: r.good, ok: r.ok } : { good: s.good, ok: s.ok };
}

export function metric(key, value, preset) {
  const s = SPECS[key];
  const { good, ok } = effectiveRange(key, preset);
  const stat = preset && preset.stats && preset.stats[key];
  const target = stat ? stat.mean.toFixed(s.digits) + s.unit : '';
  let status = 'good';
  let advice = '';
  let dir = null; // 範囲の外にあるとき、下側(low)か上側(high)か
  if (!inRange(value, good)) {
    status = inRange(value, ok) ? 'warn' : 'bad';
    dir = value < good[0] ? 'low' : 'high';
    advice = value < good[0] ? s.low : s.high;
    if (advice && target) advice += `(お手本 ${target})`;
  }
  const f = (v) => v.toFixed(s.digits);
  const range = good[0] <= -1e8 ? `${f(good[1])}${s.unit}以下` : good[1] >= 1e8 ? `${f(good[0])}${s.unit}以上` : `${f(good[0])}〜${f(good[1])}${s.unit}`;
  return { key, title: s.title, value, display: value.toFixed(s.digits) + s.unit, status, advice, target, dir, range };
}

function info(key, title, value, unit) {
  return { key, title, value, display: value.toFixed(2) + unit, status: 'info', advice: '' };
}

export const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** b を頂点とする a-b-c の角度(度) */
function angleAt(b, a, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  return Math.abs(Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y)) * 180 / Math.PI;
}

function lean(shoulderMid, hipMid, direction) {
  const vx = (shoulderMid.x - hipMid.x) * direction;
  const vy = shoulderMid.y - hipMid.y;
  return Math.atan2(vx, -vy) * 180 / Math.PI;
}

/** 投球腕と、スライドする側(投球腕と反対側)の脚 */
export const CHAIN = {
  right: { shoulder: 'rightShoulder', elbow: 'rightElbow', wrist: 'rightWrist', hip: 'leftHip', knee: 'leftKnee', ankle: 'leftAnkle' },
  left: { shoulder: 'leftShoulder', elbow: 'leftElbow', wrist: 'leftWrist', hip: 'rightHip', knee: 'rightKnee', ankle: 'rightAnkle' }
};

/**
 * 手首・肘が一時的に取れなかったフレームを、前後の値から補う(短い欠けだけ)。
 * 腕が速く動く局面(特にフォロースルー)では確信度が下がって取れないことがあり、
 * そのフレームごと捨てると、その局面が丸ごと抜けてしまうため。
 */
function fillGaps(samples, keys, maxGap = 0.3) {
  for (const key of keys) {
    let i = 0;
    while (i < samples.length) {
      if (samples[i][key]) { i++; continue; }
      let j = i;
      while (j < samples.length && !samples[j][key]) j++;
      const a = i > 0 ? samples[i - 1] : null;
      const b = j < samples.length ? samples[j] : null;
      if (a && b && a[key] && b[key] && b.t - a.t <= maxGap) {
        for (let k = i; k < j; k++) {
          const u = (samples[k].t - a.t) / (b.t - a.t);
          samples[k][key] = { x: a[key].x + (b[key].x - a[key].x) * u, y: a[key].y + (b[key].y - a[key].y) * u };
          samples[k].interp = true;
        }
      }
      i = j;
    }
  }
}

/**
 * スイングの構造を決める。リリース = 手首が最も低い点。バックスイング頂点 = その直前(1.5秒以内)で最も高い点。
 * (全体で一番高い点を頂点にすると、リリース後のフォロースルーで腕が高く上がったとき、それを頂点と取り違える)
 */
function findSwing(s, wy) {
  let rel = 0;
  for (let i = 1; i < wy.length; i++) if (wy[i] > wy[rel]) rel = i;
  let back = -1;
  for (let i = 0; i < rel; i++) {
    if (s[rel].t - s[i].t > 1.5) continue;
    if (back < 0 || wy[i] < wy[back]) back = i;
  }
  return { back, rel };
}

/** リリース後の腕を検出できたフレームの数と時間幅(フォロースルーを測れたかの判断・診断用) */
function afterRelease(s, rel) {
  const after = s.slice(rel + 1);
  return { n: after.length, span: after.length ? after[after.length - 1].t - s[rel].t : 0 };
}

const FOLLOW_MIN_FRAMES = 4;
const FOLLOW_MIN_SPAN = 0.3;

function toSamples(frames, hand) {
  const c = CHAIN[hand];
  const out = [];
  for (const f of frames) {
    const j = f.j;
    if (!(j.leftShoulder && j.rightShoulder && j.leftHip && j.rightHip && j[c.shoulder])) continue;
    out.push({
      t: f.t,
      shoulderMid: mid(j.leftShoulder, j.rightShoulder),
      hipMid: mid(j.leftHip, j.rightHip),
      shoulder: j[c.shoulder], elbow: j[c.elbow] || null, wrist: j[c.wrist] || null,
      slideHip: j[c.hip], slideKnee: j[c.knee], slideAnkle: j[c.ankle]
    });
  }
  fillGaps(out, ['wrist', 'elbow']);
  return out.filter(x => x.wrist);
}

function smooth(v) {
  return v.map((_, i) => {
    const lo = Math.max(0, i - 1), hi = Math.min(v.length - 1, i + 1);
    let sum = 0;
    for (let k = lo; k <= hi; k++) sum += v[k];
    return sum / (hi - lo + 1);
  });
}

const OTHER_SHOULDER = { right: 'leftShoulder', left: 'rightShoulder' };

/** 後方から: 投球腕の肩を基準にした手首の横ずれ(肩幅で正規化、体の外側が正) */
function armOffset(dom, other, wrist) {
  const width = Math.max(Math.abs(dom.x - other.x), 0.02);
  const outward = dom.x >= other.x ? 1 : -1;
  return ((wrist.x - dom.x) * outward) / width;
}

function analyzeRear({ frames, hand, throwStart, preset }) {
  const M = (k, v) => metric(k, v, preset);
  const endTime = frames.length ? frames[frames.length - 1].t : throwStart;
  const invalid = (why) => ({
    isValidThrow: false, view: 'rear', metrics: [], startTime: throwStart, backswingTime: 0, releaseTime: 0, endTime, summary: why
  });
  const c = CHAIN[hand];
  const all = [];
  for (const f of frames) {
    const j = f.j;
    const dom = j[c.shoulder], other = j[OTHER_SHOULDER[hand]];
    if (!(dom && other && j.leftHip && j.rightHip)) continue;
    all.push({ t: f.t, dom, other, wrist: j[c.wrist] || null, shoulderMid: mid(dom, other), hipMid: mid(j.leftHip, j.rightHip) });
  }
  fillGaps(all, ['wrist']);
  const s = all.filter(x => x.wrist);
  if (s.length < 12 || s[s.length - 1].t - s[0].t < 0.8) return invalid('姿勢が十分に取得できませんでした。');

  // 助走中は距離が変わって大きさが変わるので、胴体の長さはフレームごとに正規化する
  const torsoAt = (x) => Math.max(dist(x.shoulderMid, x.hipMid), 0.02);
  const wy = smooth(s.map(x => (x.wrist.y - x.hipMid.y) / torsoAt(x)));
  const { back, rel } = findSwing(s, wy);
  if (back < 0) return invalid('バックスイングを検出できませんでした。');
  if (wy[rel] - wy[back] < 1.0 || rel - back < 3) return invalid('投球スイングとして認識できませんでした。');
  // 助走で奥へ遠ざかったか(胴体の見かけの大きさが十分に縮んだか)
  if (torsoAt(s[0]) / torsoAt(s[rel]) < 1.12) return invalid('助走(奥へ進む動き)が確認できませんでした。');

  const b = s[back], r = s[rel];
  const widths = s.map(x => Math.abs(x.dom.x - x.other.x)).sort((a, z) => a - z);
  const medWidth = Math.max(widths[Math.floor(widths.length / 2)], 0.02);
  const tiltDeg = Math.atan2(r.dom.y - r.other.y, Math.max(Math.abs(r.dom.x - r.other.x), 0.01)) * 180 / Math.PI;

  const metrics = [];
  metrics.push(M('backswingHeight', -wy[back]));
  metrics.push(M('backswingOffset', armOffset(b.dom, b.other, b.wrist)));
  metrics.push(M('releaseOffset', armOffset(r.dom, r.other, r.wrist)));
  let sep = 0;
  for (let i = back; i <= rel; i++) sep += armOffset(s[i].dom, s[i].other, s[i].wrist);
  metrics.push(M('armSeparation', sep / (rel - back + 1)));
  metrics.push(M('shoulderTilt', tiltDeg));
  const after = afterRelease(s, rel);
  const followMeasured = after.n >= FOLLOW_MIN_FRAMES && after.span >= FOLLOW_MIN_SPAN;
  if (followMeasured) {
    let follow = -Infinity;
    for (let i = rel; i < s.length; i++) follow = Math.max(follow, (s[i].shoulderMid.y - s[i].wrist.y) / torsoAt(s[i]));
    metrics.push(M('followThrough', follow));
  }
  metrics.push(M('approachDrift', Math.abs(r.hipMid.x - s[0].hipMid.x) / medWidth));
  metrics.push(info('approachTime', '助走開始〜リリース', Math.max(0, r.t - throwStart), '秒'));
  metrics.push(info('swingTime', 'バックスイング頂点〜リリース', r.t - b.t, '秒'));

  return { isValidThrow: true, view: 'rear', metrics, startTime: throwStart, backswingTime: b.t,
    releaseTime: r.t, endTime, summary: summarize(metrics),
    diag: { samples: s.length, interpolated: s.filter(x => x.interp).length, afterRelease: after.n, afterSpan: after.span, followMeasured } };
}

/** 全体の講評。exclude に指定した指標(重点項目で扱い済み)は除く。 */
export function summarize(metrics, exclude = []) {
  const issues = metrics
    .filter(m => !exclude.includes(m.key) && (m.status === 'bad' || m.status === 'warn'))
    .sort((a, b) => (a.status === 'bad' ? 0 : 1) - (b.status === 'bad' ? 0 : 1))
    .slice(0, 2);
  if (!issues.length) return exclude.length ? '' : '良いフォームです。この調子で続けましょう。';
  return issues.map(m => m.advice).join(' ');
}

export function analyze({ frames, hand, throwStart, view = 'side', preset = null }) {
  if (view === 'rear') return analyzeRear({ frames, hand, throwStart, preset });
  const M = (k, v) => metric(k, v, preset);
  const endTime = frames.length ? frames[frames.length - 1].t : throwStart;
  const invalid = (why) => ({
    isValidThrow: false, metrics: [], startTime: throwStart, backswingTime: 0, releaseTime: 0, endTime, summary: why
  });

  const s = toSamples(frames, hand);
  if (s.length < 12 || s[s.length - 1].t - s[0].t < 0.8) return invalid('姿勢が十分に取得できませんでした。');

  const torsos = s.map(x => dist(x.shoulderMid, x.hipMid)).sort((a, b) => a - b);
  const torso = Math.max(torsos[Math.floor(torsos.length / 2)], 0.05);

  // 腰を基準にした手首の高さ(下向きが正、胴体長で正規化)
  const wy = smooth(s.map(x => (x.wrist.y - x.hipMid.y) / torso));
  const { back, rel } = findSwing(s, wy);
  if (back < 0) return invalid('バックスイングを検出できませんでした。');
  if (wy[rel] - wy[back] < 1.0 || rel - back < 3) return invalid('投球スイングとして認識できませんでした。');
  // 助走で横方向に胴体の長さ以上動いたか
  if (Math.abs(s[rel].hipMid.x - s[0].hipMid.x) / torso < 1.0) return invalid('助走(前へ進む動き)が確認できませんでした。');

  const direction = s[rel].hipMid.x >= s[0].hipMid.x ? 1 : -1;
  const r = s[rel];
  const metrics = [];
  metrics.push(M('backswingHeight', -wy[back]));
  metrics.push(M('backswingBehind', ((s[back].shoulder.x - s[back].wrist.x) * direction) / torso));
  metrics.push(M('trunkLean', lean(r.shoulderMid, r.hipMid, direction)));
  if (r.slideHip && r.slideKnee && r.slideAnkle) metrics.push(M('slideKnee', angleAt(r.slideKnee, r.slideHip, r.slideAnkle)));
  if (r.elbow) metrics.push(M('elbow', Math.min(angleAt(r.elbow, r.shoulder, r.wrist), 180)));

  const after = afterRelease(s, rel);
  const followMeasured = after.n >= FOLLOW_MIN_FRAMES && after.span >= FOLLOW_MIN_SPAN;
  if (followMeasured) {
    let follow = -Infinity;
    for (let i = rel; i < s.length; i++) follow = Math.max(follow, (s[i].shoulder.y - s[i].wrist.y) / torso);
    metrics.push(M('followThrough', follow));
  }

  metrics.push(info('approachTime', '助走開始〜リリース', Math.max(0, s[rel].t - throwStart), '秒'));
  metrics.push(info('swingTime', 'バックスイング頂点〜リリース', s[rel].t - s[back].t, '秒'));

  return {
    isValidThrow: true, view: 'side', metrics, startTime: throwStart, backswingTime: s[back].t,
    releaseTime: s[rel].t, endTime, summary: summarize(metrics),
    diag: { samples: s.length, interpolated: s.filter(x => x.interp).length, afterRelease: after.n, afterSpan: after.span, followMeasured }
  };
}

/** 1フレームから取れるリアルタイム表示用の指標 */
export function instant(f, hand, direction, view = 'side', preset = null) {
  const M = (k, v) => metric(k, v, preset);
  const out = [];
  const j = f.j, c = CHAIN[hand];
  if (view === 'rear') {
    const dom = j[c.shoulder], other = j[OTHER_SHOULDER[hand]], wrist = j[c.wrist];
    if (dom && other) {
      out.push(M('shoulderTilt', Math.atan2(dom.y - other.y, Math.max(Math.abs(dom.x - other.x), 0.01)) * 180 / Math.PI));
      if (wrist) out.push(M('releaseOffset', armOffset(dom, other, wrist)));
    }
    return out;
  }
  if (j.leftShoulder && j.rightShoulder && j.leftHip && j.rightHip) {
    out.push(M('trunkLean', lean(mid(j.leftShoulder, j.rightShoulder), mid(j.leftHip, j.rightHip), direction)));
  }
  if (j[c.hip] && j[c.knee] && j[c.ankle]) out.push(M('slideKnee', angleAt(j[c.knee], j[c.hip], j[c.ankle])));
  if (j[c.shoulder] && j[c.elbow] && j[c.wrist]) out.push(M('elbow', Math.min(angleAt(j[c.elbow], j[c.shoulder], j[c.wrist]), 180)));
  return out;
}
