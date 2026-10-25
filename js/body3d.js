// 体の向きを基準にした3D計測(DOM/外部依存なし)。
//
// MediaPipe の worldLandmarks を使う: メートル単位、原点は腰の中心、x=画像の右 / y=下 / z=カメラから遠ざかる向き。
// 画像上の2D座標で測ると、カメラに対する体の向き(進入角度やカメラの置き場所のずれ)で、腕の位置や角度がずれて見える。
// そこで、腰のラインから「体の右(lat)・前(fwd)・上(up)」の座標系を作り、その上で測り直す。
//   lat: 体の右へ +、 fwd: 体の前へ +、 up: 上へ +   (原点は腰の中心、単位はメートル)
// 上方向は、カメラが水平に置かれている(world の y 軸が鉛直)と仮定している。

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 体の右向き(左腰→右腰)の水平成分の単位ベクトル {x, z}。腰が揃っていない/水平の幅が小さすぎるときは null。 */
export function hipAxis(w) {
  if (!w || !w.leftHip || !w.rightHip) return null;
  const x = w.rightHip.x - w.leftHip.x, z = w.rightHip.z - w.leftHip.z;
  const n = Math.hypot(x, z);
  return n < 0.08 ? null : { x: x / n, z: z / n };
}

/** 軸を前後 radius フレームで平均してぶれを抑える。近くに有効な値がなければ null。 */
export function smoothAxes(axes, radius = 8) {
  return axes.map((_, i) => {
    let sx = 0, sz = 0, n = 0;
    for (let k = Math.max(0, i - radius); k <= Math.min(axes.length - 1, i + radius); k++) {
      if (axes[k]) { sx += axes[k].x; sz += axes[k].z; n++; }
    }
    if (!n) return null;
    const m = Math.hypot(sx, sz) || 1;
    return { x: sx / m, z: sz / m };
  });
}

/** w(カメラ座標の3D関節)を、体の座標系 {lat, fwd, up} にする。原点は腰の中心。 */
export function toBody(w, ax) {
  const o = { x: (w.leftHip.x + w.rightHip.x) / 2, y: (w.leftHip.y + w.rightHip.y) / 2, z: (w.leftHip.z + w.rightHip.z) / 2 };
  const out = {};
  for (const [k, p] of Object.entries(w)) {
    const dx = p.x - o.x, dy = p.y - o.y, dz = p.z - o.z;
    out[k] = { lat: dx * ax.x + dz * ax.z, fwd: -dx * ax.z + dz * ax.x, up: -dy };
  }
  return out;
}

export const dist3 = (a, b) => Math.hypot(a.lat - b.lat, a.fwd - b.fwd, a.up - b.up);
export const mid3 = (a, b) => ({ lat: (a.lat + b.lat) / 2, fwd: (a.fwd + b.fwd) / 2, up: (a.up + b.up) / 2 });

/** b を頂点とする a-b-c の3D角度(度) */
export function angle3(b, a, c) {
  const v1 = [a.lat - b.lat, a.fwd - b.fwd, a.up - b.up];
  const v2 = [c.lat - b.lat, c.fwd - b.fwd, c.up - b.up];
  const n1 = Math.hypot(...v1), n2 = Math.hypot(...v2);
  if (!n1 || !n2) return 0;
  const d = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
  return Math.acos(clamp(d / (n1 * n2), -1, 1)) * 180 / Math.PI;
}
