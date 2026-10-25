import { createPoseDetector, BONES } from './pose.js';
import { ThrowDetector } from './detector.js';
import { ThrowRecorder } from './recorder.js';
import { analyze, instant, summarize, measurementMethod } from './analyzer.js';
import { FOCUS_OPTIONS, DEFAULT_FOCUS, focusItems, focusSummary, focusKeys } from './focus.js';
import { streamAnalysis } from './gemini.js';
import { putThrow, removeThrow, getThrow, allThrows, allPresets, getPreset, settings } from './store.js';
import { initPresetsTab } from './presets-ui.js';
import { PresenceFilter } from './presence.js';
import { compare, selectHistory } from './trend.js';
import { speak, stopSpeech, unlockSpeech, setVoiceEnabled } from './speech.js';

const $ = (id) => document.getElementById(id);
const PRE_ROLL = 1.0;   // 動き出しの何秒前から保存するか
const POST_ROLL = 1.5;  // 投球終了の何秒後まで保存するか(フォロースルーまで入れる)

const video = $('video');
const overlay = $('overlay');
const octx = overlay.getContext('2d');
const snapCanvas = document.createElement('canvas');
const sctx = snapCanvas.getContext('2d');

let pose = null;
let stream = null;
let recorder = null;
let detector = new ThrowDetector();
let running = false;
let wakeLock = null;

let history = [];        // 姿勢の時系列
let snaps = [];          // 局面画像用のスナップショット {t, data(JPEG base64)}
let lastSnap = 0;
let lastHud = 0;
let state = 'idle';      // idle | recording | analyzing
let detectedStart = 0;
let lastRecord = null;   // 撮影タブに表示中の直近の投球
let openRecord = null;   // 履歴の詳細画面に表示中の投球
let activePreset = null; // 使用中のお手本プリセット(現在の撮影位置と一致するもののみ)
let presetsTab = null;
let presence = new PresenceFilter();

// ---------------------------------------------------------------- settings / tabs

const hand = () => settings.get('hand', 'right');
const view = () => (settings.get('view', 'side') === 'rear' ? 'rear' : 'side');
const SENS_LABEL = { strict: '厳しい', normal: '標準', loose: 'ゆるい' };
const sens = () => (SENS_LABEL[settings.get('sens', 'normal')] ? settings.get('sens', 'normal') : 'normal');
const makeDetector = () => new ThrowDetector({ view: view() });
const VIEW_TIPS = {
  side: 'アプローチに対して真横、全身が映る位置に三脚で固定。前傾・膝・肘・スイングの高さを分析します。',
  rear: 'レーンの延長線上、ボウラーの真後ろに三脚で固定(足元から頭まで、助走の最後まで映る距離)。肩の傾き・腕の通り道・助走のまっすぐさを分析します。'
};

function initSettings() {
  const bind = (id, key, def, prop = 'value') => {
    const el = $(id);
    el[prop] = settings.get(key, def);
    el.addEventListener('change', () => { settings.set(key, el[prop]); onSettingsChanged(); });
  };
  bind('hand', 'hand', 'right');
  bind('voice', 'voice', true, 'checked');
  bind('ai', 'ai', true, 'checked');
  bind('geminiKey', 'geminiKey', '');
  bind('model', 'model', 'gemini-2.5-flash');
  $('handLive').value = hand();
  $('handLive').addEventListener('change', () => { settings.set('hand', $('handLive').value); onSettingsChanged(); });
  bind('view', 'view', 'side');
  $('viewLive').addEventListener('change', () => { settings.set('view', $('viewLive').value); onSettingsChanged(); });
  onSettingsChanged();
}

function initFocusUi() {
  const ids = () => settings.get('focusIds', DEFAULT_FOCUS);
  $('focusBox').innerHTML = FOCUS_OPTIONS.map((o) =>
    `<label class="field check"><input type="checkbox" data-id="${o.id}"> ${esc(o.label)}</label>`).join('');
  $('focusBox').querySelectorAll('input').forEach((el) => {
    el.checked = ids().includes(el.dataset.id);
    el.addEventListener('change', () => {
      const next = FOCUS_OPTIONS.map((o) => o.id).filter((id) => (id === el.dataset.id ? el.checked : ids().includes(id)));
      settings.set('focusIds', next);
      onSettingsChanged();
    });
  });
  $('focusText').value = settings.get('focusText', '');
  $('focusText').addEventListener('change', () => settings.set('focusText', $('focusText').value));
}

