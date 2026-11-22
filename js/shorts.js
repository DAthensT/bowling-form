// 縦スワイプの連続再生ビューア(YouTube ショートと同じ操作)。
//  - 画面いっぱいに動画を出し、指の動きに合わせて前後の投球が一緒に動く(次の動画が下から見えてくる)。
//  - 指を離したとき、距離か速さが足りれば次(前)へ吸い付き、足りなければ元に戻る。端では、引っ張りが重くなる。
//  - 前後の動画は先に読み込んでおく。開いたらすぐ再生、ループ、タップで一時停止/再生。
//  - 下端の細い進行バー(触るとシーク)。PC では、ホイール・矢印キー・スペース・Esc も使える。
const ANIM_MS = 280;
const EASE = 'cubic-bezier(.22,.8,.26,1)';
const COMMIT_FRAC = 0.2;   // 画面の高さのこれだけ動かしたら次へ
const FLICK_SPEED = 0.35;  // px/ms。これ以上の速さではじいたら次へ
const EDGE_RESIST = 0.3;   // 前後がない端での、指に付いてくる量

export function createShorts({ root, getThrow, getIds, draw, describe, getPose, setPose, setLiked, getPoster, onExit, onDetail }) {
  const q = (s) => root.querySelector(s);
  const stage = q('.sv-stage'), bar = q('.sv-bar'), fill = q('.sv-fill'), poseBtn = q('.sv-pose'), exitBtn = q('.sv-exit');
  const likeBtn = q('.sv-like'), burst = q('.sv-burst'), detailBtn = q('.sv-detail');
  const titleEl = q('.sv-title'), subEl = q('.sv-sub'), posEl = q('.sv-posn');
  let ids = [], cur = 0, drag = 0, W = 0, H = 0;
  let isOpen = false, animating = false, raf = 0, wheelAt = 0;
  const cards = new Map();
  let g = null, scrub = null, tapTimer = 0, lastTap = 0;
  let userPaused = false;   // 利用者がタップで止めた。これが false の間は、現在の動画が止まっていたら再生し直す(下の見張り)

  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const curCard = () => cards.get(cur);
  const trimOf = (c) => (c.rec && c.rec.trimStart) || 0;

  function measure() { W = root.clientWidth; H = root.clientHeight; }
  function fit(c) {
    const vw = c.v.videoWidth || 16, vh = c.v.videoHeight || 9;
    const s = Math.min(W / vw, H / vh);
    c.box.style.width = vw * s + 'px';
    c.box.style.height = vh * s + 'px';
  }
  function place(c, animate) {
    c.el.style.transition = animate ? `transform ${ANIM_MS}ms ${EASE}` : 'none';
    c.el.style.transform = `translate3d(0, ${(c.i - cur) * H + drag}px, 0)`;
  }
  const layout = (animate) => { for (const c of cards.values()) place(c, animate); };

  function makeCard(i) {
    if (i < 0 || i >= ids.length || cards.has(i)) return cards.get(i);
    const el = document.createElement('div'); el.className = 'sv-card'; el.dataset.i = i;
    const box = document.createElement('div'); box.className = 'sv-box';
    const v = document.createElement('video');
    v.muted = true; v.defaultMuted = true; v.playsInline = true; v.preload = 'auto';
    v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
    const poster = getPoster && getPoster(ids[i]);
    if (poster) v.poster = poster;   // 動画の最初のコマが出るまで(iPhone では再生を始めるまで読み込まれない)、サムネイルを見せる
    const cv = document.createElement('canvas');
    box.append(v, cv); el.append(box); stage.append(el);
    const c = { i, el, box, v, cv, rec: null, url: null, kicked: 0 };
    fit(c);   // 動画の大きさが分かる前でも、場所を持たせる(0×0 だと、何も見えない)
    v.addEventListener('loadedmetadata', () => {
      sizeCard(c);
      try { v.currentTime = trimOf(c); } catch { /* 先頭の映像を出せなくても動く */ }
    });
    // ループ。録画の先頭には余分な映像が付くので、動き出しの少し前に戻す
    v.addEventListener('ended', () => { try { v.currentTime = trimOf(c); } catch { /* ignore */ } if (c.i === cur && !scrub && !userPaused) play(c); });
    v.addEventListener('error', () => console.warn('video error', ids[i], v.error && v.error.code));
    cards.set(i, c);
    place(c, false);
    getThrow(ids[i]).then((rec) => {
      if (cards.get(i) !== c || !rec) return;
      c.rec = rec; c.url = URL.createObjectURL(rec.video); v.src = c.url;
      if (i === cur) { updateInfo(); play(c); }
    });
    return c;
  }
  /** 動画の大きさに、骨格の canvas と表示の枠を合わせる(分かった時点で、何度呼んでもよい) */
  function sizeCard(c) {
    const w = c.v.videoWidth, h = c.v.videoHeight;
    if (!w || !h) return;
    if (c.cv.width !== w || c.cv.height !== h) { c.cv.width = w; c.cv.height = h; }
    fit(c);
  }
  function destroyCard(c) {
    c.v.pause(); c.v.removeAttribute('src'); c.v.load();
    if (c.url) URL.revokeObjectURL(c.url);
    c.el.remove(); cards.delete(c.i);
  }
  function play(c) { if (c && c.rec) c.v.play().catch(() => { /* 失敗しても、見張り(tick)が、現在の動画なら再試行する */ }); }
  // ---- いいね(ボタン、または画面をダブルタップ)
  function reflectLike() {
    const c = curCard(), on = !!(c && c.rec && c.rec.liked);
    likeBtn.classList.toggle('on', on);
    likeBtn.textContent = on ? '♥' : '♡';
    likeBtn.setAttribute('aria-pressed', String(on));
  }
  async function like(on) {
    const c = curCard(); if (!c || !c.rec) return;
    c.rec.liked = on; reflectLike();
    if (on) { burst.classList.remove('go'); void burst.offsetWidth; burst.classList.add('go'); }
    try { await setLiked(c.rec.id, on); } catch (e) { console.warn('like failed', e); c.rec.liked = !on; reflectLike(); }
  }
  likeBtn.addEventListener('click', () => { const c = curCard(); if (c && c.rec) like(!c.rec.liked); });
  // 1回のタップは一時停止/再生。素早く2回タップしたら、いいね(一時停止はしない)
  function onTap() {
    const now = performance.now();
    if (now - lastTap < 300) { clearTimeout(tapTimer); tapTimer = 0; lastTap = 0; like(true); return; }
    lastTap = now;
    tapTimer = setTimeout(() => { tapTimer = 0; togglePlay(); }, 280);
  }
  function togglePlay() {
    const c = curCard(); if (!c || !c.rec) return;
    if (c.v.paused) { userPaused = false; play(c); } else { userPaused = true; c.v.pause(); }
  }

  function updateInfo() {
    const c = curCard();
    posEl.textContent = `${cur + 1} / ${ids.length}`;
    const d = c && c.rec ? describe(c.rec) : { title: '', sub: '' };
    titleEl.textContent = d.title; subEl.textContent = d.sub;
    reflectLike();
  }
  function settle() {
    animating = false;
    for (const c of [...cards.values()]) {
      if (Math.abs(c.i - cur) > 1) destroyCard(c);
      else if (c.i !== cur) c.v.pause();
    }
    makeCard(cur + 1); makeCard(cur - 1);
    layout(false);
  }
  function commit(dir) {
    const next = cards.get(cur + dir);
    if (!next || animating) return;
    animating = true;
    const old = curCard();
    cur += dir; drag = 0; userPaused = false;
    clearTimeout(tapTimer); tapTimer = 0;
    try { next.v.currentTime = trimOf(next); } catch { /* ignore */ }
    play(next);
    updateInfo();
    layout(true);
    setTimeout(() => { if (old && old.i !== cur) old.v.pause(); if (isOpen) settle(); }, ANIM_MS + 20);
  }
  const step = (dir) => { if (!animating) commit(dir); };

  // ---- 指の動き
  root.addEventListener('pointerdown', (e) => {
    if (!isOpen || animating || g || e.target.closest('button, .sv-bar')) return;
    g = { id: e.pointerId, y0: e.clientY, moved: false, pts: [[e.clientY, performance.now()]] };
    try { root.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  root.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    const dy = e.clientY - g.y0;
    if (!g.moved) { if (Math.abs(dy) < 8) return; g.moved = true; }
    g.pts.push([e.clientY, performance.now()]);
    if (g.pts.length > 8) g.pts.shift();
    drag = cards.has(cur + (dy < 0 ? 1 : -1)) ? dy : dy * EDGE_RESIST;
    layout(false);
  });
  const release = (e, cancelled) => {
    if (!g || e.pointerId !== g.id) return;
    const s = g; g = null;
    if (!s.moved) { if (!cancelled) onTap(); return; }   // 動かさずに離した = タップ
    const now = performance.now();
    const recent = s.pts.filter((p) => now - p[1] < 120);
    const a = recent[0] || s.pts[0], b = s.pts[s.pts.length - 1];
    const v = (b[0] - a[0]) / Math.max(1, b[1] - a[1]);
    const dy = e.clientY - s.y0;
    let dir = 0;
    if (Math.abs(v) > FLICK_SPEED) dir = v < 0 ? 1 : -1;
    else if (Math.abs(dy) > H * COMMIT_FRAC) dir = dy < 0 ? 1 : -1;
    if (!cancelled && dir && cards.has(cur + dir)) commit(dir);
    else { drag = 0; layout(true); }
  };
  root.addEventListener('pointerup', (e) => release(e, false));
  root.addEventListener('pointercancel', (e) => release(e, true));

  // ---- 進行バー(触るとシーク)
  function seekTo(e) {
    const c = curCard(); if (!c || !c.rec || !c.v.duration) return;
    const r = bar.getBoundingClientRect(), t0 = trimOf(c);
    c.v.currentTime = t0 + clamp01((e.clientX - r.left) / r.width) * (c.v.duration - t0);
  }
  bar.addEventListener('pointerdown', (e) => {
    const c = curCard(); if (!c || !c.rec) return;
    e.stopPropagation();
    try { bar.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    scrub = { wasPlaying: !c.v.paused };
    c.v.pause(); seekTo(e);
    root.classList.add('scrubbing');
  });
  bar.addEventListener('pointermove', (e) => { if (scrub) seekTo(e); });
  const endScrub = () => {
    if (!scrub) return;
    const was = scrub.wasPlaying; scrub = null;
    root.classList.remove('scrubbing');
    if (was) play(curCard());
  };
  bar.addEventListener('pointerup', endScrub);
  bar.addEventListener('pointercancel', endScrub);

  // ---- PC の操作
  root.addEventListener('wheel', (e) => {
    if (!isOpen) return;
    e.preventDefault();
    const now = performance.now();
    if (animating || Math.abs(e.deltaY) < 8 || now - wheelAt < 450) return;
    wheelAt = now; step(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });
  document.addEventListener('keydown', (e) => {
    if (!isOpen) return;
    if (e.key === 'ArrowDown' || e.key === 'PageDown') step(1);
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') step(-1);
    else if (e.key === ' ') togglePlay();
    else if (e.key === 'Escape') close();
    else return;
    e.preventDefault();
  });
  window.addEventListener('resize', () => { if (!isOpen) return; measure(); for (const c of cards.values()) fit(c); layout(false); });

  poseBtn.addEventListener('click', () => { setPose(!getPose()); });
  exitBtn.addEventListener('click', () => close());
  detailBtn.addEventListener('click', () => close(onDetail));

  // ---- 描画: 骨格の重ね表示と進行バー。前後のカードにも描いておく(スワイプ中に骨格が遅れて出ないように)
  // 1回の失敗で、描画の繰り返しが止まらないようにする(止まると、骨格も進行バーも固まる)
  function frame() {
    const showPose = getPose();
    poseBtn.classList.toggle('off', !showPose);
    const now = performance.now();
    for (const c of cards.values()) {
      if (!c.rec) continue;
      if (c.v.videoWidth && c.cv.width !== c.v.videoWidth) sizeCard(c);   // loadedmetadata を取りこぼしても、大きさを合わせる
      if (!c.cv.width) continue;
      try {
        if (showPose) draw(c.cv, c.v, c.rec);
        else c.cv.getContext('2d').clearRect(0, 0, c.cv.width, c.cv.height);
      } catch (e) { console.warn('overlay draw failed', e); }
    }
    const c = curCard();
    if (c && c.rec) {
      if (c.v.duration) {
        const t0 = trimOf(c);
        fill.style.transform = `scaleX(${clamp01((c.v.currentTime - t0) / Math.max(0.01, c.v.duration - t0))})`;
      }
      root.classList.toggle('paused', c.v.paused && !scrub && c.v.readyState >= 2);
      // 見張り: 利用者が止めていないのに、現在の動画が止まっていたら、再生し直す。
      // iPhone の Safari は、前後の動画をまだ読み込んでいないことがあり、play() が空振りしたり、読み込みが始まらなかったりする
      if (!userPaused && !scrub && !g && c.v.paused && !c.v.ended && now - c.kicked > 350) {
        if (c.kicked && c.v.readyState === 0 && c.v.networkState !== 2) c.v.load();   // 読み込みが始まっていない: 読み込み直す
        c.kicked = now;
        play(c);
      }
    }
  }
  function tick() {
    if (!isOpen) return;
    try { frame(); } catch (e) { console.warn('viewer frame failed', e); }
    raf = requestAnimationFrame(tick);
  }

  function open(id) {
    ids = getIds().slice();
    const i = ids.indexOf(id);
    if (i < 0) return;
    cur = i; drag = 0; animating = false; g = null; scrub = null; userPaused = false;
    root.hidden = false; isOpen = true;
    measure();
    makeCard(cur); makeCard(cur + 1); makeCard(cur - 1);
    layout(false); updateInfo();
    cancelAnimationFrame(raf); raf = requestAnimationFrame(tick);
  }
  /** 閉じる。after(id) には、そのとき見ていた投球の id を渡す(既定は onExit = 履歴へ戻る。onDetail = その投球の詳細へ) */
  function close(after = onExit) {
    if (!isOpen) return;
    isOpen = false;
    clearTimeout(tapTimer); tapTimer = 0;
    cancelAnimationFrame(raf);
    const id = ids[cur];
    for (const c of [...cards.values()]) destroyCard(c);
    root.hidden = true; root.classList.remove('paused', 'scrubbing');
    after(id);
  }
  return { open, close, get isOpen() { return isOpen; } };
}
