// 縦スワイプの連続再生ビューア(YouTube ショートと同じ操作)。
//  - 画面いっぱいに動画を出し、指の動きに合わせて前後の投球が一緒に動く(次の動画が下から見えてくる)。
//  - 指を離したとき、距離か速さが足りれば次(前)へ吸い付き、足りなければ元に戻る。端では、引っ張りが重くなる。
//  - ループ、タップで一時停止/再生、ダブルタップでいいね。下端の細い進行バー(触るとシーク)。PC ではホイール・矢印キー・スペース・Esc も使える。
//
// 動画の要素(<video>)は、1つだけ作って使い回す。理由(iPhone の Safari):
//  - 動画は、利用者の操作(タップ)の中で再生を始めた要素だけが、あとから(操作なしで)再生を始められる。
//    投球ごとに新しい要素を作ると、操作の外で再生を始める要素が出て、再生が断られる(再生されない)。
//  - 同時に読み込める動画の数に限りがあり、複数を読み込むと、読み込みに失敗することがある。
// 前後のカードは、サムネイル(静止画)で見せる。動画が付くのは、いま見ているカードだけ。
const ANIM_MS = 280;
const EASE = 'cubic-bezier(.22,.8,.26,1)';
const COMMIT_FRAC = 0.2;   // 画面の高さのこれだけ動かしたら次へ
const FLICK_SPEED = 0.35;  // px/ms。これ以上の速さではじいたら次へ
const EDGE_RESIST = 0.3;   // 前後がない端での、指に付いてくる量
// 再生の許可を取るための、ごく小さい無音の動画(64×64・3コマ)。ビューアを開くタップの中で再生して、要素に許可をもらう
const SILENT = 'data:video/mp4;base64,AAAAGGZ0eXBtcDQyAAAAAG1wNDFpc29tAAAAKHV1aWRcpwj7Mo5CBahhZQ7KCpWWAAAADDEwLjAuMjYzMDAuMAAAAXltZGF0AAAAAAAAABAAAAACCRAAAAAzBgUvAvhhUPxwQXK3Mkjzpyo9NE1pY3Jvc29mdCBILjI2NCBFbmNvZGVyIFYxLjUuMwCAAAAA6gYF5suyE5KYc0PaqKbHQpg1bPVzcmM6MyBoOjY0IHc6NjQgZnBzOjEwLjAwMCBwZjo2NiBsdmw6MCBiOjAgYnFwOjMgZ29wOjMwIGlkcjozMCBzbGM6MSBjbXA6MCByYzoxIHFwOjI2IHJhdGU6NDA5NjAgcGVhazowIGJ1ZmY6MTUzNjAgcmVmOjIgc3JjaDozMiBhc3JjaDoxIHN1YnA6MSBwYXI6NiAzIDMgcm5kOjAgY2FiYWM6MCBscDoyIGN0bnQ6MCBhdWQ6MSBsYXQ6MCB3cms6MTYgdnVpOjEgbHlyOjEgPDwAgAAAABpliIBL///w9FAAECP3it99YrXXXXXXXXXXXgAAAAIJMAAAAAZhmgOXhGAAAAACCTAAAAAGYZoFl4RgAAACy21vb3YAAABsbXZoZAAAAADnJ/3f5yf93wAAJxAAAAu4AAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAISdHJhawAAAFx0a2hkAAAAAecn/d/nJ/3fAAAAAQAAAAAAAAu4AAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAABAAAAAQAAAAAABrm1kaWEAAAAgbWRoZAAAAADnJ/3f5yf93wAAJxAAAAu4VcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAAVltaW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAEZc3RibAAAAJVzdHNkAAAAAAAAAAEAAACFYXZjMQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAABAAEAASAAAAEgAAAAAAAAAAQpBVkMgQ29kaW5nAAAAAAAAAAAAAAAAAAAAAAAAAAAAABj//wAAAC9hdmNDAULACv/hABhnQsAKlbEJsBEAAAMAAQAAAwAUDaCIRuABAARoyo8gAAAAGHN0dHMAAAAAAAAAAQAAAAMAAAPoAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAADAAAAAQAAACBzdHN6AAAAAAAAAAAAAAADAAABSQAAABAAAAAQAAAAFHN0Y28AAAAAAAAAAQAAAFAAAAAUc3RzcwAAAAAAAAABAAAAAQAAAEV1ZHRhAAAANW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXIAAAAAAAAAAAAAAAAAAAAACGlsc3QAAAAIWHRyYQ==';