function onSettingsChanged() {
  const labels = FOCUS_OPTIONS.filter((o) => settings.get('focusIds', DEFAULT_FOCUS).includes(o.id)).map((o) => o.label);
  $('focusLine').textContent = labels.length ? '重点: ' + labels.join('、') + '(設定タブで変更)' : '重点項目: なし(設定タブで選べます)';
  $('hand').value = hand();
  $('handLive').value = hand();
  $('view').value = view();
  $('viewLive').value = view();
  if (pose) pose.setSensitivity(sens());
  $('sens').value = sens();
  presence.reset();
  $('viewNote').textContent = VIEW_TIPS[view()];
  setVoiceEnabled(settings.get('voice', true));
  loadActivePreset();
  // 撮影位置が変わったら、待機中に限り検知器を作り直す(検知方式が違うため)
  if (detector.view !== view() && state !== 'recording' && state !== 'analyzing') detector = makeDetector();
}

async function loadActivePreset() {
  const items = await allPresets();
  const forView = items.filter((p) => p.view === view());
  const id = settings.get('presetId', '');
  const p = id ? await getPreset(id) : null;
  activePreset = p && p.view === view() ? p : null;
  const sel = $('presetLive');
  sel.innerHTML = '<option value="">なし</option>' +
    forView.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
  sel.value = activePreset ? activePreset.id : '';
}

document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'history') renderHistory();
  if (b.dataset.tab === 'presets') presetsTab.render();
  if (b.dataset.tab === 'live') layoutStage();
}));

// ---------------------------------------------------------------- camera

function layoutStage() {
  const wrap = document.querySelector('.stage-wrap');
  const stage = $('stage');
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const ww = wrap.clientWidth, wh = wrap.clientHeight;
  if (!ww || !wh) return;
  const ratio = vw / vh;
  let w = ww, h = ww / ratio;
  if (h > wh) { h = wh; w = wh * ratio; }
  stage.style.width = w + 'px';
  stage.style.height = h + 'px';
  stage.style.aspectRatio = 'auto';
  overlay.width = vw;
  overlay.height = vh;
}
window.addEventListener('resize', layoutStage);
window.addEventListener('orientationchange', () => setTimeout(layoutStage, 300));

async function startCamera() {
  unlockSpeech();
  $('startBtn').disabled = true;
  try {
    setMessage('姿勢推定モデルを読み込み中…');
    if (!pose) pose = await createPoseDetector();
    pose.setSensitivity(sens());
    setMessage('カメラを起動中…');
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    const s = stream.getVideoTracks()[0].getSettings();
    $('fps').textContent = `${video.videoWidth}×${video.videoHeight} ${Math.round(s.frameRate || 0)}fps`;
    layoutStage();

    recorder = new ThrowRecorder(stream);
    recorder.start();
    detector = makeDetector();
    presence = new PresenceFilter();
    history = []; snaps = [];
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* 非対応 */ }

    running = true;
    $('startPanel').hidden = true;
    $('stopBtn').hidden = false;
    setState('idle', '人が映ると自動で待機します');
    schedule(loop);
  } catch (e) {
    console.error(e);
    setMessage('開始できませんでした: ' + (e && e.message ? e.message : e));
    stopCamera();
  } finally {
    $('startBtn').disabled = false;
  }
}

function stopCamera() {
  running = false;
  recorder?.stop();
  recorder = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  octx.clearRect(0, 0, overlay.width, overlay.height);
  $('startPanel').hidden = false;
  $('stopBtn').hidden = true;
  setState('stopped', '停止中');
}

$('startBtn').addEventListener('click', startCamera);
$('stopBtn').addEventListener('click', stopCamera);
document.addEventListener('visibilitychange', () => { if (document.hidden && running) stopCamera(); });

