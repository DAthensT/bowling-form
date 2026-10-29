// 後方撮影の局面(バックスイング頂点・リリース・フォロースルー)を、体の動きだけで求める。
// PC 側(bowling-form-lab の bfl/moments.py)の方式の移植。PC の結果(ボールの位置で確認済み)に合わせて較正した。
//
// 手首の高さ(腰基準、胴の長さ単位、上が正)は、助走の中で『谷(押し出し) → 山(頂点) → 谷(リリース) → 山(フォロースルー)』と動く。
// 投球後にも腕は上下するので、助走が始まってから最初に現れる、この並びを採る(落差が最大のものではなく)。
import { mid, dist } from './analyzer.js';

const RELEASE_AFTER_STOP = 0.75; // 助走が止まってから、リリースまでの秒数(PC の結果との比較)
const NEAR_STOP = 0.6;
const MIN_ASPECT = 0.5625; // 画面の 幅/高さ。縦持ちのスマホ(9:16)を前提にする。胴はほぼ縦なので、結果への影響は小さい

/** 時間窓(秒)の移動平均。NaN は無視する。 */
function smoothT(t, y, half) {
  return y.map((_, i) => {
    let sum = 0, n = 0;
    for (let k = i; k >= 0 && t[i] - t[k] <= half; k--) if (!Number.isNaN(y[k])) { sum += y[k]; n++; }
    for (let k = i + 1; k < y.length && t[k] - t[i] <= half; k++) if (!Number.isNaN(y[k])) { sum += y[k]; n++; }
    return n ? sum / n : NaN;
  });
}

/** NaN を線形補間する。maxGap 秒より長い欠けは埋めない。 */
function interp(t, y, maxGap) {
  const out = y.slice();
  const idx = [];
  y.forEach((v, i) => { if (!Number.isNaN(v)) idx.push(i); });
  for (let k = 0, j = 0; k < y.length; k++) {
    if (!Number.isNaN(y[k])) continue;
    while (j < idx.length && idx[j] < k) j++;
    if (j > 0 && j < idx.length && t[idx[j]] - t[idx[j - 1]] <= maxGap) {
      const a = idx[j - 1], b = idx[j], u = (t[k] - t[a]) / (t[b] - t[a]);
      out[k] = y[a] + (y[b] - y[a]) * u;
    }
  }
  return out;
}

/** thr 以上の振れ幅だけを数えた、山(max)と谷(min)の並び。 */
function zigzag(y, thr) {
  const idx = [];
  y.forEach((v, i) => { if (!Number.isNaN(v)) idx.push(i); });
  if (idx.length < 3) return [];
  const out = [];
  let hi = idx[0], lo = idx[0], dir = 0;
  for (const i of idx.slice(1)) {
    if (dir >= 0 && y[i] > y[hi]) hi = i;
    if (dir <= 0 && y[i] < y[lo]) lo = i;
    if (dir >= 0 && y[hi] - y[i] >= thr) {
      if (dir === 0 || !out.length || out[out.length - 1].kind !== 'max') out.push({ i: hi, kind: 'max' });
      dir = -1; lo = i;
    } else if (dir <= 0 && y[i] - y[lo] >= thr) {
      if (dir === 0 || !out.length || out[out.length - 1].kind !== 'min') out.push({ i: lo, kind: 'min' });
      dir = 1; hi = i;
    }
  }
  if (dir === 1 && (!out.length || out[out.length - 1].kind !== 'max')) out.push({ i: hi, kind: 'max' });
  else if (dir === -1 && (!out.length || out[out.length - 1].kind !== 'min')) out.push({ i: lo, kind: 'min' });
  return out;
}

/** 助走(奥へ進む動き)の区間: 腰の画面上の y が上がっていく速さ(胴の長さ/秒)の山。 */
export function findApproach(t, hipY, torso) {
  const ys = smoothT(t, interp(t, hipY, 0.5), 0.23), Ls = smoothT(t, interp(t, torso, 0.5), 0.23);
  const v = t.map((_, i) => {
    if (i === 0 || i === t.length - 1) return NaN;
    const dt = t[i + 1] - t[i - 1];
    if (!(dt > 0) || Number.isNaN(ys[i + 1]) || Number.isNaN(ys[i - 1]) || Number.isNaN(Ls[i])) return NaN;
    return -(ys[i + 1] - ys[i - 1]) / dt / Ls[i];
  });
  const vs = smoothT(t, v, 0.3);
  let pk = -1;
  vs.forEach((x, i) => { if (!Number.isNaN(x) && (pk < 0 || x > vs[pk])) pk = i; });
  if (pk < 0 || vs[pk] < 0.25) return null;
  const thr = Math.max(0.3 * vs[pk], 0.12);
  let a = pk, b = pk;
  while (a > 0 && !Number.isNaN(vs[a - 1]) && vs[a - 1] >= thr) a--;
  while (b < t.length - 1 && !Number.isNaN(vs[b + 1]) && vs[b + 1] >= thr) b++;
  return { start: t[a], stop: t[b] };
}