export function createShorts({ root, getThrow, getIds, draw, describe, getPose, setPose, setLiked, getPoster, onExit, onDetail }) {
  const q = (s) => root.querySelector(s);
  const stage = q('.sv-stage'), bar = q('.sv-bar'), fill = q('.sv-fill'), poseBtn = q('.sv-pose'), exitBtn = q('.sv-exit');
  const likeBtn = q('.sv-like'), burst = q('.sv-burst'), detailBtn = q('.sv-detail'), diagEl = q('.sv-diag');
  const titleEl = q('.sv-title'), subEl = q('.sv-sub'), posEl = q('.sv-posn');
  let ids = [], cur = 0, drag = 0, W = 0, H = 0;
  let isOpen = false, animating = false, raf = 0, wheelAt = 0;
  const cards = new Map();
  let g = null, scrub = null, tapTimer = 0, lastTap = 0;
  let userPaused = false;   // 利用者がタップで止めた。false の間は、止まっていたら再生し直す(見張り)

  // ---- 唯一の動画要素
  const player = document.createElement('video');
  player.className = 'sv-video';
  player.muted = true; player.defaultMuted = true; player.playsInline = true; player.preload = 'auto';
  player.setAttribute('muted', ''); player.setAttribute('playsinline', ''); player.setAttribute('webkit-playsinline', '');
  let playerCard = null, playerUrl = null, kicked = 0, startedAt = 0;

  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const curCard = () => cards.get(cur);
  const trimOf = (c) => (c && c.rec && c.rec.trimStart) || 0;

  function measure() { W = root.clientWidth; H = root.clientHeight; }
  /** カードの表示の大きさ。動画の大きさが分かればそれ、なければサムネイル、どちらもなければ 16:9 */
  function dims(c) {
    if (playerCard === c && player.videoWidth) return [player.videoWidth, player.videoHeight];
    if (c.img.naturalWidth) return [c.img.naturalWidth, c.img.naturalHeight];
    return [16, 9];
  }
  function fit(c) {
    const [vw, vh] = dims(c);
    const s = Math.min(W / vw, H / vh);
    c.box.style.width = vw * s + 'px';
    c.box.style.height = vh * s + 'px';
  }
  /** 骨格の canvas を、動画の大きさに合わせる */
  function sizeCard(c) {
    if (playerCard === c && player.videoWidth && (c.cv.width !== player.videoWidth || c.cv.height !== player.videoHeight)) {
      c.cv.width = player.videoWidth; c.cv.height = player.videoHeight;
    }
    fit(c);
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
    const img = document.createElement('img'); img.className = 'sv-poster'; img.alt = ''; img.draggable = false;
    const cv = document.createElement('canvas');
    box.append(img, cv); el.append(box); stage.append(el);
    const c = { i, el, box, img, cv, rec: null };
    img.addEventListener('load', () => fit(c));
    const poster = getPoster && getPoster(ids[i]);
    if (poster) img.src = poster;   // 動画が付くまで(付いても、最初のコマが出るまで)、サムネイルを見せる
    fit(c);
    cards.set(i, c);
    place(c, false);
    getThrow(ids[i]).then((rec) => {
      if (cards.get(i) !== c || !rec) return;
      c.rec = rec;
      if (i === cur) { updateInfo(); startCard(c); }
    });
    return c;
  }
  function destroyCard(c) {
    if (playerCard === c) parkPlayer();
    c.el.remove(); cards.delete(c.i);
  }

  // ---- 動画をカードに付ける・外す
  /** 外すときは、いまのコマ(と骨格)を静止画にして、外したカードに残す。動画が消えて、画が飛ぶのを避ける */
  function snapshot(c) {
    try {
      if (!player.videoWidth || player.readyState < 2) return;
      const w = 360, h = Math.round(player.videoHeight * w / player.videoWidth);
      const t = document.createElement('canvas'); t.width = w; t.height = h;
      t.getContext('2d').drawImage(player, 0, 0, w, h);
      if (c.rec && getPose()) draw(t, player, c.rec);
      c.img.src = t.toDataURL('image/jpeg', 0.7);
    } catch (e) { /* 静止画にできなくても、サムネイルのままで動く */ }
  }
  function parkPlayer() {
    if (playerCard) { snapshot(playerCard); playerCard.el.classList.remove('live'); }
    player.pause();
    root.append(player);   // カードの外に置く(見えない)
    playerCard = null;
  }
  function attach(c) {
    if (playerCard === c) return;
    if (playerCard) {
      const old = playerCard;
      snapshot(old); old.el.classList.remove('live');
      const oc = old.cv.getContext('2d'); oc.clearRect(0, 0, old.cv.width, old.cv.height);
    }
    player.pause();
    c.box.prepend(player);
    playerCard = c;
    c.el.classList.remove('live');
  }
  /** このカードで動画を再生する。利用者の操作の中(タップ・スワイプの指を離した瞬間)で呼ばれれば、確実に再生できる */
  function startCard(c) {
    if (!c || !c.rec) return;
    attach(c);
    const blob = c.rec.video.type ? c.rec.video : new Blob([c.rec.video], { type: c.rec.mime || 'video/mp4' });  // 種類が失われていると、iPhone は再生しない
    const url = URL.createObjectURL(blob);
    const old = playerUrl; playerUrl = url;
    userPaused = false; kicked = 0; startedAt = performance.now();
    player.src = url;
    if (old) URL.revokeObjectURL(old);
    play();
  }
  function play() { player.play().catch(() => { /* 断られても、見張りが再試行する。それでも駄目なら、一時停止の表示になり、タップで再生できる */ }); }
  player.addEventListener('loadedmetadata', () => {
    const c = playerCard; if (!c) return;
    sizeCard(c);
    try { player.currentTime = trimOf(c); } catch { /* 先頭を出せなくても動く */ }
  });
  // 最初のコマが出たら、サムネイルをどける
  const goLive = () => { if (playerCard && player.readyState >= 2) playerCard.el.classList.add('live'); };
  player.addEventListener('loadeddata', goLive);
  player.addEventListener('playing', goLive);
  player.addEventListener('seeked', goLive);
  // ループ。録画の先頭には余分な映像が付くので、動き出しの少し前に戻す
  player.addEventListener('ended', () => {
    if (!playerCard) return;   // 許可を取るための無音の動画
    try { player.currentTime = trimOf(playerCard); } catch { /* ignore */ }
    if (!scrub && !userPaused) play();
  });
  player.addEventListener('error', () => console.warn('video error', player.error && player.error.code));

  function togglePlay() {
    const c = curCard(); if (!c || !c.rec) return;
    if (playerCard !== c) { startCard(c); return; }
    if (player.paused) { userPaused = false; play(); } else { userPaused = true; player.pause(); }
  }

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

  function updateInfo() {
    const c = curCard();
    posEl.textContent = `${cur + 1} / ${ids.length}`;
    const d = c && c.rec ? describe(c.rec) : { title: '', sub: '' };
    titleEl.textContent = d.title; subEl.textContent = d.sub;
    reflectLike();
  }
  function settle() {
    animating = false;
    for (const c of [...cards.values()]) if (Math.abs(c.i - cur) > 1) destroyCard(c);
    makeCard(cur + 1); makeCard(cur - 1);
    const c = curCard();
    if (c && c.rec && playerCard !== c) startCard(c);   // 移った先に、まだ動画が付いていなければ付ける
    layout(false);
  }
  function commit(dir) {
    const next = cards.get(cur + dir);
    if (!next || animating) return;
    animating = true;
    cur += dir; drag = 0;
    clearTimeout(tapTimer); tapTimer = 0;
    startCard(next);        // 指を離した操作の中で、動画を付けて再生する(next の記録が未読み込みなら、読み込み後に付く)
    updateInfo();
    layout(true);
    setTimeout(() => { if (isOpen) settle(); }, ANIM_MS + 20);
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
    const c = curCard(); if (!c || playerCard !== c || !player.duration) return;
    const r = bar.getBoundingClientRect(), t0 = trimOf(c);
    player.currentTime = t0 + clamp01((e.clientX - r.left) / r.width) * (player.duration - t0);
  }
  bar.addEventListener('pointerdown', (e) => {
    const c = curCard(); if (!c || playerCard !== c) return;
    e.stopPropagation();
    try { bar.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    scrub = { wasPlaying: !player.paused };
    player.pause(); seekTo(e);
    root.classList.add('scrubbing');
  });
  bar.addEventListener('pointermove', (e) => { if (scrub) seekTo(e); });
  const endScrub = () => {
    if (!scrub) return;
    const was = scrub.wasPlaying; scrub = null;
    root.classList.remove('scrubbing');
    if (was) play();
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

  // ---- 描画: 骨格の重ね表示と進行バー。1回の失敗で、描画の繰り返しが止まらないようにする(止まると、骨格も進行バーも固まる)
  function frame() {
    const showPose = getPose();
    poseBtn.classList.toggle('off', !showPose);
    const now = performance.now();
    const c = curCard();
    if (!c || !c.rec) return;
    const mine = playerCard === c;
    if (mine) {
      if (player.videoWidth && c.cv.width !== player.videoWidth) sizeCard(c);   // loadedmetadata を取りこぼしても、大きさを合わせる
      if (c.cv.width) {
        try {
          if (showPose) draw(c.cv, player, c.rec);
          else c.cv.getContext('2d').clearRect(0, 0, c.cv.width, c.cv.height);
        } catch (e) { console.warn('overlay draw failed', e); }
      }
      if (player.duration) {
        const t0 = trimOf(c);
        fill.style.transform = `scaleX(${clamp01((player.currentTime - t0) / Math.max(0.01, player.duration - t0))})`;
      }
    }
    const stopped = !mine || (player.paused && !scrub);
    root.classList.toggle('paused', mine && player.paused && !scrub && player.readyState >= 2 && (userPaused || now - startedAt > 2500));
    if (!mine) { startCard(c); return; }   // 動画が付いていなければ付ける
    // 見張り: 利用者が止めていないのに止まっていたら、再生し直す。読み込みが始まっていなければ、読み込み直す
    if (!userPaused && !scrub && !g && player.paused && !player.ended && now - kicked > 350) {
      if (kicked && player.readyState === 0 && player.networkState !== 2) player.load();
      kicked = now;
      play();
    }
    // それでも再生できていないときは、状態を画面に出す(原因を調べる手がかり)
    const bad = stopped && !userPaused && now - startedAt > 2500;
    diagEl.hidden = !bad;
    if (bad) diagEl.textContent = `再生できません(タップで再生) rs=${player.readyState} ns=${player.networkState} err=${player.error ? player.error.code : '-'}`;
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
    // 利用者のタップの中で、動画の要素に再生の許可をもらう(あとで操作なしに再生を始められるようにする)
    root.append(player);
    player.src = SILENT;
    play();
    cur = i; drag = 0; animating = false; g = null; scrub = null; userPaused = false; playerCard = null; startedAt = performance.now();
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
    player.pause();
    for (const c of [...cards.values()]) destroyCard(c);
    player.removeAttribute('src'); player.load();
    if (playerUrl) { URL.revokeObjectURL(playerUrl); playerUrl = null; }
    playerCard = null; player.remove();
    diagEl.hidden = true;
    root.hidden = true; root.classList.remove('paused', 'scrubbing');
    after(id);
  }
  return { open, close, get isOpen() { return isOpen; } };
}
