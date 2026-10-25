// 複数の人物候補から「分析する人」を選ぶ(DOM/外部依存なし)。
//   自宅モード      : 他の人は写らない前提。一番大きく映っている人。
//   ボウリング場モード: 後方撮影で、設置ガイドで合わせたレーンの範囲(台形)の中にいる人だけ。
//                    範囲内に複数いるときは、直前まで追っていた人を優先する。
import { mid } from './analyzer.js';

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * レーン範囲の半幅(正規化)。消失点の高さ vpY より上は minHalf、画面下端で margin*laneW になるよう線形に広がる。
 * laneW: 設置ガイドの「レーン幅(画面下端)」の半幅。margin: アプローチはレーンより広いので少し広げる。
 */
export function roiHalfWidth(y, { laneW = 0.30, vpY = 0.40, margin = 1.25, minHalf = 0.10 } = {}) {
  const t = clamp01((y - vpY) / (1 - vpY));
  return minHalf + (margin * laneW - minHalf) * t;
}

export const hipCenter = (j) => mid(j.leftHip, j.rightHip);

export function inLaneRoi(j, cfg) {
  const h = hipCenter(j);
  const cx = cfg.cx === undefined ? 0.5 : cfg.cx; // キャリブレーションで登録したレーン中心
  return Math.abs(h.x - cx) <= roiHalfWidth(h.y, cfg);
}

const heightOf = (j) => {
  const ys = Object.values(j).map(p => p.y);
  return Math.max(...ys) - Math.min(...ys);
};

/**
 * candidates: [{t, j}](人物として自然なものだけ)。
 * cfg: null なら自宅モード。{mode:'alley', laneW, vpY, margin, minHalf, prev:{x,y}|null} ならボウリング場モード。
 */
export function pickTarget(candidates, cfg, stats = null) {
  if (stats) { stats.candidates = candidates.length; stats.inside = candidates.length; }
  if (!candidates.length) return null;
  if (!cfg || cfg.mode !== 'alley') {
    return candidates.reduce((best, c) => (heightOf(c.j) > heightOf(best.j) ? c : best));
  }
  const inside = candidates.filter(c => inLaneRoi(c.j, cfg));
  if (stats) stats.inside = inside.length;
  if (!inside.length) return null;
  if (cfg.prev) {
    // 直前まで追っていた人に一番近い人を選ぶ(隣のレーンの人に切り替わらないように)
    return inside.reduce((best, c) => {
      const a = hipCenter(c.j), b = hipCenter(best.j);
      return Math.hypot(a.x - cfg.prev.x, a.y - cfg.prev.y) < Math.hypot(b.x - cfg.prev.x, b.y - cfg.prev.y) ? c : best;
    });
  }
  // 最初の選択: 画面中央に近く、大きく映っている人
  const cx = cfg.cx === undefined ? 0.5 : cfg.cx;
  const score = (c) => Math.abs(hipCenter(c.j).x - cx) - 0.5 * heightOf(c.j);
  return inside.reduce((best, c) => (score(c) < score(best) ? c : best));
}