// ---------------------------------------------------------------- frame loop

const schedule = (cb) => (video.requestVideoFrameCallback
  ? video.requestVideoFrameCallback(() => cb())
  : requestAnimationFrame(() => cb()));

function loop() {
  if (!running) return;
  const nowMs = performance.now();
  let frame = null;
  const t = nowMs / 1000;
  try { frame = pose.detect(video, nowMs); } catch (e) { console.warn('pose error', e); }
  onFrame(frame, t);
  schedule(loop);
}

function onFrame(raw, t) {
  // 人物として自然で、連続して見えているフレームだけを検知・解析に使う(誤検知対策)
  const frame = presence.update(raw, t);
  drawPose(raw, !!frame);
  if (frame) {
    history.push(frame);
    if (history.length > 1500) history.splice(0, 500);
  }
  maybeSnapshot(t);

  const ev = detector.process(frame, t);
  if (ev && ev.type === 'started') onStarted(ev.at);
  else if (ev && ev.type === 'ended') onEnded(ev.at);

  if (t - lastHud > 0.15) {
    lastHud = t;
    const ms = frame ? instant(frame, hand(), detector.travelDirection, detector.view, activePreset) : [];
    $('liveMetrics').innerHTML = ms.length ? ms.map(metricRow).join('')
      : (raw ? '人物か確認中…(人以外のものを検出している可能性があります)' : '人物が見つかりません');
    if ($('diag').open) renderDiag(raw);
  }
}

function drawPose(frame, confirmed) {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!frame) return;
  const W = overlay.width, H = overlay.height, j = frame.j;
  octx.lineWidth = 3;
  octx.strokeStyle = confirmed ? '#34c759' : 'rgba(160,160,160,.6)'; // 灰色=人物として未確認
  for (const [a, b] of BONES) {
    if (!j[a] || !j[b]) continue;
    octx.beginPath();
    octx.moveTo(j[a].x * W, j[a].y * H);
    octx.lineTo(j[b].x * W, j[b].y * H);
    octx.stroke();
  }
  octx.fillStyle = confirmed ? '#ffd60a' : 'rgba(160,160,160,.6)';
  for (const p of Object.values(j)) {
    octx.beginPath();
    octx.arc(p.x * W, p.y * H, 4, 0, Math.PI * 2);
    octx.fill();
  }
}

function maybeSnapshot(t) {
  if (t - lastSnap < 0.12 || !video.videoWidth) return;
  lastSnap = t;
  const w = 640, h = Math.round(w * video.videoHeight / video.videoWidth);
  snapCanvas.width = w;
  snapCanvas.height = h;
  sctx.drawImage(video, 0, 0, w, h);
  snaps.push({ t, data: snapCanvas.toDataURL('image/jpeg', 0.6).split(',')[1] });
  while (snaps.length && snaps[0].t < t - 25) snaps.shift();
}

// ---------------------------------------------------------------- diagnostics

/** 「なぜ検知されないか」を画面で確認できるようにする(診断表示) */
function renderDiag(raw) {
  const d = pose && pose.diag;
  if (!d) return;
  const lines = [`検出された人の数: ${d.people}`];
  if (d.visFail) lines.push(`  肩・腰がはっきり見えない: ${d.visFail}`);
  if (d.implausible) {
    lines.push(`  人物として不自然: ${d.implausible} (${Object.entries(d.reasons).map(([k, v]) => `${k}×${v}`).join(', ')})`);
  }
  lines.push(`分析の対象: ${d.picked ? 'あり' : 'なし'} / 人物の確認: ${presence.stable ? '安定' : `確認中(${presence.times.length}/${presence.minFrames})`}`);
  const th = detector.view === 'rear' ? detector.config.rearStartSlope : detector.config.startSpeed;
  lines.push(`動き量: ${detector.signal.toFixed(3)} / 開始しきい値 ${th.toFixed(3)}${detector.isActive ? ' (投球中)' : ''}`);
  lines.push(`状態: ${$('stateLabel').textContent} / 感度: ${SENS_LABEL[sens()]}`);
  lines.push(`撮影位置: ${view() === 'rear' ? '後方' : '横'}`);
  $('diagText').textContent = lines.join(String.fromCharCode(10));
}

