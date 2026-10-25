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
  let diag = { people: 0, visFail: 0, implausible: 0, reasons: {}, candidates: 0, picked: false };

  return {
    close() { landmarker.close(); },
    /** 'strict' | 'normal' | 'loose' */
    setSensitivity(level) {
      const v = SENSITIVITY[level] || SENSITIVITY.normal;
      visMin = v.vis;
      landmarker.setOptions({ minPoseDetectionConfidence: v.det, minPosePresenceConfidence: v.pres, minTrackingConfidence: v.track });
    },
    /** 直近の detect の内訳(診断表示用) */
    get diag() { return diag; },
    /** 戻り値: {t: 秒, j: {関節名: {x, y}}} または null。他の人は写らない前提で、一番大きく映っている人を返す。 */
    detect(video, nowMs) {
      const result = landmarker.detectForVideo(video, nowMs);
      const d = { people: 0, visFail: 0, implausible: 0, reasons: {}, candidates: 0, picked: false };
      const candidates = [];
      const worlds = result.worldLandmarks || [];
      for (const [idx, lm] of (result.landmarks || []).entries()) {
        d.people++;
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
      const best = pickLargest(candidates);
      d.candidates = candidates.length;
      d.picked = !!best;
      diag = d;
      return best;
    }
  };
}
