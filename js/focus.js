// 「直したい点(重点項目)」: ユーザーが選んだ項目について、毎回、画面・音声・AI の講評で優先して扱う(DOM/外部依存なし)。
import { SPECS } from './analyzer.js';

const GENERIC = ['trunkLean', 'slideKnee', 'elbow', 'backswingHeight', 'shoulderTilt', 'followThrough', 'approachDrift'];

/**
 * bind: この重点項目を判定する指標。only を付けると、その側(low/high)にずれたときだけ問題とみなす
 * (例: 「背負い」は腕が内側に入る側だけ。外側に開いているのは別の問題なのでここでは問題にしない)。
 */
export const FOCUS_OPTIONS = [
  {
    id: 'carry', label: 'ボールを背負う癖',
    hint: 'バックスイングで、ボールや腕が背中側(体の内側・肩より後ろ)に入りすぎていないか(背負い)',
    bind: [{ key: 'backswingOffset', only: 'low' }, { key: 'backswingBehind', only: 'high' }],
    note: {}
  },
  {
    id: 'away', label: '投球時の体からの離れ',
    hint: 'スイング中とリリース時に、ボールや腕が体から外側へ離れていないか',
    bind: [{ key: 'armSeparation', only: 'high' }, { key: 'releaseOffset', only: 'high' }],
    note: { side: '横から撮影では、腕の体からの離れは判定できません(後方撮影で判定します)' }
  },
  ...GENERIC.map(key => ({ id: key, label: SPECS[key].title, hint: `${SPECS[key].title}を重点的に`, bind: [{ key }], note: {} }))
];

export const DEFAULT_FOCUS = ['carry', 'away'];

const RANK = { bad: 3, warn: 2, good: 1, info: 0 };

/** report の指標から、選ばれた重点項目ごとの判定を作る。 */
export function focusItems(report, ids) {
  const out = [];
  for (const id of ids) {
    const opt = FOCUS_OPTIONS.find(o => o.id === id);
    if (!opt) continue;
    const metrics = [];
    for (const b of opt.bind) {
      const m = report.metrics.find(x => x.key === b.key);
      if (!m) continue;
      const relevant = !b.only || m.dir === null || m.dir === b.only;
      metrics.push(relevant ? m : { ...m, status: 'good', advice: '' });
    }
    const status = metrics.reduce((w, m) => (RANK[m.status] > RANK[w] ? m.status : w), 'good');
    out.push({
      id, label: opt.label, hint: opt.hint, metrics, status: metrics.length ? status : 'info',
      unavailable: metrics.length ? '' : (opt.note[report.view] || 'この投球では判定できませんでした(腕を検出できなかった、またはこの撮影位置では測れない項目です)')
    });
  }
  return out;
}

/** 音声・文章用の短い要約。判定できない項目は含めない。 */
export function focusSummary(items) {
  const parts = [];
  for (const it of items.filter(i => !i.unavailable).slice(0, 3)) {
    const worst = it.metrics
      .filter(m => m.status === 'bad' || m.status === 'warn')
      .sort((a, b) => RANK[b.status] - RANK[a.status])[0];
    parts.push(worst ? `${it.label}: ${worst.advice}` : `${it.label}: 問題ありません。`);
  }
  return parts.length ? '重点項目。' + parts.join(' ') : '';
}

/** 重点項目が扱った指標のキー(全体の講評から除外して重複を避けるため) */
export const focusKeys = (items) => [...new Set(items.flatMap(i => i.metrics.map(m => m.key)))];
