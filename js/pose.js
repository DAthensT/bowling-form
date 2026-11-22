// MediaPipe Pose Landmarker のラッパー。
import { whyNotPlausible } from './presence.js';
import { FilesetResolver, PoseLandmarker } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/vision_bundle.mjs';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

const INDEX = {
  nose: 0, leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14, leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24, leftKnee: 25, rightKnee: 26, leftAnkle: 27, rightAnkle: 28
};

export const BONES = [
  ['neck', 'leftShoulder'], ['neck', 'rightShoulder'],
  ['leftShoulder', 'leftElbow'], ['leftElbow', 'leftWrist'],
  ['rightShoulder', 'rightElbow'], ['rightElbow', 'rightWrist'],
  ['leftShoulder', 'leftHip'], ['rightShoulder', 'rightHip'], ['leftHip', 'rightHip'],
  ['leftHip', 'leftKnee'], ['leftKnee', 'leftAnkle'],
  ['rightHip', 'rightKnee'], ['rightKnee', 'rightAnkle'],
  ['nose', 'neck']
];

/** 検知の感度。厳しいほど誤検知は減るが、暗い・遠い・後ろ向きの人を見逃しやすい。 */
export const SENSITIVITY = {
  strict: { det: 0.7, pres: 0.7, track: 0.6, vis: 0.65 },
  normal: { det: 0.6, pres: 0.6, track: 0.5, vis: 0.55 },
  loose: { det: 0.5, pres: 0.5, track: 0.5, vis: 0.45 }
};

// 腕(肘・手首)は速く動くと確信度が下がるので、胴体より低いしきい値で採用する
const ARM_JOINTS = new Set(['leftElbow', 'rightElbow', 'leftWrist', 'rightWrist']);
const ARM_VIS_MIN = 0.25;

const heightOf = (j) => {
  const ys = Object.values(j).map(p => p.y);
  return Math.max(...ys) - Math.min(...ys);
};
const CROP_PX = 512;     // 切り出した画像の大きさ
const CROP_MARGIN = 2.0; // 人物の枠に対する切り出しの大きさ(腕を振っても収まる余裕)
const CROP_MIN = 0.5;    // 切り出しの最小の大きさ(画面の幅に対する割合)
const LOST_MAX = 3;      // これだけ続けて見失ったら、画面全体の探索に戻る
const REGIONS = { all: [0, 1], left: [0, 0.5], center: [0.25, 0.75], right: [0.5, 1] };

