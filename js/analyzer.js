import { hipAxis, smoothAxes, toBody, angle3, dist3, mid3 } from './body3d.js';

// 姿勢の時系列からフォーム指標を計算する (iOS 版 FormAnalyzer.swift の移植)。
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

/** 指標の良い範囲/注意の範囲。お手本があればその範囲、なければ初期値。 */
export function effectiveRange(key, preset = null) {
  const s = SPECS[key];
  const r = preset && preset.ranges && preset.ranges[key];
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
          const out = {};
          for (const p of Object.keys(a[key])) out[p] = a[key][p] + (b[key][p] - a[key][p]) * u;
          samples[k][key] = out;
          samples[k].interp = true;
        }
      }
      i = j;
    }
  }
}

/**
 * スイングの構造を決める。
 *  - リリース: 手首が最も低い付近(最大値から 0.3 以内)を「底」としてまとめ、そのあとフォロースルーで腕が上がる(0.5 以上)
 *    最後の底。構えのあとにも腕が一度下がる(振り子の底)ので、全体の最大だけで決めるとそれと取り違える。
 *  - 探す範囲: 助走が止まった時刻(throwEnd)+0.4秒まで。投球後の腕の動きを取り違えない。
 *  - バックスイング頂点: リリースの直前(1.5秒以内)で最も高い点。
 *    (全体で一番高い点を頂点にすると、リリース後のフォロースルーで腕が高く上がったとき、それを頂点と取り違える)
 */
function findSwing(s, wy, limitT = Infinity, manual = null) {
  // manual: {backswing?, release?}(秒、frames と同じ時間軸)。人が確認して指定した局面。指定があれば、自動検出より優先する。
  const nearest = (t) => {
    let b = 0;
    for (let i = 1; i < s.length; i++) if (Math.abs(s[i].t - t) < Math.abs(s[b].t - t)) b = i;
    return b;
  };
  const hasRel = !!manual && Number.isFinite(manual.release);
  const hasBack = !!manual && Number.isFinite(manual.backswing);

  let rel;
  if (hasRel) {
    rel = nearest(manual.release);
  } else {
    // リリースは助走の区間にある。投球後の腕の動き(下ろして持ち上げる)を、リリースと取り違えないよう、
    // limitT(助走の終わり + 余裕)までのフレームで探す。範囲が短すぎるときは制限しない。
    let lim = wy.length - 1;
    while (lim > 0 && s[lim].t > limitT) lim--;
    if (lim < 5) lim = wy.length - 1;
    const max = Math.max(...wy.slice(0, lim + 1));
    const thr = max - 0.3;
    const clusters = [];
    for (let i = 0; i <= lim;) {
      if (wy[i] < thr) { i++; continue; }
      let j = i, best = i;
      while (j <= lim && wy[j] >= thr) { if (wy[j] > wy[best]) best = j; j++; }
      clusters.push({ best, end: j - 1 });
      i = j;
    }
    const risen = (c) => c.end + 1 < wy.length && wy[c.best] - Math.min(...wy.slice(c.end + 1)) >= 0.5;
    const pick = [...clusters].reverse().find(risen)
      || clusters.reduce((b, c) => (wy[c.best] > wy[b.best] ? c : b));
    rel = pick.best;
  }

  let back = -1;
  if (hasBack) {
    back = nearest(manual.backswing);
  } else {
    for (let i = 0; i < rel; i++) {
      if (s[rel].t - s[i].t > 1.5) continue;
      if (back < 0 || wy[i] < wy[back]) back = i;
    }
  }
  return { back, rel, manual: hasRel || hasBack };
}

/**
 * リリースを探す範囲の上限(秒)。検知器が検知した「助走が止まり始めた時刻」+0.4秒。求まらなければ制限しない。
 * (注意) 後ろから撮った実際の映像では、検知器の「止まり始め」は、実際の停止より大きく遅れることがあり、
 * 投球後の腕の動きを除く効果は限定的。足首の動きから停止を求める方法も試したが、モデルごとの座標ぶれで安定しなかった。
 */
