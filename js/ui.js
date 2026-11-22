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
  initZoom();
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
    side.parentElement.style.setProperty('--peek', peek + 'px');   // 倍率のボタンを、帯のすぐ上に置くため
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

// ---------------------------------------------------------------- 撮影の倍率(映像の上。iPhone のカメラと同じ操作)
// ・倍率のボタン(.5 / 1 / 2 / 3 など、端末が対応する範囲だけ)をタップで切り替える。選んでいるボタンは黄色で「1×」
// ・ボタンを押したまま左右になぞると、上に目盛りのダイヤルが出て、細かく調整できる(左へなぞると拡大)
// ・映像を2本指でピンチしても変わる(ダイヤルが出る)
// どれも、倍率のスライダー(#zoom。画面には出さない)の値を変えて input を送るだけ。カメラへの反映は main.js
const SVGNS = 'http://www.w3.org/2000/svg';
function initZoom() {
  const ctl = $('zoomField'), range = $('zoom'), chipsEl = ctl.querySelector('.zoom-chips');
  const dial = ctl.querySelector('.zoom-dial'), ruler = ctl.querySelector('.zoom-ruler'), readout = ctl.querySelector('.zoom-readout');
  const wrap = document.querySelector('.stage-wrap');
  const lim = () => ({ min: Number(range.min) || 1, max: Number(range.max) || 1, step: Number(range.step) || 0.1 });
  const val = () => Number(range.value) || 1;
  const fmtZ = (z) => (Math.abs(z - Math.round(z)) < 0.05 ? String(Math.round(z)) : z.toFixed(1)).replace(/^0\./, '.');

  // ---- ボタン
  let presets = [], key = '';
  function buildPresets() {
    const { min, max } = lim();
    const k = `${min}-${max}`;
    if (k === key) return;
    key = k;
    presets = [];
    if (min < 0.95) presets.push(Math.max(min, 0.5));
    if (min <= 1 && max >= 1) presets.push(1);
    if (max >= 2) presets.push(2);
    if (max >= 5) presets.push(5); else if (max >= 3) presets.push(3);
    if (!presets.length) presets.push(min);
    chipsEl.innerHTML = presets.map((z, i) => `<button type="button" class="zoom-chip" data-i="${i}"></button>`).join('');
    buildRuler();
  }
  function renderChips() {
    buildPresets();
    const z = val();
    // いまの倍率に一番近い(超えない)ボタンが、いまの倍率を出す
    let act = 0;
    presets.forEach((p, i) => { if (z >= p - 0.05) act = i; });
    chipsEl.querySelectorAll('.zoom-chip').forEach((b, i) => {
      const on = i === act;
      b.classList.toggle('on', on);
      b.textContent = on ? fmtZ(z) + '×' : fmtZ(presets[i]);
      b.setAttribute('aria-label', `${fmtZ(presets[i])}倍`);
      b.setAttribute('aria-pressed', String(on));
    });
    readout.textContent = fmtZ(z) + '×';
    rotateRuler(z);
  }

  // ---- 目盛りのダイヤル(大きな円の上の一部。いまの倍率が、いつも真上に来るように回す)
  const R = 520, CX = 180, CY = R + 34, SPAN = 60;   // SPAN: 10倍の幅を何度にするか(対数の目盛り)
  const angleOf = (z) => SPAN * Math.log10(z / lim().min);
  function buildRuler() {
    const { min, max } = lim();
    ruler.setAttribute('viewBox', '0 0 360 96');
    let g = '';
    const total = angleOf(max);
    for (let a = 0; a <= total + 0.01; a += 2) {
      const major = presets.some((p) => Math.abs(angleOf(p) - a) < 1);
      g += `<line x1="${CX}" y1="${CY - R}" x2="${CX}" y2="${CY - R + (major ? 14 : 8)}" transform="rotate(${a} ${CX} ${CY})" class="${major ? 'mj' : ''}"/>`;
    }
    for (const p of presets) g += `<text x="${CX}" y="${CY - R + 30}" transform="rotate(${angleOf(p)} ${CX} ${CY})">${fmtZ(p)}</text>`;
    ruler.innerHTML = `<g class="zr">${g}</g><path class="zr-mark" d="M${CX - 5} ${CY - R - 9} L${CX + 5} ${CY - R - 9} L${CX} ${CY - R - 2}Z"/>`;
    void min;
  }
  function rotateRuler(z) {
    const g = ruler.querySelector('.zr');
    if (g) g.setAttribute('transform', `rotate(${-angleOf(z)} ${CX} ${CY})`);
  }

  // ---- 値を変える(1コマに1回だけ。カメラの設定変更は重い)
  let want = null, raf = 0;
  const push = () => {
    raf = 0;
    if (want === null || Math.abs(val() - want) < 1e-6) return;
    range.value = String(want);
    $('zoomVal').textContent = want.toFixed(1) + '×';
    renderChips();
    range.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const setZoom = (z) => {
    const { min, max, step } = lim();
    want = Math.round(Math.min(max, Math.max(min, z)) / step) * step;
    want = Number(want.toFixed(3));
    if (!raf) raf = requestAnimationFrame(push);
  };
  let hideTimer = 0;
  const showDial = () => { ctl.classList.add('dialing'); clearTimeout(hideTimer); };
  const hideDialSoon = () => { clearTimeout(hideTimer); hideTimer = setTimeout(() => ctl.classList.remove('dialing'), 1200); };

  // ボタン: タップで切り替え。押したまま左右になぞるとダイヤル
  let drag = null;
  chipsEl.addEventListener('pointerdown', (e) => {
    drag = { id: e.pointerId, x0: e.clientX, a0: angleOf(val()), moved: false, chip: e.target.closest('.zoom-chip') };
    try { chipsEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  chipsEl.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    if (!drag.moved) { if (Math.abs(dx) < 6) return; drag.moved = true; showDial(); }
    setZoom(lim().min * Math.pow(10, (drag.a0 - dx * 0.25) / SPAN));   // 左へなぞると拡大(ダイヤルが左へ回る)
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (!d.moved && d.chip) setZoom(presets[Number(d.chip.dataset.i)]);
    hideDialSoon();
  };
  chipsEl.addEventListener('pointerup', endDrag);
  chipsEl.addEventListener('pointercancel', endDrag);

  // ピンチ: 2本の指の間隔の比で、倍率を変える
  const pts = new Map();
  let pinch = null;
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  wrap.addEventListener('pointerdown', (e) => {
    if (ctl.hidden || e.target.closest('button, input, #startPanel, .zoom-ctl')) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { pinch = { d0: dist(), z0: val() }; showDial(); }
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) setZoom(pinch.z0 * dist() / Math.max(1, pinch.d0));
  });
  const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2 && pinch) { pinch = null; hideDialSoon(); } };
  wrap.addEventListener('pointerup', up);
  wrap.addEventListener('pointercancel', up);

  // main.js がカメラに合わせて範囲や値を変えたとき(開始時・保存した倍率の復元)も、表示を合わせる
  new MutationObserver(() => requestAnimationFrame(renderChips)).observe($('zoomVal'), { childList: true, characterData: true, subtree: true });
  new MutationObserver(() => { key = ''; requestAnimationFrame(renderChips); }).observe(ctl, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(() => { key = ''; requestAnimationFrame(renderChips); }).observe(range, { attributes: true, attributeFilter: ['min', 'max'] });
  renderChips();
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