$('sens').addEventListener('change', () => { settings.set('sens', $('sens').value); onSettingsChanged(); });

// ---------------------------------------------------------------- throw lifecycle

function setState(s, text) {
  state = s;
  const map = { idle: ['s-good', '待機中'], recording: ['s-rec', '録画中'], analyzing: ['s-busy', '解析中'], stopped: ['s-info', '停止中'] };
  const [cls, label] = map[s] || map.idle;
  $('stateDot').className = 'dot ' + cls;
  $('stateLabel').textContent = label;
  if (text) setMessage(text);
}
function setMessage(text) { $('message').textContent = text; }

function onStarted(at) {
  detectedStart = at;
  const vs = recorder ? recorder.lock(at - PRE_ROLL) : null;
  if (vs === null) { setState('idle', '録画を開始できませんでした'); return; }
  setState('recording', '投球を検知: 録画中');
}

function onEnded(at) {
  if (state !== 'recording') return;
  setState('analyzing', '投球終了: 解析中');
  setTimeout(() => finishThrow(at + POST_ROLL), POST_ROLL * 1000);
}

async function finishThrow(endAt) {
  try {
    const rec = recorder ? await recorder.finish() : null;
    if (!rec) { setState('idle', '録画を保存できませんでした'); return; }
    const frames = history.filter((f) => f.t >= rec.videoStart && f.t <= endAt);
    const report = analyze({ frames, hand: hand(), throwStart: detectedStart, view: detector.view, preset: activePreset });
    report.presetName = activePreset && !report.presetSkipped ? activePreset.name : '';
    if (!report.isValidThrow) { setState('idle', '投球として認識できず破棄: ' + report.summary); return; }

    // 直近の投球(同じ撮影位置・利き手)との比較: 改善/悪化と推移の傾向
    const past = selectHistory(await allThrows(), { view: report.view, hand: hand(), method: report.method });
    const comparison = compare(report, past, report.presetSkipped ? null : activePreset);

    // 直したい点(重点項目): 選んだ項目を最優先で判定し、全体の講評からは重複を除く
    const fItems = focusItems(report, settings.get('focusIds', DEFAULT_FOCUS));
    const general = summarize(report.metrics, focusKeys(fItems));
    const summaryText = [focusSummary(fItems), general].filter(Boolean).join(' ') || report.summary;

    const record = {
      id: crypto.randomUUID(), comparison, focusItems: fItems, generalSummary: general, date: Date.now(), video: rec.blob, mime: rec.blob.type,
      videoStart: rec.videoStart,
      trimStart: Math.max(0, detectedStart - PRE_ROLL - rec.videoStart),
      hand: hand(), view: detector.view, presetName: report.presetName, report, summary: summaryText,
      keyframes: pickKeyframes(report),
      poses: compactPoses(frames, rec.videoStart),
      aiText: '', aiStatus: 'none', aiModel: ''
    };
    await putThrow(record);
    lastRecord = record;
    renderLast();
    setState('idle', '保存しました。次の投球を待っています');
    speak(summaryText + (comparison.summary ? ' ' + comparison.summary : ''), true);
    if (settings.get('ai', true) && settings.get('geminiKey', '')) runAI(record);
  } catch (e) {
    console.error(e);
    setState('idle', 'エラー: ' + e.message);
  }
}

/** 録画に重ねて再生するための骨格(動画先頭からの秒、座標は小数3桁) */
function compactPoses(frames, t0) {
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return frames.map((f) => ({
    t: r3(f.t - t0),
    j: Object.fromEntries(Object.entries(f.j).map(([k, p]) => [k, [r3(p.x), r3(p.y)]]))
  }));
}

function pickKeyframes(report) {
  const targets = [['動き出し', report.startTime], ['バックスイング頂点', report.backswingTime],
    ['リリース', report.releaseTime], ['フォロースルー', report.releaseTime + 0.35]];
  const out = [];
  for (const [label, t] of targets) {
    let best = null;
    for (const s of snaps) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    if (best) out.push({ label, data: best.data });
  }
  return out;
}

