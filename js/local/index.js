// ローカル版(開発用)だけの機能の入口。main.js が EDITION === 'local' のときだけ読み込む。
// 一般公開版(GitHub Pages)には、このフォルダごと含まれない。
import { initPcLink } from './pc-link.js';

/**
 * ctx: { $, allThrows, putThrow, settings, getOpenRecord, renderHistory }
 * 戻り値(main.js が呼ぶフック):
 *   tag(record)        履歴の1行に足す HTML
 *   onHistory(items)   履歴を描いたとき
 *   onDetail(record)   詳細を開いたとき
 */
export function initLocal(ctx) {
  banner();
  return initPcLink(ctx);
}

/** どの版を開いているか、画面で分かるようにする */
function banner() {
  const b = document.createElement('div');
  b.style.cssText = 'background:#7a4b00;color:#fff;text-align:center;font-size:12px;padding:2px 0;padding-top:max(2px,env(safe-area-inset-top))';
  b.textContent = 'ローカル版(開発機能あり)';
  document.body.prepend(b);
  document.title += '(ローカル)';
}
