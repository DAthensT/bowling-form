// お手本プリセット: 複数の投球の指標を集計し、「良い範囲」を導出する(DOM/外部依存なし)。
import { SPECS } from './analyzer.js';

const BIG = 1e9;

/**
 * reports: analyze() の戻り値(isValidThrow なもの)の配列。
 * 平均 mean と標準偏差 sd から、良い範囲 = mean ± max(sd, tol)、注意の範囲 = mean ± max(2sd, 2tol)。
 * tol は指標ごとの許容幅の下限(1投球だけでも極端に狭くならないように)。
 */
export function buildPreset({ name, source = '', view, hand, reports }) {
  const byKey = {};
  for (const r of reports) {
    for (const m of r.metrics) {
      if (m.status === 'info' || !SPECS[m.key]) continue;
      (byKey[m.key] ||= []).push(m.value);
    }
  }
  const stats = {};
  const ranges = {};
  for (const [key, vals] of Object.entries(byKey)) {
    const spec = SPECS[key];
    const n = vals.length;
    const mean = vals.reduce((a, v) => a + v, 0) / n;
    const sd = n > 1 ? Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : 0;
    stats[key] = { n, mean, sd, min: Math.min(...vals), max: Math.max(...vals) };
    const gh = Math.max(sd, spec.tol), oh = Math.max(2 * sd, 2 * spec.tol);
    if (spec.side === 'min') ranges[key] = { good: [mean - gh, BIG], ok: [mean - oh, BIG] };
    else if (spec.side === 'max') ranges[key] = { good: [0, mean + gh], ok: [0, mean + oh] };
    else ranges[key] = { good: [mean - gh, mean + gh], ok: [mean - oh, mean + oh] };
  }
  return {
    id: (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2),
    name, source, view, hand, method: (reports[0] && reports[0].method) || '2d', createdAt: Date.now(), throwsCount: reports.length, stats, ranges
  };
}

const fmt = (key, v) => v.toFixed(SPECS[key].digits) + SPECS[key].unit;

/** 画面表示用の行: {title, mean, sd, n, range} */
export function describePreset(preset) {
  return Object.keys(preset.stats).filter(k => SPECS[k]).map((key) => {
    const st = preset.stats[key], r = preset.ranges[key].good;
    const range = r[1] >= BIG ? `${fmt(key, r[0])} 以上` : r[0] <= 0 && SPECS[key].side === 'max' ? `${fmt(key, r[1])} 以下` : `${fmt(key, r[0])} 〜 ${fmt(key, r[1])}`;
    return { title: SPECS[key].title, mean: fmt(key, st.mean), sd: '±' + st.sd.toFixed(SPECS[key].digits), n: st.n, range };
  });
}

/** 読み込んだ JSON が最低限プリセットの形をしているか確認する */
export function validatePreset(p) {
  return !!p && typeof p.name === 'string' && (p.view === 'side' || p.view === 'rear')
    && p.stats && p.ranges && Object.keys(p.ranges).every(k => Array.isArray(p.ranges[k].good) && Array.isArray(p.ranges[k].ok));
}
