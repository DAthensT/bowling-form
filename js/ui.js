// 画面の見た目・使い勝手だけの処理(撮影・解析などの機能には関わらない)
//   - 撮影画面の下の引き出し(iPhone のカメラのように、下から上へスライドすると情報が出てくる)
//   - 「撮影の設定」を畳んだときに、いまの設定を一行で見せる
//   - 撮影中のリアルタイム指標(映像の上に重ねる)の開閉
const $ = (id) => document.getElementById(id);
const label = (id) => { const s = $(id); return s && s.selectedOptions[0] ? s.selectedOptions[0].textContent.replace(/\(.*\)$/, '') : ''; };

function renderSetupSummary() {
  const parts = [label('handLive'), label('viewLive')];
  if ($('region').value !== 'all') parts.push(label('region'));
  if ($('sens').value !== 'normal') parts.push('感度 ' + label('sens'));
  if ($('presetLive').value) parts.push('お手本 ' + label('presetLive'));
  $('setupSummary').textContent = parts.filter(Boolean).join('・');
}

let sheet = null;

export function initUi() {
  // 設定の値は、ほかの処理(main.js)からも変わるので、変更・描き直しのたびに作り直す
  const refresh = () => requestAnimationFrame(renderSetupSummary);
  document.addEventListener('change', refresh);
  document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', refresh));
  new MutationObserver(refresh).observe($('presetLive'), { childList: true });
  refresh();

  sheet = initSheet();
  document.querySelector('[data-open-setup]').addEventListener('click', () => {
    const d = $('setup');
    d.open = true;
    sheet.open();
    setTimeout(() => d.scrollIntoView({ behavior: 'smooth', block: 'start' }), 340);
  });

  initHud();
}

// ---------------------------------------------------------------- 撮影画面の下の引き出し
// 縦向きのときだけ。閉じているときは、上の帯(つまみ・状態・停止ボタン)だけが見えている。
// つまみ・帯を上へスライド(またはタップ)で開き、下へスライドで閉じる。開いている中身は、その中でスクロールできる。
// 横向きのときは、これまでどおり右側の欄(引き出しにはしない)。
function initSheet() {
  const side = document.querySelector('.side');
  const grip = side.querySelector('.sheet-grip');
  const peekEl = side.querySelector('.status-card');
  const portrait = window.matchMedia('(orientation: portrait)');
  let isOpen = false, peek = 0, full = 0, drag = null;

  const enabled = () => portrait.matches;
  /** 閉じたときに見せる高さ = つまみ + 状態の帯 */
  const measure = () => {
    peek = Math.ceil(grip.offsetHeight + peekEl.offsetHeight + 2);
    full = side.offsetHeight;
    side.style.setProperty('--peek', peek + 'px');
  };
  const offsetFor = (open) => (open ? 0 : Math.max(0, full - peek));
  const apply = (animate) => {
    if (!enabled()) { side.style.transform = ''; side.classList.remove('sheet-open'); return; }
    side.style.transition = animate ? 'transform .32s cubic-bezier(.2,.8,.2,1)' : 'none';
    side.style.transform = `translateY(${offsetFor(isOpen)}px)`;
    side.classList.toggle('sheet-open', isOpen);
    grip.setAttribute('aria-expanded', String(isOpen));
    if (!isOpen) side.scrollTop = 0;
  };
  const set = (open) => { isOpen = open; measure(); apply(true); };

  // 指の動き(つまみと状態の帯の上だけ。中身のスクロールとぶつからないように)
  const onDown = (e) => {
    if (!enabled() || e.target.closest('button:not(.sheet-grip), select, input, a')) return;
    measure();
    drag = { id: e.pointerId, y0: e.clientY, base: offsetFor(isOpen), moved: false, pts: [[e.clientY, performance.now()]] };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    if (!drag.moved) { if (Math.abs(dy) < 6) return; drag.moved = true; side.style.transition = 'none'; }
    drag.pts.push([e.clientY, performance.now()]); if (drag.pts.length > 6) drag.pts.shift();
    const y = Math.min(full - peek, Math.max(0, drag.base + dy));
    side.style.transform = `translateY(${y}px)`;
  };
  const onUp = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (!d.moved) { if (e.currentTarget === grip) set(!isOpen); return; }   // つまみのタップで開閉
    const a = d.pts[0], b = d.pts[d.pts.length - 1];
    const v = (b[0] - a[0]) / Math.max(1, b[1] - a[1]);   // px/ms(上向きが負)
    const y = d.base + (e.clientY - d.y0);
    set(Math.abs(v) > 0.3 ? v < 0 : y < (full - peek) / 2);
  };
  for (const el of [grip, peekEl]) {
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.id) { drag = null; apply(true); } });
  }

  // 帯の高さ(停止ボタンが出る・メッセージが長いなど)や画面の向きが変わったら、合わせ直す
  new ResizeObserver(() => { measure(); apply(false); }).observe(peekEl);
  new ResizeObserver(() => { measure(); apply(false); }).observe(side);
  portrait.addEventListener('change', () => { measure(); apply(false); });
  measure(); apply(false);
  return { open: () => set(true), close: () => set(false) };
}

// ---------------------------------------------------------------- リアルタイム指標(撮影中、映像の上)
// 見出しをタップで畳む。畳んだかどうかは、この端末に覚える
const HUD_KEY = 'bf.uiHudCollapsed';
function initHud() {
  const hud = $('hud'), head = hud.querySelector('.hud-head');
  const set = (collapsed) => {
    hud.classList.toggle('collapsed', collapsed);
    head.setAttribute('aria-expanded', String(!collapsed));
    try { localStorage.setItem(HUD_KEY, collapsed ? '1' : ''); } catch { /* 覚えられなくても動く */ }
  };
  let saved = false;
  try { saved = localStorage.getItem(HUD_KEY) === '1'; } catch { /* 既定は開く */ }
  set(saved);
  head.addEventListener('click', () => set(!hud.classList.contains('collapsed')));
}
