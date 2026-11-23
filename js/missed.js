// 「投球として認識されなかった」場面を、原因の調査用に残すための判定。
//
// 失敗の仕方は2通りある:
//   rejected   : 検知は投球の開始・終了に気づいたが、撮影後の分析(analyzer)が投球ではないと判断した
//   notStarted : 投球らしい動き(動き量が開始のしきい値の近くまで来た)があったのに、検知が開始に気づかなかった
// notStarted を拾うのが NearMissWatch。動き量 ÷ 開始のしきい値(ratio)を毎コマ受け取り、
// 「しきい値の半分を超える山があったのに、投球が始まらないまま収まった」ときに、その範囲を返す。

export const MISSED_MAX = 20;   // 端末に残す未認識の件数(超えたら古いものから消す)

export class NearMissWatch {
  constructor({ low = 0.3, high = 0.5, minAbove = 0.15, maxSpan = 6, gap = 20 } = {}) {
    Object.assign(this, { low, high, minAbove, maxSpan, gap });
    this.cur = null;
    this.lastSave = -Infinity;
  }

  /**
   * t: 秒 / ratio: 動き量 ÷ 開始のしきい値(後方撮影は、遠ざかる向きだけ正) /
   * active: 検知が投球中(または録画・解析中) / eligible: 待機中で、人物が見えている
   * 戻り値: 見逃しと判断したら { from, to, peak }、それ以外は null
   */
  update(t, ratio, { active, eligible }) {
    if (active) { this.cur = null; return null; }   // 投球として始まったので、見逃しではない
    const r = eligible && Number.isFinite(ratio) ? ratio : 0;
    const c = this.cur;
    if (!c) {
      if (r >= this.low) this.cur = { start: t, last: t, peak: r, above: 0 };
      return null;
    }
    const dt = Math.max(0, t - c.last);
    c.last = t;
    if (r >= this.high) c.above += dt;
    if (r > c.peak) c.peak = r;
    if (r >= this.low && t - c.start < this.maxSpan) return null;
    this.cur = null;
    if (c.peak < this.high || c.above < this.minAbove || t - this.lastSave < this.gap) return null;
    this.lastSave = t;
    return { from: c.start, to: t, peak: c.peak };
  }

  reset() { this.cur = null; }
}

/**
 * 残す場面の診断。log: [{t, s(動き量), p(人物の姿勢が取れたか)}] / threshold: 開始のしきい値
 * 戻り値: { peak(しきい値に対する割合), posed, total, longestGap(秒) }
 */
export function missDiag(log, threshold, from, to) {
  const w = log.filter((x) => x.t >= from && x.t <= to);
  let peak = 0, posed = 0, gap = 0;
  let lastPose = w.length ? w[0].t : from;   // 姿勢が途切れた長さ(範囲の頭と終わりの途切れも数える)
  for (const x of w) {
    if (threshold > 0 && x.s / threshold > peak) peak = x.s / threshold;
    if (x.p) {
      posed++;
      gap = Math.max(gap, x.t - lastPose);
      lastPose = x.t;
    }
  }
  if (w.length) gap = Math.max(gap, w[w.length - 1].t - lastPose);
  return { peak: Math.round(peak * 100) / 100, posed, total: w.length, longestGap: Math.round(gap * 100) / 100 };
}

/** 新しい順の記録から、上限を超えた未認識の id(消す分)を返す */
export function overflowMissed(records, max = MISSED_MAX) {
  return records.filter((r) => r.missed).sort((a, b) => b.date - a.date).slice(max).map((r) => r.id);
}