function approachLimit(s, throwStart, throwEnd) {
  const ok = throwEnd != null && throwEnd >= throwStart + 0.8;
  return { limit: ok ? throwEnd + 0.4 : Infinity, stop: ok ? throwEnd : null };
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

function analyzeRear({ frames, hand, throwStart, throwEnd, moments, preset }) {
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
  const win = approachLimit(s, throwStart, throwEnd);
  const { back, rel, manual } = findSwing(s, wy, win.limit, moments);
  if (back < 0) return invalid('バックスイングを検出できませんでした。');
  // 人が局面を指定したときは、スイングの大きさの検査と、助走の検査を省く(人の確認を優先する)
  if (manual ? rel - back < 2 : (wy[rel] - wy[back] < 1.0 || rel - back < 3)) return invalid('投球スイングとして認識できませんでした。');
  // 助走で奥へ遠ざかったか(胴体の見かけの大きさが十分に縮んだか)
  if (!manual && torsoAt(s[0]) / torsoAt(s[rel]) < 1.12) return invalid('助走(奥へ進む動き)が確認できませんでした。');

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
    releaseTime: r.t, endTime, summary: summarize(metrics), momentsSource: manual ? 'manual' : 'auto',
    diag: { samples: s.length, interpolated: s.filter(x => x.interp).length, afterRelease: after.n, afterSpan: after.span, followMeasured, stoppedAt: win.stop, searchLimit: Number.isFinite(win.limit) ? win.limit : null } };
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

function analyzeSide({ frames, hand, throwStart, throwEnd, moments, preset }) {
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
  const win = approachLimit(s, throwStart, throwEnd);
  const { back, rel, manual } = findSwing(s, wy, win.limit, moments);
  if (back < 0) return invalid('バックスイングを検出できませんでした。');
  // 人が局面を指定したときは、スイングの大きさの検査と、助走の検査を省く(人の確認を優先する)
  if (manual ? rel - back < 2 : (wy[rel] - wy[back] < 1.0 || rel - back < 3)) return invalid('投球スイングとして認識できませんでした。');
  // 助走で横方向に胴体の長さ以上動いたか
  if (!manual && Math.abs(s[rel].hipMid.x - s[0].hipMid.x) / torso < 1.0) return invalid('助走(前へ進む動き)が確認できませんでした。');

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
    releaseTime: s[rel].t, endTime, summary: summarize(metrics), momentsSource: manual ? 'manual' : 'auto',
    diag: { samples: s.length, interpolated: s.filter(x => x.interp).length, afterRelease: after.n, afterSpan: after.span, followMeasured, stoppedAt: win.stop, searchLimit: Number.isFinite(win.limit) ? win.limit : null }
  };
}


// ---------------------------------------------------------------- 3D(体の向きを基準にした測定)

