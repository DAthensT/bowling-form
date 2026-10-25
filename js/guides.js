// ボウリング場での設置を助ける構図ガイド(補助線)と水平器。
//  - 後方撮影: レーンの両端に合わせる台形・中央線・余白の枠
//  - 横撮影: 三分割線・余白の枠
//  - 水平器: 加速度センサーから左右の傾き(roll)と上下の傾き(pitch)を出し、世界の水平線を画面に描く
import { settings } from './store.js';
import { roiHalfWidth } from './target.js';

/**
 * 横持ち(長辺が縦方向=重力方向)で構えたときの傾き。0 が水平。
 * roll: 左右の傾き(度)。pitch: 上下の傾き(度)。符号は端末・OSで逆になりうるので、画面側で反転できるようにしてある。
 */
export function rollPitch(ax, ay, az) {
  let roll = Math.atan2(ay, ax) * 180 / Math.PI;
  if (roll > 90) roll -= 180;
  if (roll < -90) roll += 180;
  const pitch = Math.atan2(az, Math.hypot(ax, ay)) * 180 / Math.PI;
  return { roll, pitch };
}

const LEVEL_OK = 1.5; // この角度以内なら水平とみなす(度)

export function initGuides({ canvas, getView, getMode }) {
  const $ = (id) => document.getElementById(id);
  const ctx = canvas.getContext('2d');
  let roll = 0, pitch = 0, sensor = false, lastText = 0;

  const on = () => settings.get('guideOn', false);
  const laneW = () => settings.get('guideW', 30) / 100;
  const vpY = () => settings.get('guideVp', 40) / 100;
  const flip = () => (settings.get('levelFlip', false) ? -1 : 1);
  // キャリブレーションで登録したレーン中心(未登録は画面中央)
  const cx = () => { const c = settings.get('calib', null); return c && typeof c.cx === 'number' ? c.cx : 0.5; };

  function draw() {
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const u = Math.max(W / 640, 1); // 線の太さの基準

    // ボウリング場モード(後方): 分析の対象になる範囲の外側を暗くする(ガイドの表示設定に関係なく常に表示)
    if (getMode() === 'alley' && getView() === 'rear') {
      const cfg = { laneW: laneW(), vpY: vpY() };
      const mx = cx();
      const ys = [0, vpY(), 1];
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.moveTo(W * (mx - roiHalfWidth(0, cfg)), 0);
      for (const y of ys) ctx.lineTo(W * (mx - roiHalfWidth(y, cfg)), H * y);
      for (const y of [...ys].reverse()) ctx.lineTo(W * (mx + roiHalfWidth(y, cfg)), H * y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(0,0,0,.5)';
      ctx.fill('evenodd');
    }
    if (!on()) return;

    // 余白の枠: 全身がこの中に収まるように
    ctx.setLineDash([10 * u, 8 * u]);
    ctx.lineWidth = 2 * u;
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.strokeRect(W * 0.05, H * 0.04, W * 0.9, H * 0.92);

    ctx.strokeStyle = 'rgba(255,214,10,.9)';
    ctx.fillStyle = 'rgba(255,214,10,.95)';
    ctx.font = `${14 * u}px sans-serif`;
    if (getView() === 'rear') {
      const w = laneW(), vy = vpY();
      ctx.setLineDash([]);
      ctx.lineWidth = 3 * u;
      // レーンの両端(消失点へ向かう)
      ctx.beginPath();
      const mx = cx();
      ctx.moveTo(W * (mx - w), H); ctx.lineTo(W * mx, H * vy);
      ctx.moveTo(W * (mx + w), H); ctx.lineTo(W * mx, H * vy);
      ctx.stroke();
      // 中央線(レーンの中心に合わせる)
      ctx.setLineDash([12 * u, 8 * u]);
      ctx.lineWidth = 2 * u;
      ctx.beginPath(); ctx.moveTo(W * mx, 0); ctx.lineTo(W * mx, H); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillText('レーンの両端を黄色い線に、中心を点線に合わせる', W * 0.06, H * 0.95);
    } else {
      ctx.setLineDash([]);
      ctx.lineWidth = 1.5 * u;
      ctx.beginPath();
      for (const f of [1 / 3, 2 / 3]) {
        ctx.moveTo(W * f, 0); ctx.lineTo(W * f, H);
        ctx.moveTo(0, H * f); ctx.lineTo(W, H * f);
      }
      ctx.stroke();
      ctx.fillText('助走〜フォロースルーが枠内に収まるように', W * 0.06, H * 0.95);
    }

    // 水平器: 画面中央の基準線(白)と、世界の水平線(緑=水平 / 赤=傾き)
    ctx.setLineDash([]);
    ctx.lineWidth = 2 * u;
    ctx.strokeStyle = 'rgba(255,255,255,.8)';
    ctx.beginPath(); ctx.moveTo(W * 0.38, H * 0.5); ctx.lineTo(W * 0.62, H * 0.5); ctx.stroke();
    if (sensor) {
      const ok = Math.abs(roll) <= LEVEL_OK;
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.rotate(roll * flip() * Math.PI / 180);
      ctx.strokeStyle = ok ? '#34c759' : '#ff453a';
      ctx.lineWidth = 4 * u;
      ctx.beginPath(); ctx.moveTo(-W * 0.3, 0); ctx.lineTo(W * 0.3, 0); ctx.stroke();
      ctx.restore();
    }
  }

  function onMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    const r = rollPitch(a.x, a.y, a.z);
    sensor = true;
    roll += 0.2 * (r.roll - roll);
    pitch += 0.2 * (r.pitch - pitch);
    const now = performance.now();
    if (now - lastText > 100) {
      lastText = now;
      const ok = Math.abs(roll) <= LEVEL_OK && Math.abs(pitch) <= LEVEL_OK;
      $('levelInfo').textContent = `左右 ${(roll * flip()).toFixed(1)}° / 上下 ${(pitch * flip()).toFixed(1)}° ${ok ? '✅ 水平' : ''}`;
      draw();
    }
  }

  async function enableSensor() {
    try {
      if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function') {
        const res = await DeviceMotionEvent.requestPermission();
        if (res !== 'granted') { $('levelInfo').textContent = '傾きセンサーが許可されませんでした'; return; }
      }
      window.addEventListener('devicemotion', onMotion);
      $('levelBtn').hidden = true;
      $('levelInfo').textContent = '傾きを測定中…';
    } catch (e) {
      $('levelInfo').textContent = '傾きセンサーを使えません: ' + e.message;
    }
  }

  function refreshControls() {
    $('guideOn').checked = on();
    $('guideCtl').hidden = !on();
    $('guideW').value = settings.get('guideW', 30);
    $('guideVp').value = settings.get('guideVp', 40);
    $('laneCtl').hidden = getView() !== 'rear';
  }

  $('guideOn').addEventListener('change', () => { settings.set('guideOn', $('guideOn').checked); refreshControls(); draw(); });
  $('guideW').addEventListener('input', () => { settings.set('guideW', Number($('guideW').value)); draw(); });
  $('guideVp').addEventListener('input', () => { settings.set('guideVp', Number($('guideVp').value)); draw(); });
  $('levelBtn').addEventListener('click', enableSensor);
  $('levelFlip').addEventListener('click', () => { settings.set('levelFlip', !settings.get('levelFlip', false)); draw(); });
  refreshControls();

  return { redraw() { refreshControls(); draw(); } };
}
