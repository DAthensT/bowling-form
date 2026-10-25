// 判定基準の調整(DOM/外部依存なし)。
// 肉眼で「悪い/問題なし」とラベルを付けた投球の指標値から、判定の境目を提案する。
import { SPECS } from './analyzer.js';

export const BIG = 1e9;
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

/** 良い範囲から、注意の範囲(指標ごとの許容幅 tol の2倍だけ外側まで)を作る。 */
export function okFromGood(key, [lo, hi]) {
  const tol = SPECS[key].tol;
  return [lo <= -BIG / 2 ? lo : lo - 2 * tol, hi >= BIG / 2 ? hi : hi + 2 * tol];
}

/** ユーザーが入力した良い範囲(空欄は初期値のまま)から上書き設定を作る。両方空欄なら null。 */
export function overrideFromInputs(key, lo, hi) {
  const def = SPECS[key].good;
  if (lo === null && hi === null) return null;
  const good = [lo === null ? def[0] : lo, hi === null ? def[1] : hi];
  if (good[0] > good[1]) good.reverse();
  return { good, ok: okFromGood(key, good) };
}

/**
 * ラベル付きの投球から、ある重点項目・ある指標の値を集める。
 * records: [{labels: {重点項目ID: 'bad'|'ok'}, report: {metrics}}]
 */
export function collectLabeled(records, itemId, key) {
  const out = { bad: [], ok: [] };
  for (const r of records) {
    const verdict = r.labels && r.labels[itemId];
    const m = r.report && r.report.metrics && r.report.metrics.find(x => x.key === key);
    if (!m || (verdict !== 'bad' && verdict !== 'ok')) continue;
    out[verdict].push(m.value);
  }
  return out;
}

/**
 * 判定の境目を提案する。only: 'low' = 値が小さい側が「悪い」/ 'high' = 大きい側が「悪い」。
 *   悪い/問題なしの両方があれば、その間(重なる場合は平均どうしの中間)。
 *   片方しかなければ、そのラベルが確実に範囲の外になるよう、許容幅の半分だけ余裕を取る。
 */
export function suggestBoundary({ key, only, bad, ok }) {
  const tol = SPECS[key].tol;
  if (!bad.length && !ok.length) return { ok: false, note: 'ラベルがありません' };
  const low = only === 'low';
  let boundary;
  let overlap = false;
  if (bad.length && ok.length) {
    const badEdge = low ? Math.max(...bad) : Math.min(...bad); // 「悪い」のうち、良い側に一番近い値
    const okEdge = low ? Math.min(...ok) : Math.max(...ok);    // 「問題なし」のうち、悪い側に一番近い値
    overlap = low ? badEdge >= okEdge : badEdge <= okEdge;
    boundary = overlap ? (mean(bad) + mean(ok)) / 2 : (badEdge + okEdge) / 2;
  } else if (bad.length) {
    boundary = low ? Math.max(...bad) + 0.5 * tol : Math.min(...bad) - 0.5 * tol;
  } else {
    boundary = low ? Math.min(...ok) - 0.5 * tol : Math.max(...ok) + 0.5 * tol;
  }
  return { ok: true, boundary, overlap, nBad: bad.length, nOk: ok.length, onlyOneKind: !(bad.length && ok.length) };
}

/** 境目を、その指標の良い範囲の片側に適用した上書き設定を作る(反対側は初期値のまま)。 */
export function applyBoundary(key, only, boundary) {
  const def = SPECS[key].good;
  const good = only === 'low' ? [boundary, def[1]] : [def[0], boundary];
  if (good[0] > good[1]) good.reverse();
  return { good, ok: okFromGood(key, good) };
}