// ---------------------------------------------------------------- AI

async function runAI(record) {
  const apiKey = settings.get('geminiKey', '');
  if (!apiKey) {
    record.aiStatus = 'failed';
    record.aiText = 'Gemini APIキーが未設定です。設定タブで入力してください。';
    refreshViews(record);
    return;
  }
  const model = settings.get('model', 'gemini-2.5-flash');
  // 重点項目は現在の設定で作り直す(あとから設定を変えて再分析できる)
  record.focusItems = focusItems(record.report, settings.get('focusIds', DEFAULT_FOCUS));
  record.aiStatus = 'pending';
  record.aiText = '';
  record.aiModel = model;
  refreshViews(record);

  const voice = settings.get('voice', true);
  let spoken = false;
  try {
    await streamAnalysis({
      apiKey, model, keyframes: record.keyframes, report: record.report, hand: record.hand, comparison: record.comparison,
      focus: { items: record.focusItems || [], text: settings.get('focusText', '') },
      onText: (text) => {
        record.aiStatus = 'streaming';
        record.aiText += text;
        refreshViews(record);
        // 最初の段落(読み上げ用要約)が出そろったらすぐ読み上げる
        if (voice && !spoken) {
          const i = record.aiText.indexOf('\n\n');
          if (i >= 0) { spoken = true; speak(record.aiText.slice(0, i), false); }
        }
      }
    });
    record.aiStatus = 'done';
    if (voice && !spoken) speak(record.aiText.slice(0, 120), false);
  } catch (e) {
    record.aiStatus = 'failed';
    record.aiText += (record.aiText ? '\n' : '') + '⚠️ AI分析に失敗しました: ' + e.message;
  }
  refreshViews(record);
  await putThrow(record);
}

// ---------------------------------------------------------------- views

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const AI_LABEL = { none: '', pending: 'AI分析 準備中…', streaming: 'AI分析 受信中…', done: 'AI分析', failed: 'AI分析 失敗' };

function metricRow(m) {
  const target = m.target ? `<small>お手本 ${esc(m.target)}</small>` : '';
  return `<div class="row"><span class="dot s-${m.status}"></span>${esc(m.title)}<b>${esc(m.display)}</b>${target}</div>`;
}

function focusHtml(items) {
  if (!items || !items.length) return '';
  const rows = items.map((i) => {
    const detail = i.unavailable
      ? `<p class="advice">${esc(i.unavailable)}</p>`
      : i.metrics.map((m) => `<div class="row"><span class="dot s-${m.status}"></span>${esc(m.title)}<b>${esc(m.display)}</b>` +
        (m.range ? `<small>良い範囲 ${esc(m.range)}</small>` : '') + '</div>' +
        (m.advice ? `<p class="advice">${esc(m.advice)}</p>` : '')).join('');
    return `<div class="focus-item"><b>${esc(i.label)}</b>${detail}</div>`;
  }).join('');
  return `<div class="focus"><p class="muted">重点項目</p>${rows}</div>`;
}

/** 重点項目があるときは、その詳細と「それ以外の講評」を分けて見せる */
function summaryHtml(r) {
  const notes = (r.report && r.report.notes ? r.report.notes : []).map((n) => `<p class="muted">※ ${esc(n)}</p>`).join('');
  if (r.focusItems && r.focusItems.length) {
    return focusHtml(r.focusItems) + (r.generalSummary ? `<p>${esc(r.generalSummary)}</p>` : '') + notes;
  }
  return `<p>${esc(r.summary)}</p>` + notes;
}

const VERDICT = { better: ['cmp-better', '▲ 改善'], worse: ['cmp-worse', '▼ 悪化'], same: ['cmp-same', '＝ 変化なし'] };
const TREND = { improving: '改善傾向', declining: '悪化傾向', flat: '' };

