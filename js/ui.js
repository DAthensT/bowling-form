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
// ・倍率のボタン(.5 / 1 / 2 / 3 など、端末が対応する範囲だけ)をタップで切り替える。切り替えは、なめらかに(約0.3秒)
// ・ボタンを押したまま左右になぞると、ボタンの列の場所に弧のダイヤルが出て、細かく調整できる(左へなぞると拡大)
// ・映像を2本指でピンチしても変わる(ダイヤルが出る)
// 見た目(ダイヤル・数字)は指の動きに合わせて連続で動かし、カメラには「前の変更が終わったら、最新の値を1つだけ」送る
// (送り続けるとカメラ側で詰まって、ガクガクになる)。カメラへの反映は main.js(倍率のスライダー #zoom の input)
function initZoom() {
  const ctl = $('zoomField'), range = $('zoom'), chipsEl = ctl.querySelector('.zoom-chips');
  const ruler = ctl.querySelector('.zoom-ruler'), readout = ctl.querySelector('.zoom-readout');
  const wrap = document.querySelector('.stage-wrap');
  const lim = () => ({ min: Number(range.min) || 1, max: Number(range.max) || 1, step: Number(range.step) || 0.1 });
  const clampZ = (z) => { const { min, max } = lim(); return Math.min(max, Math.max(min, z)); };
  const fmtZ = (z) => { const r = Math.round(z * 10) / 10; return (Number.isInteger(r) ? String(r) : r.toFixed(1)).replace(/^0\./, '.'); };
  const f1 = (v) => v.toFixed(1);
  let shown = Number(range.value) || 1;   // 画面に出している倍率(連続)
  let busy = false;                       // 利用者が操作している(この間は、カメラ側の値で表示を上書きしない)

  // ---- ボタン
  let presets = [], key = '';
  function buildPresets() {
    const { min, max } = lim();
    const k = min + '-' + max;
    if (k === key) return;
    key = k;
    presets = [];
    if (min < 0.95) presets.push(Math.max(min, 0.5));
    if (min <= 1 && max >= 1) presets.push(1);
    if (max >= 2) presets.push(2);
    if (max >= 5) presets.push(5); else if (max >= 3) presets.push(3);
    if (!presets.length) presets.push(min);
    chipsEl.innerHTML = presets.map((z, i) => '<button type="button" class="zoom-chip" data-i="' + i + '"></button>').join('');
    buildRuler();
  }

  // ---- 弧のダイヤル: 大きな円の上の端だけを、画面幅いっぱいの帯として見せる。いまの倍率が、いつも真上(黄色の印)に来るように回す
  const VW = 400, VH = 96, R = 460, CX = VW / 2, CY = R + 30, SPAN = 55;   // SPAN: 倍率が10倍になる角度(対数の目盛り)
  const angleOf = (z) => SPAN * Math.log10(z / lim().min);
  const zOfAngle = (a) => lim().min * Math.pow(10, a / SPAN);
  const pt = (rr, deg) => { const t = (deg * Math.PI) / 180; return [CX + rr * Math.sin(t), CY - rr * Math.cos(t)]; };
  function buildRuler() {
    const total = angleOf(lim().max);
    let ticks = '';
    for (let i = 0; ; i++) {   // 目盛り: 角度で等間隔
      const a = i * 1.6;
      if (a > total + 0.01) break;
      const p1 = pt(R - 6, a), p2 = pt(R - 14, a);
      ticks += '<line x1="' + f1(p1[0]) + '" y1="' + f1(p1[1]) + '" x2="' + f1(p2[0]) + '" y2="' + f1(p2[1]) + '"/>';
    }
    for (const p of presets) {
      const a = angleOf(p);
      const p1 = pt(R - 6, a), p2 = pt(R - 20, a), tp = pt(R - 33, a);
      ticks += '<line class="mj" x1="' + f1(p1[0]) + '" y1="' + f1(p1[1]) + '" x2="' + f1(p2[0]) + '" y2="' + f1(p2[1]) + '"/>' +
        '<text x="' + f1(tp[0]) + '" y="' + f1(tp[1]) + '" transform="rotate(' + a.toFixed(2) + ' ' + f1(tp[0]) + ' ' + f1(tp[1]) + ')">' + fmtZ(p) + '</text>';
    }
    // 帯(下地)は、画面の左右の端まで届く角度で描く
    const half = 32, r2 = R - 46;
    const A = pt(R, -half), B = pt(R, half), C = pt(r2, half), D = pt(r2, -half);
    const band = 'M' + f1(A[0]) + ' ' + f1(A[1]) + ' A' + R + ' ' + R + ' 0 0 1 ' + f1(B[0]) + ' ' + f1(B[1]) +
      ' L' + f1(C[0]) + ' ' + f1(C[1]) + ' A' + r2 + ' ' + r2 + ' 0 0 0 ' + f1(D[0]) + ' ' + f1(D[1]) + 'Z';
    ruler.setAttribute('viewBox', '0 0 ' + VW + ' ' + VH);
    ruler.innerHTML = '<path class="zr-band" d="' + band + '"/><g class="zr" style="transform-origin:' + CX + 'px ' + CY + 'px">' + ticks + '</g>' +
      '<path class="zr-mark" d="M' + (CX - 5) + ' ' + (CY - R + 1) + ' L' + (CX + 5) + ' ' + (CY - R + 1) + ' L' + CX + ' ' + (CY - R + 8) + 'Z"/>';
  }

  // ---- 表示(連続で動かす)
  function render() {
    buildPresets();
    const z = shown;
    let act = 0;
    presets.forEach((p, i) => { if (z >= p - 0.05) act = i; });   // いまの倍率に一番近い(超えない)ボタンが、いまの倍率を出す
    chipsEl.querySelectorAll('.zoom-chip').forEach((b, i) => {
      const on = i === act;
      if (b.classList.contains('on') !== on) b.classList.toggle('on', on);
      const t = on ? fmtZ(z) + '×' : fmtZ(presets[i]);
      if (b.textContent !== t) b.textContent = t;
      b.setAttribute('aria-label', fmtZ(presets[i]) + '倍');
      b.setAttribute('aria-pressed', String(on));
    });
    const t = fmtZ(z) + '×';
    if (readout.textContent !== t) readout.textContent = t;
    const g = ruler.querySelector('.zr');
    if (g) g.style.transform = 'rotate(' + (-angleOf(z)).toFixed(3) + 'deg)';
    updatePreview();
  }

  // ---- なめらかさ: カメラの倍率は段々にしか変えられない(反映にも少し時間がかかる)。
  // カメラが追いつくまでの間だけ、プレビューの映像(と骨格)を画面上で拡大・縮小してつなぐ。追いついたら等倍に戻る
  // 拡大するのは、枠(#stage)の中の映像と骨格だけ。枠の大きさは変えない(枠ごと拡大すると、映像の範囲が伸び縮みして見える)
  const stageEl = $('stage'), videoEl = $('video'), overlayEl = $('overlay');
  let camZ = Number(range.value) || 1;   // カメラに反映済みの倍率
  let camSeq = 0;
  function setPreviewScale(t) {
    if (videoEl.style.transform === t) return;
    videoEl.style.transform = t;
    overlayEl.style.transform = t;
  }
  function updatePreview() {
    const k = shown / camZ;
    setPreviewScale(Math.abs(k - 1) < 0.002 ? '' : 'scale(' + k.toFixed(4) + ')');
  }
  /** カメラが倍率 z に変わった。その倍率のコマが画面に出てから(2コマ後)、つなぎの拡大を外す */
  function cameraCaught(z) {
    const seq = ++camSeq;
    const fin = () => { if (seq === camSeq) { camZ = z; updatePreview(); } };
    if (videoEl.requestVideoFrameCallback) {
      let n = 0;
      const cb = () => { if (++n >= 2) fin(); else videoEl.requestVideoFrameCallback(cb); };
      videoEl.requestVideoFrameCallback(cb);
      setTimeout(fin, 200);   // コマが来ないときも、外す
    } else setTimeout(fin, 60);
  }

  // ---- カメラへ送る(前の変更が終わってから、最新の値を1つだけ)
  let inflight = false, pending = null, guard = 0;
  const quant = (z) => { const { step } = lim(); return Number((Math.round(clampZ(z) / step) * step).toFixed(3)); };
  function flush() {
    if (inflight || pending === null) return;
    const z = pending; pending = null;
    if (Math.abs(Number(range.value) - z) < 1e-6) return;
    inflight = true;
    range.value = String(z);
    range.dispatchEvent(new Event('input', { bubbles: true }));
    clearTimeout(guard);
    guard = setTimeout(notApplied, 400);   // 反映の知らせが来ない(失敗した)ときも、止まらないように
  }
  function applied() { clearTimeout(guard); inflight = false; cameraCaught(Number(range.value) || camZ); flush(); }
  /** カメラに反映できなかった: 画面上の拡大で見せている倍率を、本当の倍率に戻す(うそを見せない) */
  function notApplied() {
    inflight = false;
    flush();
    if (!inflight && !busy && pending === null) { shown = camZ; range.value = String(camZ); render(); }
  }
  // 指を動かしている間(busy)は、カメラの倍率は変えず、画面上の拡大だけで見せる。
  // カメラの倍率を変えるたびに映像が一瞬切り替わり(Web では、その瞬間をコマに合わせられない)、段差になるため。
  // 指を離したとき・指を止めて少したったときに、1回だけカメラへ送る
  let idleTimer = 0;
  const commit = () => { clearTimeout(idleTimer); pending = quant(shown); flush(); };
  const setShown = (z) => {
    shown = clampZ(z); render();
    clearTimeout(idleTimer);
    if (busy) idleTimer = setTimeout(commit, 300);
    else commit();
  };

  // ボタンのタップ: なめらかに切り替える
  let anim = 0;
  function animateTo(z) {
    cancelAnimationFrame(anim);
    const from = shown, to = clampZ(z), t0 = performance.now(), DUR = 280;
    busy = true;
    const stepF = (now) => {
      const k = Math.min(1, (now - t0) / DUR), e = 1 - Math.pow(1 - k, 3);
      setShown(from * Math.pow(to / from, e));   // 倍率の比で補間(見た目の拡大の速さが一定になる)
      if (k < 1) anim = requestAnimationFrame(stepF); else { busy = false; commit(); }
    };
    anim = requestAnimationFrame(stepF);
  }

  // ダイヤルは、出ている間は帯のどこをつかんでも回せる(指を離しても、少しの間は出たまま)。触らなくなったら消える
  const dialEl = ctl.querySelector('.zoom-dial');
  let hideTimer = 0;
  const showDial = () => { clearTimeout(hideTimer); ctl.classList.add('dialing'); };
  const hideDialSoon = () => { clearTimeout(hideTimer); hideTimer = setTimeout(() => ctl.classList.remove('dialing'), 1600); };

  // ボタン: タップで切り替え。押したまま左右になぞるとダイヤル。ダイヤルの帯: なぞって回す
  let drag = null;
  const startDrag = (el, onDial) => (e) => {
    if (drag) return;
    cancelAnimationFrame(anim);
    drag = { id: e.pointerId, el, x0: e.clientX, a0: angleOf(shown), moved: onDial, chip: onDial ? null : e.target.closest('.zoom-chip') };
    busy = true;
    if (onDial) showDial();
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  };
  const moveDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    if (!drag.moved) { if (Math.abs(dx) < 5) return; drag.moved = true; drag.x0 = e.clientX; showDial(); return; }
    // 指の下の目盛りが、指と一緒に動く量(帯の上で 1px ≒ 円周の 1px)
    const degPerPx = (180 / Math.PI) / (R * ruler.getBoundingClientRect().width / VW);
    setShown(zOfAngle(drag.a0 - dx * degPerPx));
  };
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null; busy = false;
    if (!d.moved && d.chip) animateTo(presets[Number(d.chip.dataset.i)]);
    else { commit(); hideDialSoon(); }
  };
  for (const [el, onDial] of [[chipsEl, false], [dialEl, true]]) {
    el.addEventListener('pointerdown', startDrag(el, onDial));
    el.addEventListener('pointermove', moveDrag);
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('lostpointercapture', endDrag);   // 指の終わりの知らせを取りこぼしても、次の操作が効くように
  }

  // ピンチ: 2本の指の間隔の比で、倍率を変える
  const pts = new Map();
  let pinch = null;
  const dist = () => { const v = [...pts.values()]; return Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y); };
  wrap.addEventListener('pointerdown', (e) => {
    if (ctl.hidden || e.target.closest('button, input, #startPanel, .zoom-ctl')) return;
    if (pts.size >= 2) { pts.clear(); pinch = null; }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { cancelAnimationFrame(anim); pinch = { d0: dist(), z0: shown }; busy = true; showDial(); }
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) setShown(pinch.z0 * dist() / Math.max(1, pinch.d0));
  });
  const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2 && pinch) { pinch = null; busy = false; commit(); hideDialSoon(); } };
  // 指を離した知らせは、どこで離しても受け取る(取りこぼすと、残った指で次の操作がピンチと誤認される)
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);

  // main.js がカメラに反映し終えたとき(#zoomVal が書き換わる)。開始時の、保存した倍率の復元も、これで表示に出る
  new MutationObserver(() => {
    const ours = inflight;   // この画面から送った変更の反映か(そうでなければ、開始時の復元など)
    applied();
    if (!ours && !busy && pending === null) { camSeq++; shown = camZ = Number(range.value) || shown; render(); }
  }).observe($('zoomVal'), { childList: true, characterData: true, subtree: true });
  new MutationObserver(() => {   // 撮影の開始・停止
    key = ''; camSeq++;
    shown = camZ = Number(range.value) || 1;
    setPreviewScale('');
    requestAnimationFrame(render);
  }).observe(ctl, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(() => { key = ''; requestAnimationFrame(render); }).observe(range, { attributes: true, attributeFilter: ['min', 'max'] });
  render();
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