/**
 * 戻り値: {backswing, release, follow, confidence} または null。時刻は frames と同じ時間軸(秒)。
 * frames: [{t, j:{関節名: {x, y}}}](0..1 の正規化座標)。
 */
export function findMomentsBody(frames, hand, debug = null) {
  const wristKey = `${hand}Wrist`;
  const t = [], hipY = [], torso = [], wh = [];
  for (const f of frames) {
    const j = f.j;
    if (!(j.leftShoulder && j.rightShoulder && j.leftHip && j.rightHip)) continue;
    const sh = mid(j.leftShoulder, j.rightShoulder), hp = mid(j.leftHip, j.rightHip);
    const L = Math.hypot((sh.x - hp.x) * MIN_ASPECT, sh.y - hp.y);
    if (L < 0.004) continue;
    t.push(f.t); hipY.push(hp.y); torso.push(L);
    wh.push(j[wristKey] ? (hp.y - j[wristKey].y) / L : NaN);
  }
  if (t.length < 10) return null;
  const w = smoothT(t, interp(t, wh, 0.3), 0.1);
  const zz = zigzag(w, 0.4);
  if (debug) debug.zz = zz.map(z => `${z.kind}@${t[z.i].toFixed(2)}=${w[z.i].toFixed(2)}`);
  const conf = (drop, rise, k = 1) => Math.min(1, Math.max(0, 0.4 + 0.2 * Math.min(drop, 2) + 0.2 * Math.min(rise, 1.5))) * k;
  const windowStats = (ib) => {
    let ia = -1, seen = 0, missing = 0;
    for (let k = 0; k < t.length; k++) {
      if (t[k] < t[ib] - 1.0 || t[k] > t[ib] - 0.25) continue;
      seen++;
      if (Number.isNaN(wh[k])) missing++;
      if (!Number.isNaN(w[k]) && (ia < 0 || w[k] > w[ia])) ia = k;
    }
    return { ia, seen, missingFrac: seen ? missing / seen : 1 };
  };
  const minBefore = (ia) => {
    let before = Infinity;
    for (let k = 0; k < t.length; k++) if (t[k] >= t[ia] - 1.0 && t[k] <= t[ia] && !Number.isNaN(w[k])) before = Math.min(before, w[k]);
    return before;
  };

  // 候補: 『リリースの谷 → フォロースルーの山』の組。谷の直前に、手首が高く見えた(強い根拠)か、手首が見えなかった(弱い根拠)かを調べる。
  // PC の結果との比較から、リリースは、助走が止まった(腰の動きが止まる)時刻の約 0.75 秒後にあることが多いので、それに最も近い候補を採る。
  // 近い候補がなければ、強い候補の最初のもの、なければ弱い候補の最初のものを採る。
  const cands = [];
  for (let a = 0; a + 1 < zz.length; a++) {
    const B = zz[a], C = zz[a + 1];
    if (B.kind !== 'min' || C.kind !== 'max') continue;
    const ib = B.i, ic = C.i;
    if (!(w[ib] <= -0.1)) continue;                                         // リリースの谷は、腰より下
    const riseOut = w[ic] - w[ib];
    const { ia, seen, missingFrac } = windowStats(ib);
    if (ia >= 0 && w[ia] >= 0.3 && !zz.some(z => z.kind === 'min' && z.i !== ib && t[z.i] > t[ia] && t[z.i] < t[ib])) {
      const drop = w[ia] - w[ib], before = minBefore(ia);
      // 先の強い候補のフォロースルーの山を、頂点と取り違えない(投球後の、腕の上げ下げ)
      const consumed = cands.some(c => c.topSeen && Math.abs(c.follow - t[ia]) <= 0.3);
      if (!consumed && drop >= 0.8 && riseOut >= 0.5 && t[ib] - t[ia] >= 0.25 && t[ib] - t[ia] <= 1.4 && !(Number.isFinite(before) && w[ia] - before < 0.5)) {
        cands.push({ backswing: t[ia], release: t[ib], follow: t[ic], confidence: conf(drop, riseOut), topSeen: true });
        continue;
      }
    }
    if (riseOut >= 0.9 && t[ic] - t[ib] >= 0.1 && t[ic] - t[ib] <= 0.8 && seen >= 3 && missingFrac >= 0.5) {
      cands.push({ backswing: t[ib] - 0.55, release: t[ib], follow: t[ic], confidence: conf(1, riseOut, 0.8), topSeen: false });
    }
  }
  if (!cands.length) return null;
  const ap = findApproach(t, hipY, torso);
  if (ap) {
    const target = ap.stop + RELEASE_AFTER_STOP;
    const best = cands.reduce((m, c) => (Math.abs(c.release - target) < Math.abs(m.release - target) ? c : m));
    if (Math.abs(best.release - target) <= NEAR_STOP) return best;
  }
  return cands.find(c => c.topSeen) || cands[0];
  return null;
}
