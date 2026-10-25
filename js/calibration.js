// ボウリング場での設置に合わせた自動調整(DOM/外部依存なし)。
//   1) 立ち位置の登録: レーン範囲の中心・幅を、投球者の実際の位置から決める
//   2) 試し歩き      : 遠ざかる速さを実測して、投球の検知しきい値を決める
import { dist, mid } from './analyzer.js';
import { RearMotionSignal } from './detector.js';
import { hipCenter } from './target.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/** 立ち位置の中心(hip)・胴体の大きさ・肩幅。frames: 静止中に検出した人物 [{t, j}] */
export function summarizeStanding(frames) {
  if (frames.length < 5) return null;
  const hips = frames.map(f => hipCenter(f.j));
  const torsos = frames.map(f => dist(mid(f.j.leftShoulder, f.j.rightShoulder), mid(f.j.leftHip, f.j.rightHip)));
  const widths = frames.map(f => dist(f.j.leftShoulder, f.j.rightShoulder));
  return {
    cx: median(hips.map(h => h.x)), cy: median(hips.map(h => h.y)),
    torso: median(torsos), width: median(widths), n: frames.length
  };
}

/**
 * 指定した点(人物の位置)が、レーン範囲(target.js の roiHalfWidth)に収まるのに必要な laneW(画面下端の半幅)。
 * points: [{x, y, need}] need は中心からの許容半幅(正規化)。範囲は消失点より上では広げられないので、そこは無視する。
 */
export function laneForPoints(points, { cx = 0.5, vpY = 0.40, margin = 1.25, minHalf = 0.10, min = 0.15, max = 0.48 } = {}) {
  let laneW = min;
  for (const p of points) {
    const t = clamp((p.y - vpY) / (1 - vpY), 0, 1);
    if (t < 0.05) continue;
    const need = Math.max(p.need, Math.abs(p.x - cx) * 1.3 + 0.03);
    laneW = Math.max(laneW, ((need - minHalf) / t + minHalf) / margin);
  }
  return clamp(laneW, min, max);
}

/**
 * 試し歩きの検知しきい値。frames: 歩いている間に検出した人物 [{t, j}](時刻順)。
 * 遠ざかる速さのピークの一部を「開始」、さらに小さい値を「終了」のしきい値にする。
 */
export function deriveThresholds(frames) {
  const sig = new RearMotionSignal();
  let peak = 0;
  const path = [];
  let minTorso = Infinity;
  for (const f of frames) {
    const torso = dist(mid(f.j.leftShoulder, f.j.rightShoulder), mid(f.j.leftHip, f.j.rightHip));
    if (torso < 0.01) continue;
    const away = sig.update(torso, f.t);
    if (away !== null) peak = Math.max(peak, away);
    const h = hipCenter(f.j);
    path.push({ x: h.x, y: h.y });
    minTorso = Math.min(minTorso, torso);
  }
  if (path.length < 15) return { ok: false, reason: '歩いている間の人物を十分に検出できませんでした(検出できたのが少なすぎます)', peak, path };
  if (peak < 0.05) return { ok: false, reason: '遠ざかる動きを検出できませんでした。カメラから離れる向きに、普通の速さで歩いてください', peak, path };
  const startSlope = clamp(0.35 * peak, 0.04, 0.15);
  const endSlope = Math.min(clamp(0.15 * peak, 0.02, 0.06), startSlope * 0.6);
  return { ok: true, peak, startSlope, endSlope, minTorso, path };
}
