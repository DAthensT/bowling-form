// 「その日の投球」をまとめて扱うための小さな部品(DOM/外部依存なし)。

const pad = (n) => String(n).padStart(2, '0');

/** 端末のローカル時刻での日付 'YYYY-MM-DD'(ボウリングに行った「その日」は、UTC ではなく手元の日付で数える) */
export function localDay(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * まとめて PC へ送る対象。day の投球を古い順に。resend が false なら、送信済み(sentToPcAt あり)は除く。
 * records: [{id, date, sentToPcAt?}]
 */
export function pendingForDay(records, day, resend = false) {
  return records
    .filter((r) => localDay(r.date) === day && (resend || !r.sentToPcAt))
    .sort((a, b) => a.date - b.date);
}

/** 投球のある日の一覧(新しい日が先頭)。各日の投球数と、未送信の数。 */
export function daysWithCounts(records) {
  const map = new Map();
  for (const r of records) {
    const d = localDay(r.date);
    const e = map.get(d) || { day: d, count: 0, unsent: 0 };
    e.count += 1;
    if (!r.sentToPcAt) e.unsent += 1;
    map.set(d, e);
  }
  return [...map.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}