/** 3D 座標(w)が十分なフレームに付いているか */
function hasWorld(frames) {
  const n = frames.filter(f => f.w).length;
  return n >= 12 && n >= 0.8 * frames.length;
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/**
 * 体の座標系(lat/fwd/up)で測る。カメラに対する体の向きによるずれが入らない。
 * 3D が足りない/スイングを検出できないときは null か無効な結果を返し、呼び出し側が2Dに切り替える。
 */
function analyzeBody({ frames, hand, throwStart, throwEnd, moments, view, preset }) {
  const M = (k, v) => metric(k, v, preset);
  const c = CHAIN[hand];
  const sgn = hand === 'right' ? 1 : -1; // 投球腕の「体の外側」= 右投げは +lat、左投げは -lat
  const endTime = frames.length ? frames[frames.length - 1].t : throwStart;
  const invalid = (why) => ({
    isValidThrow: false, view, method: '3d', metrics: [], startTime: throwStart, backswingTime: 0, releaseTime: 0, endTime, summary: why
  });

  const fr = frames.filter(f => f.w && f.j && f.w.leftHip && f.w.rightHip && f.w.leftShoulder && f.w.rightShoulder && f.w[c.shoulder]
    && f.j.leftHip && f.j.rightHip && f.j.leftShoulder && f.j.rightShoulder);
  if (fr.length < 12) return null;
  const axes = smoothAxes(fr.map(f => hipAxis(f.w)));
  if (axes.some(a => !a)) return null;
  const all = fr.map((f, i) => {
    const b = toBody(f.w, axes[i]);
    return { t: f.t, j: f.j, b, wrist: b[c.wrist] || null, elbow: b[c.elbow] || null };
  });
  fillGaps(all, ['wrist', 'elbow']);
  const s = all.filter(x => x.wrist);
  if (s.length < 12 || s[s.length - 1].t - s[0].t < 0.8) return null;

  const ZERO = { lat: 0, fwd: 0, up: 0 };
  const shMid = (x) => mid3(x.b.leftShoulder, x.b.rightShoulder);
  const torso3 = s.map(x => Math.max(dist3(shMid(x), ZERO), 0.1));     // 胴体の長さ(m)
  const dom = (x) => x.b[c.shoulder];
  const shW = (x) => Math.max(dist3(x.b.rightShoulder, x.b.leftShoulder), 0.15); // 肩幅(m)
  const upOf = (x, k) => (x.wrist.up - dom(x).up) / torso3[k];

  // 腰を基準にした手首の高さ(下向きが正、胴体長で正規化) — 2D と同じ向きの定義
  const wy = smooth(s.map((x, i) => -x.wrist.up / torso3[i]));
  const win = approachLimit(s, throwStart, throwEnd);
  const { back, rel, manual } = findSwing(s, wy, win.limit, moments);
  if (back < 0) return invalid('バックスイングを検出できませんでした。');
  // 人が局面を指定したときは、スイングの大きさの検査と、助走の検査を省く(人の確認を優先する)
  if (manual ? rel - back < 2 : (wy[rel] - wy[back] < 1.0 || rel - back < 3)) return invalid('投球スイングとして認識できませんでした。');

  // 助走の確認は画像上の動き(2D)で行う
  const t2 = (x) => Math.max(dist(mid(x.j.leftShoulder, x.j.rightShoulder), mid(x.j.leftHip, x.j.rightHip)), 0.02);
  const hip2 = (x) => mid(x.j.leftHip, x.j.rightHip);
  if (manual) {
    // 人が局面を指定したので、助走の検査は省く
  } else if (view === 'rear') {
    if (t2(s[0]) / t2(s[rel]) < 1.12) return invalid('助走(奥へ進む動き)が確認できませんでした。');
  } else if (Math.abs(hip2(s[rel]).x - hip2(s[0]).x) / Math.max(median(s.map(t2)), 0.05) < 1.0) {
    return invalid('助走(前へ進む動き)が確認できませんでした。');
  }

  // ぶれを抑えるため、基準の1フレームではなく、前後2フレームの中央値を使う
  const at = (i, fn) => median(Array.from({ length: Math.min(s.length - 1, i + 2) - Math.max(0, i - 2) + 1 }, (_, n) => {
    const k = Math.max(0, i - 2) + n;
    return fn(s[k], k);
  }));
  const offsetOf = (x) => ((x.wrist.lat - dom(x).lat) * sgn) / shW(x);
  const behindOf = (x, k) => (dom(x).fwd - x.wrist.fwd) / torso3[k];

  const metrics = [];
  metrics.push(M('backswingHeight', -wy[back]));
  if (view === 'rear') {
    metrics.push(M('backswingOffset', at(back, offsetOf)));
    metrics.push(M('releaseOffset', at(rel, offsetOf)));
    let sep = 0;
    for (let i = back; i <= rel; i++) sep += offsetOf(s[i]);
    metrics.push(M('armSeparation', sep / (rel - back + 1)));
    const other = (x) => x.b[OTHER_SHOULDER[hand]];
    metrics.push(M('shoulderTilt', at(rel, (x) => Math.atan2(other(x).up - dom(x).up, Math.max(Math.abs(dom(x).lat - other(x).lat), 0.02)) * 180 / Math.PI)));
    metrics.push(M('backswingBehind', at(back, behindOf)));
  } else {
    metrics.push(M('backswingBehind', at(back, behindOf)));
    metrics.push(M('trunkLean', at(rel, (x) => Math.atan2(shMid(x).fwd, shMid(x).up) * 180 / Math.PI)));
    if (s[rel].b[c.hip] && s[rel].b[c.knee] && s[rel].b[c.ankle]) {
      metrics.push(M('slideKnee', at(rel, (x) => (x.b[c.hip] && x.b[c.knee] && x.b[c.ankle] ? angle3(x.b[c.knee], x.b[c.hip], x.b[c.ankle]) : NaN))));
    }
    if (s[rel].elbow) metrics.push(M('elbow', at(rel, (x) => (x.elbow ? angle3(x.elbow, dom(x), x.wrist) : NaN))));
  }

  const after = afterRelease(s, rel);
  const followMeasured = after.n >= FOLLOW_MIN_FRAMES && after.span >= FOLLOW_MIN_SPAN;
  if (followMeasured) {
    let follow = -Infinity;
    for (let i = rel; i < s.length; i++) follow = Math.max(follow, upOf(s[i], i));
    metrics.push(M('followThrough', follow));
  }
  if (view === 'rear') {
    const widths2 = s.map(x => Math.abs(x.j[c.shoulder].x - x.j[OTHER_SHOULDER[hand]].x)).sort((a, z) => a - z);
    const medW = Math.max(widths2[Math.floor(widths2.length / 2)], 0.02);
    metrics.push(M('approachDrift', Math.abs(hip2(s[rel]).x - hip2(s[0]).x) / medW));
  }
  metrics.push(info('approachTime', '助走開始〜リリース', Math.max(0, s[rel].t - throwStart), '秒'));
  metrics.push(info('swingTime', 'バックスイング頂点〜リリース', s[rel].t - s[back].t, '秒'));

  return {
    isValidThrow: true, view, method: '3d', metrics, startTime: throwStart, backswingTime: s[back].t,
    releaseTime: s[rel].t, endTime, summary: summarize(metrics), momentsSource: manual ? 'manual' : 'auto',
    diag: { samples: s.length, interpolated: s.filter(x => x.interp).length, afterRelease: after.n, afterSpan: after.span, followMeasured, stoppedAt: win.stop, searchLimit: Number.isFinite(win.limit) ? win.limit : null }
  };
}

/**
 * 記録された解析結果の測定方式: '3d' | '2d' | 'legacy'。
 * legacy = 測定方式を記録する前の古い記録(当時は 2D だけ)。比較などでは 2D として扱う。
 */
export function measurementMethod(report) {
  if (!report || !report.method) return 'legacy';
  return report.method === '3d' ? '3d' : '2d';
}

/** お手本は、同じ測定方式で作ったものだけ使う(2D と 3D では値の意味が少し違う)。方式不明の古いものは 2D 扱い。 */
function presetFor(method, preset) {
  if (!preset) return { preset: null, skipped: false };
  const ok = (preset.method || '2d') === method;
  return { preset: ok ? preset : null, skipped: !ok };
}

/**
 * 解析の入口。3D(体の向き基準)で測れるときは3D、測れないとき(3D 座標が足りない・3D でスイングを検出できない)は
 * 従来の2D(画像上)で測る。report.method に使った方式が入る。
 */
export function analyze({ frames, hand, throwStart, throwEnd = null, moments = null, view = 'side', preset = null }) {
  const notes = [];
  let report = null;
  let skipped = false;
  const world = hasWorld(frames);
  if (world) {
    const p3 = presetFor('3d', preset);
    const body = analyzeBody({ frames, hand, throwStart, throwEnd, moments, view, preset: p3.preset });
    if (body && body.isValidThrow) { report = body; skipped = p3.skipped; }
    else notes.push('3D(体の向き基準)で測れなかったため、画像上の2D方式で測定しました。');
  }
  if (!report) {
    const p2 = presetFor('2d', preset);
    report = view === 'rear'
      ? analyzeRear({ frames, hand, throwStart, throwEnd, moments, preset: p2.preset })
      : analyzeSide({ frames, hand, throwStart, throwEnd, moments, preset: p2.preset });
    report.method = '2d';
    skipped = p2.skipped;
  }
  if (skipped) notes.push(`お手本は測定方式が違う(お手本: ${(preset.method || '2d').toUpperCase()} / 今回: ${report.method.toUpperCase()})ため適用していません。お手本を作り直してください。`);
  report.presetSkipped = skipped;
  report.notes = notes;
  return report;
}

/** 1フレームから取れるリアルタイム表示用の指標 */
export function instant(f, hand, direction, view = 'side', preset = null) {
  const out = [];
  const j = f.j, c = CHAIN[hand];
  const ax = f.w && hipAxis(f.w);
  if (ax && f.w.leftShoulder && f.w.rightShoulder && f.w[c.shoulder]) {
    // 3D(体の向き基準)
    const M3 = (k, v) => metric(k, v, presetFor('3d', preset).preset);
    const b = toBody(f.w, ax);
    const sgn = hand === 'right' ? 1 : -1;
    const d = b[c.shoulder];
    if (view === 'rear') {
      const o = b[OTHER_SHOULDER[hand]];
      if (o) {
        out.push(M3('shoulderTilt', Math.atan2(o.up - d.up, Math.max(Math.abs(d.lat - o.lat), 0.02)) * 180 / Math.PI));
        if (b[c.wrist]) out.push(M3('releaseOffset', ((b[c.wrist].lat - d.lat) * sgn) / Math.max(dist3(b.rightShoulder, b.leftShoulder), 0.15)));
      }
      return out;
    }
    const sm = mid3(b.leftShoulder, b.rightShoulder);
    out.push(M3('trunkLean', Math.atan2(sm.fwd, sm.up) * 180 / Math.PI));
    if (b[c.hip] && b[c.knee] && b[c.ankle]) out.push(M3('slideKnee', angle3(b[c.knee], b[c.hip], b[c.ankle])));
    if (b[c.elbow] && b[c.wrist]) out.push(M3('elbow', angle3(b[c.elbow], d, b[c.wrist])));
    return out;
  }
  const M = (k, v) => metric(k, v, presetFor('2d', preset).preset);
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
