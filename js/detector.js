// 姿勢の時系列から「投球動作の開始と終了」を検知する状態機械 (iOS 版 ThrowDetector.swift の移植 + 後方撮影対応)。
//
// view = 'side' : 真横から撮影。体の画面上の移動速度(胴体の長さ/秒)で検知する。
// view = 'rear' : 真後ろから撮影。体は奥へ遠ざかるので、胴体の見かけの大きさが縮む速さで検知する。
//                 カメラに近づく動き(ボールリターンから戻る歩き)は検知しない。
import { mid, dist } from './analyzer.js';

export const DEFAULT_CONFIG = {
  startSpeed: 0.9,   // [side] 体の移動速度(胴体の長さ/秒)がこれを超え続けたら助走開始
  endSpeed: 0.35,    // [side] これを下回り続けたらスライド停止(投球終了)
  rearStartSlope: 0.10, // [rear] ln(胴体の大きさ) の縮小率(/秒)がこれを超え続けたら助走開始
  rearEndSlope: 0.05,   // [rear] これを下回り続けたら投球終了
  startSustain: 0.35,
  endHold: 0.7,
  minDuration: 1.2,
  maxDuration: 9.0,
  lostTimeout: 1.0,  // 姿勢を見失ってから終了とみなすまでの時間
  cooldown: 2.5      // 終了後に次の検知を無視する時間(ボールリターンへ戻る歩きの誤検知対策)
};

/**
 * 後方撮影の動き量: ln(胴体の見かけの大きさ) の時間回帰の傾きを平滑化したもの。
 * 正の値 = カメラから遠ざかっている速さ(/秒)。update は十分なデータがたまるまで null を返す。
 */
export class RearMotionSignal {
  constructor() { this.samples = []; this.ema = null; this.lastT = null; }

  update(torsoLength, t) {
    this.samples.push({ t, ln: Math.log(torsoLength) });
    this.samples = this.samples.filter(s => t - s.t <= 0.6);
    if (this.samples.length < 8 || this.samples[this.samples.length - 1].t - this.samples[0].t < 0.4) return null;
    const n = this.samples.length;
    const mt = this.samples.reduce((a, s) => a + s.t, 0) / n;
    const ml = this.samples.reduce((a, s) => a + s.ln, 0) / n;
    let num = 0, den = 0;
    for (const s of this.samples) { num += (s.t - mt) * (s.ln - ml); den += (s.t - mt) ** 2; }
    const slope = den > 0 ? num / den : 0;
    const dt = this.lastT === null ? 0 : t - this.lastT;
    this.lastT = t;
    const alpha = 1 - Math.exp(-dt / 0.3);
    this.ema = this.ema === null ? slope : this.ema + alpha * (slope - this.ema);
    return -this.ema;
  }
}

export class ThrowDetector {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.view = config.view === 'rear' ? 'rear' : 'side';
    this.travelDirection = 1; // [side] +1: 画面右へ, -1: 左へ
    this.samples = [];
    this.torso = 0.25;
    this.rearSignal = new RearMotionSignal();
    this.signal = 0; // 診断表示用: 現在の動き量(横: 胴体長/秒、後方: 遠ざかる速さ)
    this.aboveSince = null;
    this.belowSince = null;
    this.activeStart = null;
    this.lastSeen = 0;
    this.cooldownUntil = 0;
  }

  get isActive() { return this.activeStart !== null; }

  /** 戻り値: {type:'started', at} | {type:'ended', at} | null */
  process(frame, t) {
    return this.view === 'rear' ? this.#processRear(frame, t) : this.#processSide(frame, t);
  }

  #processSide(frame, t) {
    const c = frame && this.#center(frame);
    if (!c) return this.#lost(t);
    this.lastSeen = t;
    this.samples.push({ t, x: c.x, y: c.y });
    this.samples = this.samples.filter(s => t - s.t <= 0.4);
    const tl = this.#torsoLength(frame);
    if (tl !== null) this.torso = this.torso * 0.9 + Math.min(Math.max(tl, 0.08), 0.6) * 0.1;

    const first = this.samples[0], last = this.samples[this.samples.length - 1];
    if (last.t - first.t < 0.2) return null;
    const dx = last.x - first.x, dy = last.y - first.y;
    const speed = Math.hypot(dx, dy) / (last.t - first.t) / this.torso;
    this.signal = speed;
    const cfg = this.config;
    return this.#step(t, speed > cfg.startSpeed, speed < cfg.endSpeed, () => {
      if (Math.abs(dx) > Math.abs(dy)) this.travelDirection = dx >= 0 ? 1 : -1;
    });
  }

  #processRear(frame, t) {
    const raw = frame && this.#torsoLength(frame);
    if (!raw || raw < 0.01) return this.#lost(t);
    this.lastSeen = t;
    const away = this.rearSignal.update(raw, t);
    if (away === null) return null;
    this.signal = away;
    const cfg = this.config;
    return this.#step(t, away > cfg.rearStartSlope, away < cfg.rearEndSlope);
  }

  #lost(t) {
    this.aboveSince = null;
    if (this.activeStart !== null && t - this.lastSeen > this.config.lostTimeout && t - this.activeStart > 0.5) {
      return this.#end(t);
    }
    return null;
  }

  #step(t, moving, stopped, onMoving) {
    const cfg = this.config;
    if (this.activeStart !== null) {
      if (t - this.activeStart > cfg.maxDuration) return this.#end(t);
      if (t - this.activeStart >= cfg.minDuration && stopped) {
        if (this.belowSince === null) this.belowSince = t;
        if (t - this.belowSince >= cfg.endHold) return this.#end(t);
      } else {
        this.belowSince = null;
      }
      return null;
    }

    if (t < this.cooldownUntil) { this.aboveSince = null; return null; }
    if (moving) {
      if (onMoving) onMoving();
      if (this.aboveSince === null) this.aboveSince = t;
      if (t - this.aboveSince >= cfg.startSustain) {
        this.activeStart = this.aboveSince;
        this.belowSince = null;
        return { type: 'started', at: this.aboveSince };
      }
    } else {
      this.aboveSince = null;
    }
    return null;
  }

  #end(t) {
    this.activeStart = null;
    this.belowSince = null;
    this.aboveSince = null;
    this.cooldownUntil = t + this.config.cooldown;
    return { type: 'ended', at: t };
  }

  #center(f) {
    const j = f.j;
    if (j.leftHip && j.rightHip) return mid(j.leftHip, j.rightHip);
    if (j.leftShoulder && j.rightShoulder) return mid(j.leftShoulder, j.rightShoulder);
    return j.neck || null;
  }

  #torsoLength(f) {
    const j = f.j;
    if (!(j.leftShoulder && j.rightShoulder && j.leftHip && j.rightHip)) return null;
    return dist(mid(j.leftShoulder, j.rightShoulder), mid(j.leftHip, j.rightHip));
  }
}