const boxOf = (j) => {
  const xs = Object.values(j).map(p => p.x), ys = Object.values(j).map(p => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
};
const inRegion = (j, region) => {
  const [a, b] = REGIONS[region] || REGIONS.all;
  const x = (j.leftHip.x + j.rightHip.x) / 2;
  return x >= a && x <= b;
};
const pickNearest = (candidates, t) => candidates.reduce((best, c) => {
  const b = boxOf(c.j), d = Math.hypot(b.cx - t.cx, b.cy - t.cy);
  return !best || d < best.d ? { c, d } : best;
}, null)?.c ?? null;
const pickLargest = (candidates) => candidates.reduce((best, c) => (!best || heightOf(c.j) > heightOf(best.j) ? c : best), null);

export async function createPoseDetector() {
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO',
    numPoses: 2,
    minPoseDetectionConfidence: SENSITIVITY.normal.det,
    minPosePresenceConfidence: SENSITIVITY.normal.pres,
    minTrackingConfidence: SENSITIVITY.normal.track
  });
  let landmarker;
  try {
    landmarker = await PoseLandmarker.createFromOptions(fileset, options('GPU'));
  } catch (e) {
    console.warn('GPU delegate failed, falling back to CPU', e);
    landmarker = await PoseLandmarker.createFromOptions(fileset, options('CPU'));
  }

  let visMin = SENSITIVITY.normal.vis;
  let diag = { people: 0, visFail: 0, implausible: 0, reasons: {}, candidates: 0, picked: false, zoomed: false };

  // 人物が小さく映る画角(離れた位置から、レーン全体を撮る場合)でも検出できるように、
  // 見つけた人物の周りだけを切り出して(=拡大して)推定する。見失ったら全体の推定に戻る。
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = cropCanvas.height = CROP_PX;
  const cropCtx = cropCanvas.getContext('2d');
  let track = null;      // 直近の人物の枠(画面に対する割合): {cx, cy, w, h}
  let lostCount = 0;
  let region = 'all';    // 人物を探す範囲(全体を探すとき)。隣のレーンの人を拾わないために使う

  return {
    close() { landmarker.close(); },
    /** 'strict' | 'normal' | 'loose' */
    setSensitivity(level) {
      const v = SENSITIVITY[level] || SENSITIVITY.normal;
      visMin = v.vis;
      landmarker.setOptions({ minPoseDetectionConfidence: v.det, minPosePresenceConfidence: v.pres, minTrackingConfidence: v.track });
    },
    /** 人物を探す範囲: 'all' | 'left' | 'center' | 'right'(画面の横方向。追跡中は影響しない) */
    setRegion(r) { const next = REGIONS[r] ? r : 'all'; if (next !== region) { region = next; track = null; } },
    /** 追跡の状態を捨てる(カメラを開始し直したとき) */
    resetTracking() { track = null; lostCount = 0; },
    /** 直近の detect の内訳(診断表示用) */
    get diag() { return diag; },
    /** 戻り値: {t: 秒, j: {関節名: {x, y}}} または null。他の人は写らない前提で、一番大きく映っている人を返す。 */
    detect(video, nowMs) {
      const vw = video.videoWidth, vh = video.videoHeight;
      // 追跡中は、人物の周りの正方形を切り出して推定する(座標は後で画面全体の割合に戻す)
      let box = null;
      if (track && vw && vh) {
        const side = Math.min(Math.max(track.h * vh * CROP_MARGIN, track.w * vw * CROP_MARGIN, CROP_MIN * vw), vw, vh);
        const x0 = Math.min(Math.max(track.cx * vw - side / 2, 0), vw - side);
        const y0 = Math.min(Math.max(track.cy * vh - side / 2, 0), vh - side);
        cropCtx.drawImage(video, x0, y0, side, side, 0, 0, CROP_PX, CROP_PX);
        box = { x0, y0, side };
      }
      const result = landmarker.detectForVideo(box ? cropCanvas : video, nowMs);
      const d = { people: 0, visFail: 0, implausible: 0, reasons: {}, candidates: 0, picked: false, zoomed: !!box };
      const candidates = [];
      const worlds = result.worldLandmarks || [];
      for (const [idx, lm0] of (result.landmarks || []).entries()) {
        d.people++;
        const lm = box
          ? lm0.map((p) => ({ ...p, x: (box.x0 + p.x * box.side) / vw, y: (box.y0 + p.y * box.side) / vh }))
          : lm0;
        const j = {};
        const w = {}; // 3D(メートル、原点は腰の中心): 体の向きを基準にした測定に使う
        const wl = worlds[idx];
        for (const [name, i] of Object.entries(INDEX)) {
          const p = lm[i];
          const min = ARM_JOINTS.has(name) ? ARM_VIS_MIN : Math.max(0.3, visMin - 0.15);
          if (p && (p.visibility === undefined || p.visibility >= min)) {
            j[name] = { x: p.x, y: p.y };
            if (wl && wl[i]) w[name] = { x: wl[i].x, y: wl[i].y, z: wl[i].z };
          }
        }
        if (j.leftShoulder && j.rightShoulder) {
          j.neck = { x: (j.leftShoulder.x + j.rightShoulder.x) / 2, y: (j.leftShoulder.y + j.rightShoulder.y) / 2 };
        }
        // 胴体の4点(両肩・両腰)は特にはっきり見えていること
        if (![11, 12, 23, 24].every(i => lm[i] && (lm[i].visibility === undefined || lm[i].visibility >= visMin))) { d.visFail++; continue; }
        const why = whyNotPlausible(j);
        if (why) { d.implausible++; d.reasons[why] = (d.reasons[why] || 0) + 1; continue; }
        candidates.push({ t: nowMs / 1000, j, ...(Object.keys(w).length ? { w } : {}) });
      }
      // 追跡中は、前の位置に一番近い人(隣のレーンの人に乗り換えない)。探している間は、指定した範囲の中で一番大きい人
      const best = track
        ? pickNearest(candidates, track)
        : pickLargest(candidates.filter((c) => inRegion(c.j, region)));
      if (best) {
        const b = boxOf(best.j);
        track = b; lostCount = 0;
      } else if (track && ++lostCount >= LOST_MAX) {
        track = null; lostCount = 0;
      }
      d.candidates = candidates.length;
      d.picked = !!best;
      diag = d;
      return best;
    }
  };
}