function comparisonHtml(c) {
  if (!c || !c.n) return '';
  const rows = c.items.map((i) => {
    const [cls, label] = VERDICT[i.verdict];
    const trend = TREND[i.trend] ? ` <small>(${TREND[i.trend]})</small>` : '';
    return `<div class="row"><span>${esc(i.title)}</span><b>${esc(i.display)}</b><small>直近${c.n}投 平均 ${esc(i.avgDisplay)}</small><span class="${cls}">${label}</span>${trend}</div>`;
  }).join('');
  return `<div class="cmp"><p class="muted">${esc(c.summary)}</p>${rows}</div>`;
}

function renderLast() {
  const r = lastRecord;
  if (!r) return;
  $('last').className = '';
  $('last').innerHTML = summaryHtml(r) + comparisonHtml(r.comparison) +
    (r.aiStatus !== 'none' ? `<p class="muted">✨ ${AI_LABEL[r.aiStatus]}</p><p class="pre">${esc(r.aiText)}</p>` : '');
}

function refreshViews(record) {
  if (lastRecord && lastRecord.id === record.id) renderLast();
  if (openRecord && openRecord.id === record.id) { renderDetailAi(); $('detailSummary').innerHTML = summaryHtml(record); }
}

const METHOD_LABEL = { '3d': '3D(体の向き基準)', '2d': '2D(画像上)', legacy: '2D(旧記録)' };
const METHOD_TAG = { '3d': '3D', '2d': '2D', legacy: '2D旧' };

async function renderHistory() {
  const list = $('historyList');
  const items = await allThrows();
  if (!items.length) { list.innerHTML = '<p class="muted">まだ投球がありません</p>'; return; }
  list.innerHTML = items.map((r) =>
    `<div class="item" data-id="${r.id}"><b>${new Date(r.date).toLocaleString('ja-JP')}${r.view === 'rear' ? '(後方)' : ''}${r.aiStatus === 'done' ? ' ✨' : ''}` +
    `<span class="tag ${measurementMethod(r.report) === '3d' ? 'm3d' : ''}">${METHOD_TAG[measurementMethod(r.report)]}</span></b>` +
    `<span>${esc(r.summary)}</span></div>`).join('');
  list.querySelectorAll('.item').forEach((el) => el.addEventListener('click', () => openDetail(el.dataset.id)));
}

let detailUrl = null;
let detailRaf = 0;

