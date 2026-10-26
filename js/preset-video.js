// 動画ファイルを再生しながらフレームごとに姿勢推定し、含まれる投球を自動で拾って解析する。
// 時刻は動画の再生位置(mediaTime)を基準にするので、再生速度を落としても検知の速度計算は変わらない。
import { createPoseDetector } from './pose.js';
import { ThrowDetector } from './detector.js';
import { analyze } from './analyzer.js';
import { PresenceFilter } from './presence.js';

const PRE_ROLL = 1.0;
const POST_ROLL = 1.5;

function once(el, ev) {
  return new Promise((resolve, reject) => {
    el.addEventListener(ev, resolve, { once: true });
    el.addEventListener('error', () => reject(new Error('動画を読み込めませんでした')), { once: true });
  });
}

/**
 * 戻り値: 有効な投球の解析結果(analyze() の戻り値)の配列。
 * onFrame(frame) で骨格の描画、onProgress(0..1)、onThrow(report, count) で逐次通知する。
 */
export async function analyzeVideo({ video, file, view, hand, rate = 0.5, from = 0, to = 0, signal, onProgress, onFrame, onThrow }) {
  if (!video.requestVideoFrameCallback) throw new Error('このブラウザは動画フレームの取得(requestVideoFrameCallback)に対応していません');
  const url = URL.createObjectURL(file);
  try {
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    await once(video, 'loadedmetadata');
    const end = to > from ? Math.min(to, video.duration) : video.duration;

    // 本番のカメラ用とは別のインスタンス(タイムスタンプの単調増加の制約が独立するように)
    const landmarker = await createPoseDetector();
    try {
      if (from > 0) { video.currentTime = from; await once(video, 'seeked'); }
      video.playbackRate = rate;

      const detector = new ThrowDetector({ view });
      const presence = new PresenceFilter();
      const history = [];
      const pending = [];
      const reports = [];
      let started = null;
      let lastMs = -1;

      const flush = (upTo) => {
        while (pending.length && upTo >= pending[0].end + POST_ROLL) {
          const p = pending.shift();
          const frames = history.filter(f => f.t >= p.start - PRE_ROLL && f.t <= p.end + POST_ROLL);
          const report = analyze({ frames, hand, throwStart: p.start, throwEnd: p.stopped, view });
          if (report.isValidThrow) { reports.push(report); if (onThrow) onThrow(report, reports.length); }
        }
      };

      await new Promise((resolve, reject) => {
        const finish = () => { video.pause(); resolve(); };
        const step = (_now, meta) => {
          const t = meta.mediaTime;
          if ((signal && signal.aborted) || t >= end) { finish(); return; }
          const ms = t * 1000;
          if (ms > lastMs) {
            lastMs = ms;
            let raw = null;
            try { raw = landmarker.detect(video, ms); } catch (e) { console.warn('pose error', e); }
            const frame = presence.update(raw, t);
            if (frame) {
              history.push(frame);
              if (history.length > 3000) history.splice(0, 1000);
            }
            if (onFrame) onFrame(raw);
            if (onProgress) onProgress(Math.min(1, (t - from) / Math.max(end - from, 0.001)));
            const ev = detector.process(frame, t);
            if (ev && ev.type === 'started') started = ev.at;
            else if (ev && ev.type === 'ended' && started !== null) { pending.push({ start: started, end: ev.at, stopped: ev.stoppedAt }); started = null; }
            flush(t);
          }
          video.requestVideoFrameCallback(step);
        };
        video.addEventListener('ended', finish, { once: true });
        video.play().then(() => video.requestVideoFrameCallback(step)).catch(reject);
      });
      flush(Infinity);
      return reports;
    } finally {
      if (landmarker.close) landmarker.close();
    }
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
