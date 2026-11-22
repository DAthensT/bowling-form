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

/**
 * 間引くときに、実際にタイマーで待つ時間(ミリ秒)。待ちのあとは「次のカメラのコマ」を待つので、
 * 推定にかかった時間(spentMs)と、そのコマ待ちの分(平均で半コマ ≒ 10ms)を差し引く。
 * 差し引かないと、30fps のカメラでは 1回あたり 80ms 以上空いて、12回/秒ほどまで落ちる。
 */
export function idleDelay(wait, spentMs) {
  return Math.max(0, wait - spentMs - 10);
}

// 人がいない・画面を見ていないときの省電力の判断(DOM なし。main.js から毎コマ呼ぶ)。
//   record: 録画を回すか。人(人物の確認が済んだもの)が最後に見えてから recordHoldSec 秒は回す。
//           投球前はアプローチに数秒立つので、プリロール(動き出しの約1秒前)は確保できる。
//   sleep:  sleepSec 秒、人が見えなければ、カメラごと休止する(0 = しない)。
//   dim:    dimSec 秒、画面に触れなければ、画面を暗くする(0 = しない)。
//   busy(投球の最中・解析中)のあいだは、録画を止めず、休止もしない。
export class IdleWatch {
  constructor({ recordHoldSec = 5 } = {}) {
    this.recordHoldSec = recordHoldSec;
    this.reset(0);
  }

  reset(t) { this.lastPerson = t; this.lastPose = t; this.lastTouch = t; }
  /** 人物の確認が済んだ人が見えた(録画も休止も、これで判断する) */
  person(t) { this.lastPerson = t; this.lastPose = t; }
  /** 確認前でも、人らしい姿勢が出た(録画だけ、これでも再開する) */
  seen(t) { this.lastPose = t; }
  touch(t) { this.lastTouch = t; }

  decide(t, { busy = false, sleepSec = 0, dimSec = 0 } = {}) {
    if (busy) this.person(t);
    const away = t - this.lastPerson;
    return {
      record: t - this.lastPose < this.recordHoldSec,
      sleep: sleepSec > 0 && away >= sleepSec,
      dim: dimSec > 0 && t - this.lastTouch >= dimSec,
    };
  }
}
