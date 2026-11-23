// js/missed.js: 検知が見逃した「投球のような動き」の判定と、残す件数の上限
import assert from 'node:assert/strict';
import { NearMissWatch, missDiag, overflowMissed } from '../js/missed.js';

/** ratio(t) を 30 コマ/秒で流し、見逃しと判断した結果を集める */
function run(fn, { from = 0, to = 10, active = () => false, eligible = () => true, opts } = {}) {
  const w = new NearMissWatch(opts);
  const hits = [];
  for (let t = from; t <= to; t += 1 / 30) {
    const h = w.update(t, fn(t), { active: active(t), eligible: eligible(t) });
    if (h) hits.push(h);
  }
  return hits;
}
const bump = (t0, t1, peak) => (t) => (t >= t0 && t <= t1 ? peak : 0.05);

// しきい値の 60% の動きが 0.5 秒続いて収まった → 見逃し1件(範囲と山の高さ)
{
  const hits = run(bump(2, 2.5, 0.6));
  assert.equal(hits.length, 1);
  assert.ok(Math.abs(hits[0].from - 2) < 0.05 && Math.abs(hits[0].to - 2.53) < 0.05, JSON.stringify(hits[0]));
  assert.equal(hits[0].peak, 0.6);
}
// 小さな動き(しきい値の 40%)は残さない
assert.equal(run(bump(2, 3, 0.4)).length, 0);
// しきい値の半分を超えても、一瞬(0.1 秒)なら残さない
assert.equal(run(bump(2, 2.1, 0.8)).length, 0);
// そのまま投球が始まった(検知が投球中になった)ら、見逃しではない
assert.equal(run(bump(2, 4, 1.5), { active: (t) => t > 2.5 }).length, 0);
// 人物が見えていない(eligible でない)あいだの動き量は数えない
assert.equal(run(bump(2, 3, 0.9), { eligible: () => false }).length, 0);
// 続けて起きても、20 秒に1件まで
assert.equal(run((t) => (t % 5 > 1 && t % 5 < 1.6 ? 0.7 : 0), { to: 30 }).length, 2);   // t=1.6 と t=21.6(と、その間の 6.6, 11.6, 16.6 は捨てる)
// 長く続く動き(歩き回るなど)は maxSpan で区切る
{
  const hits = run((t) => (t > 1 ? 0.7 : 0), { to: 12, opts: { gap: 0 } });
  assert.ok(hits.length >= 1 && hits[0].to - hits[0].from <= 6.05, JSON.stringify(hits));
}

// 診断: 動き量の最大(しきい値に対する割合)、姿勢が取れたコマ、姿勢が途切れた最長
{
  const log = [];
  for (let i = 0; i <= 30; i++) { const t = i / 10; log.push({ t, s: i === 15 ? 0.08 : 0.02, p: !(t > 1 && t < 1.65) }); }
  const d = missDiag(log, 0.1, 0, 3);
  assert.equal(d.peak, 0.8);
  assert.equal(d.total, 31);
  assert.equal(d.posed, 31 - 6);   // 1.1〜1.6 の 6 コマが抜けている
  assert.equal(d.longestGap, 0.7); // 1.0 → 1.7
}
// 範囲の終わりまで姿勢が戻らなかったときも、途切れとして数える
assert.equal(missDiag([{ t: 0, s: 0, p: true }, { t: 1, s: 0, p: false }, { t: 2, s: 0, p: false }], 0.1, 0, 2).longestGap, 2);

// 上限: 未認識だけを新しい順に数え、超えた分(古いもの)を消す。ふつうの投球は消さない
{
  const recs = [];
  for (let i = 0; i < 25; i++) recs.push({ id: 'm' + i, missed: true, date: i });
  recs.push({ id: 'ok', date: -1 });
  const del = overflowMissed(recs, 20);
  assert.deepEqual(del.sort(), ['m0', 'm1', 'm2', 'm3', 'm4']);
}
console.log('missed OK');
