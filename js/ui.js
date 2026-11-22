// 画面の見た目・使い勝手だけの処理(撮影・解析などの機能には関わらない)
//   - 「撮影の設定」を畳んだときに、いまの設定を一行で見せる
//   - 撮影開始前の案内から「撮影の設定」を開く
//   - 分析結果の動画の枠を、動画の縦横比に合わせる(骨格の重ね表示が、動画とずれないように)
const $ = (id) => document.getElementById(id);
const label = (id) => { const s = $(id); return s && s.selectedOptions[0] ? s.selectedOptions[0].textContent.replace(/\(.*\)$/, '') : ''; };

function renderSetupSummary() {
  const parts = [label('handLive'), label('viewLive')];
  const region = $('region').value;
  if (region !== 'all') parts.push(label('region'));
  if ($('sens').value !== 'normal') parts.push('感度 ' + label('sens'));
  if ($('presetLive').value) parts.push('お手本 ' + label('presetLive'));
  $('setupSummary').textContent = parts.filter(Boolean).join('・');
}

export function initUi() {
  // 設定の値は、ほかの処理(main.js)からも変わるので、変更・描き直しのたびに作り直す
  const refresh = () => requestAnimationFrame(renderSetupSummary);
  document.addEventListener('change', refresh);
  document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', refresh));
  new MutationObserver(refresh).observe($('presetLive'), { childList: true });
  refresh();

  document.querySelector('[data-open-setup]').addEventListener('click', () => {
    const d = $('setup');
    d.open = true;
    d.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  const v = $('detailVideo');
  v.addEventListener('loadedmetadata', () => {
    if (v.videoWidth && v.videoHeight) $('detailStage').style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`;
  });

  initHud();
  initDetailControls(v);
}

// 撮影中のリアルタイム指標(映像の上に重ねる)。見出しをタップで畳む。畳んだかどうかは、この端末に覚える
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

// 分析結果の動画の再生操作(ブラウザ標準の操作バーの代わり)。映像をタップで再生/一時停止
const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  // 投球の動画は数秒なので、0.1秒まで出す(フォームの確認で、どの瞬間かが分かるように)
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
};
function initDetailControls(v) {
  const stage = $('detailStage');
  const play = stage.querySelector('.vc-play'), seek = stage.querySelector('.vc-seek');
  const cur = stage.querySelector('.vc-time'), dur = stage.querySelector('.vc-dur'), full = stage.querySelector('.vc-full');
  let seeking = false, raf = 0;

  const paint = () => {
    const d = Number.isFinite(v.duration) ? v.duration : 0;
    if (!seeking) seek.value = d ? String(v.currentTime / d) : '0';
    seek.style.setProperty('--p', `${(Number(seek.value) * 100).toFixed(2)}%`);
    cur.textContent = fmt(v.currentTime);
    dur.textContent = fmt(d);
  };
  const tick = () => { paint(); raf = v.paused ? 0 : requestAnimationFrame(tick); };
  const sync = () => {
    const playing = !v.paused && !v.ended;
    stage.classList.toggle('playing', playing);
    play.innerHTML = `<svg class="ic"><use href="#i-${playing ? 'pause' : 'play'}"/></svg>`;
    play.setAttribute('aria-label', playing ? '一時停止' : '再生');
    cancelAnimationFrame(raf);
    tick();
  };
  const toggle = () => {
    if (v.paused || v.ended) { const p = v.play(); if (p && p.catch) p.catch(() => {}); } else v.pause();
  };

  ['play', 'pause', 'ended', 'loadedmetadata', 'emptied'].forEach((e) => v.addEventListener(e, sync));
  ['timeupdate', 'seeked', 'durationchange'].forEach((e) => v.addEventListener(e, paint));
  play.addEventListener('click', toggle);
  // 映像のタップで再生/一時停止(操作バーの上は除く)
  stage.addEventListener('click', (e) => { if (!e.target.closest('.vc')) toggle(); });
  seek.addEventListener('input', () => {
    seeking = true;
    if (Number.isFinite(v.duration)) v.currentTime = Number(seek.value) * v.duration;
    paint();
  });
  seek.addEventListener('change', () => { seeking = false; paint(); });
  full.addEventListener('click', () => {
    if (v.webkitEnterFullscreen && !document.fullscreenEnabled) v.webkitEnterFullscreen();   // iPhone の Safari
    else if (stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
    else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
  });
  sync();
}