/** 履歴の詳細: 再生位置に合わせて、検出した骨格と局面名を録画に重ねる。検出できていない瞬間は赤く表示する。 */
function loopDetail() {
  const r = openRecord;
  const cv = $('detailOverlay');
  const c = cv.getContext('2d');
  c.clearRect(0, 0, cv.width, cv.height);
  if (r && r.poses && $('detailPose').checked && cv.width > 0) {
    const v = $('detailVideo');
    const t = v.currentTime;
    let best = null, bd = Infinity;
    for (const f of r.poses) { const d = Math.abs(f.t - t); if (d < bd) { bd = d; best = f; } }
    const W = cv.width, H = cv.height;
    const u = Math.max(W / 640, 1);
    c.font = `${16 * u}px sans-serif`;
    if (best && bd <= 0.15) {
      const j = best.j;
      c.lineWidth = 3 * u;
      c.strokeStyle = '#34c759';
      for (const [a, b] of BONES) {
        if (!j[a] || !j[b]) continue;
        c.beginPath(); c.moveTo(j[a][0] * W, j[a][1] * H); c.lineTo(j[b][0] * W, j[b][1] * H); c.stroke();
      }
      c.fillStyle = '#ffd60a';
      for (const p of Object.values(j)) { c.beginPath(); c.arc(p[0] * W, p[1] * H, 4 * u, 0, Math.PI * 2); c.fill(); }
    } else {
      c.fillStyle = '#ff453a';
      c.fillText('骨格: 検出なし', 12 * u, 24 * u);
    }
    const rep = r.report;
    if (rep) {
      const back = rep.backswingTime - r.videoStart, rel = rep.releaseTime - r.videoStart;
      let label = '';
      if (Math.abs(t - back) < 0.12) label = 'バックスイング頂点';
      else if (Math.abs(t - rel) < 0.12) label = 'リリース';
      else if (t > rel && t < rel + 1.5) label = 'フォロースルー区間';
      if (label) { c.fillStyle = '#ffd60a'; c.fillText(label, 12 * u, 48 * u); }
    }
  }
  detailRaf = requestAnimationFrame(loopDetail);
}
async function openDetail(id) {
  const r = await getThrow(id);
  if (!r) return;
  openRecord = r;
  $('detailTitle').textContent = new Date(r.date).toLocaleString('ja-JP') + (r.view === 'rear' ? '(後方)' : '(側面)') + (r.presetName ? ` / お手本: ${r.presetName}` : '');
  $('detailMetrics').innerHTML = r.report.metrics.map((m) =>
    metricRow(m) + (m.advice ? `<p class="advice">${esc(m.advice)}</p>` : '')).join('');
  $('detailSummary').innerHTML = summaryHtml(r);
  $('detailCmp').innerHTML = comparisonHtml(r.comparison) || '<p class="muted">比較できる過去の投球がありませんでした。</p>';
  renderDetailAi();

  // 測定方式は、診断情報(diag)のない古い記録でも必ず出す
  const d = r.report && r.report.diag;
  $('detailDiag').textContent = `測定方式: ${METHOD_LABEL[measurementMethod(r.report)]}` + (d
    ? ` / 解析に使えたフレーム ${d.samples}(補間 ${d.interpolated}) / リリース後 ${d.afterRelease}フレーム(${d.afterSpan.toFixed(2)}秒) → フォロースルー: ` +
      (d.followMeasured ? '測定できました' : '測れませんでした(リリース後の腕を十分に検出できていません)')
    : '(この記録には解析の詳細がありません)');
  detailUrl = URL.createObjectURL(r.video);
  const v = $('detailVideo');
  v.addEventListener('loadedmetadata', () => { $('detailOverlay').width = v.videoWidth; $('detailOverlay').height = v.videoHeight; }, { once: true });
  cancelAnimationFrame(detailRaf);
  detailRaf = requestAnimationFrame(loopDetail);
  v.src = detailUrl;
  // 確保した録画の先頭には余分な映像が付くので、動き出しの少し前から再生する
  v.addEventListener('loadedmetadata', () => { try { v.currentTime = r.trimStart; } catch { /* ignore */ } }, { once: true });
  const ext = (r.mime || '').includes('mp4') ? 'mp4' : 'webm';
  $('dlBtn').href = detailUrl;
  $('dlBtn').download = `throw-${new Date(r.date).toISOString().replace(/[:.]/g, '-')}.${ext}`;
  $('detail').hidden = false;
}

function renderDetailAi() {
  const r = openRecord;
  if (!r) return;
  $('detailModel').textContent = r.aiModel || '';
  $('detailAi').textContent = r.aiStatus === 'none' && !r.aiText ? '未実行' : r.aiText;
  $('reAi').disabled = r.aiStatus === 'pending' || r.aiStatus === 'streaming';
}

function closeDetail() {
  cancelAnimationFrame(detailRaf);
  $('detail').hidden = true;
  const v = $('detailVideo');
  v.pause();
  v.removeAttribute('src');
  v.load();
  if (detailUrl) URL.revokeObjectURL(detailUrl);
  detailUrl = null;
  openRecord = null;
  stopSpeech();
  renderHistory();
}

$('detailClose').addEventListener('click', closeDetail);
$('reAi').addEventListener('click', () => { if (openRecord) runAI(openRecord); });
$('speakBtn').addEventListener('click', () => {
  if (!openRecord) return;
  unlockSpeech();
  const text = openRecord.aiText || openRecord.summary;
  speak(text.split('\n\n')[0], true);
});
$('delBtn').addEventListener('click', async () => {
  if (!openRecord || !confirm('この投球を削除しますか？')) return;
  await removeThrow(openRecord.id);
  if (lastRecord && lastRecord.id === openRecord.id) { lastRecord = null; $('last').textContent = '投球するとここに結果が出ます。'; }
  closeDetail();
});

$('presetLive').addEventListener('change', () => { settings.set('presetId', $('presetLive').value); loadActivePreset(); presetsTab.render(); });
presetsTab = initPresetsTab({ onChanged: loadActivePreset });
initFocusUi();
initSettings();
