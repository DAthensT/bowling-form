// 撮影中の消費電力を下げるための、姿勢推定の頻度の調整。
//
// 姿勢推定(カメラの全コマ = 60回/秒)が、撮影中の負荷のいちばん大きな部分。
// ボウリングでは、投球の動作は数秒で、そのほかの時間(座っている・立っている・戻ってくる)の方がずっと長い。
// そこで、動きがないあいだは間引いて(既定 20回/秒)、動きが出たらすぐ全コマに戻す。
//   - 投球の検知は「動きが 0.35 秒続いたら助走開始」なので、20回/秒でも、検知は遅れない。
//   - 動きの量が、開始のしきい値の motionFrac(既定 3割)を超えたら、しきい値に届く前に全コマへ戻す。
//     助走の最初のコマから、解析に使う細かさで取れる。
//   - 戻したあとは holdSec(既定 1.5秒)のあいだは全コマのまま(行ったり来たりしない)。
//   - 投球の最中・解析中(active)は、常に全コマ。
export class RateGovernor {
  constructor({ idleMs = 50, holdSec = 1.5, motionFrac = 0.3 } = {}) {
    this.idleMs = idleMs;
    this.holdSec = holdSec;
    this.motionFrac = motionFrac;
    this.fullUntil = -Infinity;
  }

  /** 撮影を始めたとき。最初の少しは、全コマで様子を見る(人物の確認が早く済む) */
  reset(t) { this.fullUntil = t + 2; }

  /** 全コマで推定しているか(局面画像の保存などにも使う) */
  isFull(t) { return t < this.fullUntil; }

  /**
   * このコマの処理が終わったときに呼ぶ。次の推定までの待ち時間(ミリ秒)を返す。0 = 次のコマですぐ。
   * active: 投球の最中・解析中。 motion: 動きの量 ÷ 開始のしきい値(人物が見えていないときは 0)。
   */
  next(t, { active, motion }) {
    if (active || motion > this.motionFrac) this.fullUntil = Math.max(this.fullUntil, t + this.holdSec);
    return t < this.fullUntil ? 0 : this.idleMs;
  }
}
