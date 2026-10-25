// 「人物がいる」ことの確認。人がいなくても、レーンやピンなどを人と誤認して姿勢が出ることがあるため、
//  1) 形が人物として自然か (isPlausiblePerson)
//  2) 一定時間、連続して人物として見えているか (PresenceFilter)
// を通ったフレームだけを、投球の検知・解析に渡す(DOM/外部依存なし)。
import { mid, dist } from './analyzer.js';

/**
 * j: {関節名: {x, y}} (0..1, y は下向き)。人物として不自然な理由を返す(自然なら空文字)。診断表示にも使う。
 */
export function whyNotPlausible(j) {
  if (!(j.leftShoulder && j.rightShoulder && j.leftHip && j.rightHip)) return '肩・腰が揃っていない';
  if (Object.keys(j).length < 9) return '見えている関節が少ない';
  const sm = mid(j.leftShoulder, j.rightShoulder);
  const hm = mid(j.leftHip, j.rightHip);
  const torso = dist(sm, hm);
  if (torso < 0.04) return '小さすぎる(遠い/小さく映っている)';
  if (torso > 0.6) return '大きすぎる';
  const dy = hm.y - sm.y;
  if (dy < 0.03) return '肩が腰より上にない';
  if (Math.abs(sm.x - hm.x) > 1.8 * dy) return '体がほぼ水平';
  const ys = Object.values(j).map(p => p.y);
  if (Math.max(...ys) - Math.min(...ys) < 0.15) return '体の縦の広がりが小さい';
  return '';
}

/** 肩・腰が揃い、体の形・大きさが妥当なら true。 */
export const isPlausiblePerson = (j) => whyNotPlausible(j) === '';

export class PresenceFilter {
  /**
   * minFrames: 直近 window 秒のあいだに、この枚数以上の「人物として自然なフレーム」があれば「いる」とする
   * maxGap: 人物フレームの間がこの秒数以上空いたら、数え直す(飛び飛びに出るものは人物とみなさない)
   * jump: 位置(正規化座標)がこれ以上飛んだら別物とみなして数え直す
   */
  constructor({ minFrames = 6, window = 0.8, maxGap = 0.25, jump = 0.25 } = {}) {
    this.minFrames = minFrames;
    this.window = window;
    this.maxGap = maxGap;
    this.jump = jump;
    this.reset();
  }

  reset() {
    this.times = [];
    this.lastValid = -Infinity;
    this.lastCenter = null;
  }

  /** 人物として安定していればそのフレームを、そうでなければ null を返す。 */
  update(frame, t) {
    if (!frame || !isPlausiblePerson(frame.j)) {
      if (t - this.lastValid > this.maxGap) this.reset();
      return null;
    }
    const c = mid(mid(frame.j.leftShoulder, frame.j.rightShoulder), mid(frame.j.leftHip, frame.j.rightHip));
    if (t - this.lastValid > this.maxGap || (this.lastCenter && dist(c, this.lastCenter) > this.jump)) this.times = [];
    this.times.push(t);
    this.times = this.times.filter(x => t - x <= this.window);
    this.lastCenter = c;
    this.lastValid = t;
    return this.times.length >= this.minFrames ? frame : null;
  }

  get stable() { return this.times.length >= this.minFrames; }
}
