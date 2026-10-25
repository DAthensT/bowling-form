// 直近の投球との比較(改善/悪化)と推移の傾向(DOM/外部依存なし)。
//
// 「良くなった/悪くなった」は、目標値にどれだけ近づいたかで決める。
//   目標値 = お手本があればその平均、なければ「良い範囲」の中央。片側だけ制約する指標は範囲の外へどれだけ出たか。
//   ずれは指標ごとの許容幅 tol を単位にそろえる(角度と比率を同じ尺度で比べられるように)。
import { SPECS, effectiveRange } from './analyzer.js';

export const RECENT = 5;          // 比較に使う直近の投球数
export const TREND_MAX = 8;       // 傾向を見る投球数(現在の投球を含む)
export const TREND_MIN = 4;       // 傾向を言うのに必要な投球数(現在の投球を含む)
export const VERDICT_THRESHOLD = 0.75; // ずれの変化がこの大きさ(tol 単位)以上なら改善/悪化とする
export const TREND_THRESHOLD = 1.0;    // 推移全体でのずれの変化がこの大きさ以上なら傾向ありとする

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

const goodRange = (key, preset) => effectiveRange(key, preset).good;

/** 目標値からのずれ(0 が理想、tol 単位) */
export function deviation(key, value, preset = null) {
  const spec = SPECS[key];
  const good = goodRange(key, preset);
  if (spec.side === 'min') return Math.max(0, good[0] - value) / spec.tol;
  if (spec.side === 'max') return Math.max(0, value - good[1]) / spec.tol;
  const stat = preset && preset.stats && preset.stats[key];
  const center = stat ? stat.mean : (good[0] + good[1]) / 2;
  return Math.abs(value - center) / spec.tol;
}

/** 回帰直線の傾き(1投あたり) */
function slope(ys) {
  const n = ys.length;
  const mx = (n - 1) / 2, my = mean(ys);
  let num = 0, den = 0;
  ys.forEach((y, i) => { num += (i - mx) * (y - my); den += (i - mx) ** 2; });
  return den ? num / den : 0;
}

/**
 * 同じ撮影位置・利き手の、解析済みの投球だけを新しい順に取り出す。
 * records: [{date, view, hand, report}]
 */
export function selectHistory(records, { view, hand, method }) {
  return records
    .filter(r => r.report && r.report.isValidThrow !== false && (r.view || 'side') === view && r.hand === hand
      && (!method || (r.report.method || '2d') === method))
    .sort((a, b) => b.date - a.date)
    .map(r => r.report);
}

const fmt = (key, v) => v.toFixed(SPECS[key].digits) + SPECS[key].unit;

/**
 * report: 今回の解析結果。prevReports: 過去の解析結果(新しい順)。preset: 使用中のお手本(任意)。
 * 戻り値: { n, items:[{key,title,display,avgDisplay,verdict,trend}], summary }。比較できる過去がなければ n = 0。
 */
export function compare(report, prevReports, preset = null) {
  const recent = prevReports.slice(0, RECENT);
  if (!recent.length) return { n: 0, items: [], summary: '' };

  const items = [];
  for (const m of report.metrics) {
    if (m.status === 'info' || !SPECS[m.key]) continue;
    const pv = recent.map(r => (r.metrics.find(x => x.key === m.key) || {}).value).filter(v => typeof v === 'number');
    if (!pv.length) continue;

    const devNow = deviation(m.key, m.value, preset);
    const devPrev = mean(pv.map(v => deviation(m.key, v, preset)));
    const d = devNow - devPrev;
    const verdict = d <= -VERDICT_THRESHOLD ? 'better' : d >= VERDICT_THRESHOLD ? 'worse' : 'same';

    // 推移: 古い順に並べた直近の値(今回を含む)のずれの回帰
    let trend = null;
    const series = prevReports.slice(0, TREND_MAX - 1)
      .map(r => (r.metrics.find(x => x.key === m.key) || {}).value)
      .filter(v => typeof v === 'number').reverse().concat([m.value]);
    if (series.length >= TREND_MIN) {
      const total = slope(series.map(v => deviation(m.key, v, preset))) * (series.length - 1);
      trend = total <= -TREND_THRESHOLD ? 'improving' : total >= TREND_THRESHOLD ? 'declining' : 'flat';
    }
    items.push({
      key: m.key, title: SPECS[m.key].title, display: m.display,
      avgDisplay: fmt(m.key, mean(pv)), verdict, trend
    });
  }
  return { n: recent.length, items, summary: summarize(items, recent.length) };
}

function summarize(items, n) {
  const names = (list) => list.slice(0, 2).map(i => i.title).join('と');
  const better = items.filter(i => i.verdict === 'better');
  const worse = items.filter(i => i.verdict === 'worse');
  const parts = [];
  if (better.length || worse.length) {
    if (better.length) parts.push(`直近${n}投と比べて、${names(better)}が良くなっています。`);
    if (worse.length) parts.push(`${better.length ? '一方、' : `直近${n}投と比べて、`}${names(worse)}が悪化しています。`);
  } else {
    parts.push(`直近${n}投と比べて、大きな変化はありません。`);
  }
  const up = items.filter(i => i.trend === 'improving'), down = items.filter(i => i.trend === 'declining');
  if (up.length) parts.push(`ここ数投は${names(up)}が改善傾向です。`);
  if (down.length) parts.push(`${names(down)}は悪化傾向なので注意しましょう。`);
  return parts.join('');
}
