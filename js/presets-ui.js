// 「お手本」タブ: 動画ファイルからプリセットを作成し、一覧・使用選択・書き出し/読み込み・削除を行う。
import { BONES } from './pose.js';
import { analyzeVideo } from './preset-video.js';
import { buildPreset, describePreset, validatePreset } from './preset-model.js';
import { putPreset, allPresets, removePreset, getPreset, settings } from './store.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const VIEW_LABEL = { side: '真横', rear: '真後ろ' };

export function initPresetsTab({ onChanged }) {
  const video = $('pvVideo');
  const canvas = $('pvOverlay');
  const ctx = canvas.getContext('2d');
  let abort = null;
  let draft = null; // 解析結果(保存前)

  video.addEventListener('loadedmetadata', () => {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    $('pvStage').style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
  });

  function drawPose(frame) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!frame) return;
    const W = canvas.width, H = canvas.height, j = frame.j;
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#34c759';
    for (const [a, b] of BONES) {
      if (!j[a] || !j[b]) continue;
      ctx.beginPath();
      ctx.moveTo(j[a].x * W, j[a].y * H);
      ctx.lineTo(j[b].x * W, j[b].y * H);
      ctx.stroke();
    }
    ctx.fillStyle = '#ffd60a';
    for (const p of Object.values(j)) { ctx.beginPath(); ctx.arc(p.x * W, p.y * H, 4, 0, Math.PI * 2); ctx.fill(); }
  }

  const status = (t) => { $('pvStatus').textContent = t; };

  $('pvFile').addEventListener('change', () => {
    const f = $('pvFile').files[0];
    if (f && !$('pvName').value) $('pvName').value = f.name.replace(/\.[^.]+$/, '');
  });

  $('pvRun').addEventListener('click', async () => {
    const file = $('pvFile').files[0];
    if (!file) { status('動画ファイルを選んでください'); return; }
    draft = null;
    $('pvResult').hidden = true;
    $('pvRun').disabled = true;
    $('pvCancel').hidden = false;
    $('pvProg').hidden = false;
    $('pvProg').value = 0;
    abort = new AbortController();
    const view = $('pvView').value, hand = $('pvHand').value;
    try {
      status('姿勢推定モデルを読み込み中…');
      const reports = await analyzeVideo({
        video, file, view, hand,
        rate: Number($('pvRate').value),
        from: Number($('pvFrom').value) || 0,
        to: Number($('pvTo').value) || 0,
        signal: abort.signal,
        onProgress: (p) => { $('pvProg').value = p; },
        onFrame: drawPose,
        onThrow: (_r, n) => status(`解析中… 投球を ${n} 件検出`)
      });
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!reports.length) {
        status('投球を検出できませんでした。撮影位置(真横/真後ろ)・解析範囲・カメラが固定された映像かを確認してください。');
        return;
      }
      draft = buildPreset({ name: $('pvName').value.trim() || file.name, source: $('pvSource').value.trim(), view, hand, reports });
      status(`${reports.length} 件の投球から作成しました${abort.signal.aborted ? '(中止時点まで)' : ''}。内容を確認して保存してください。`);
      showResult(draft);
    } catch (e) {
      console.error(e);
      status('解析に失敗しました: ' + e.message);
    } finally {
      $('pvRun').disabled = false;
      $('pvCancel').hidden = true;
      $('pvProg').hidden = true;
      abort = null;
    }
  });

  $('pvCancel').addEventListener('click', () => { if (abort) abort.abort(); });

  function showResult(p) {
    const rows = describePreset(p).map((r) =>
      `<tr><td>${esc(r.title)}</td><td>${esc(r.mean)}</td><td>${esc(r.sd)}</td><td>${r.n}</td><td>${esc(r.range)}</td></tr>`).join('');
    $('pvTable').innerHTML = `<tr><th>指標</th><th>平均</th><th>ばらつき</th><th>投球数</th><th>良い範囲</th></tr>${rows}`;
    const parts = [`測定方式: ${p.method === '3d' ? '3D(体の向き基準)' : '2D(画像上。3D 座標を取得できませんでした)'}。`];
    if (p.excluded) parts.push(`${p.excluded} 件は3D で測れず2D に戻ったため、お手本から除外しました。`);
    parts.push(p.throwsCount === 1
      ? '投球が1件だけなので、ばらつきは分かりません。許容幅は指標ごとの既定値になります。'
      : '良い範囲は「平均 ± max(ばらつき, 最小許容幅)」です。');
    $('pvNote').textContent = parts.join(' ');
    $('pvResult').hidden = false;
  }

  $('pvSave').addEventListener('click', async () => {
    if (!draft) return;
    draft.name = $('pvName').value.trim() || draft.name;
    draft.source = $('pvSource').value.trim();
    await putPreset(draft);
    settings.set('presetId', draft.id);
    draft = null;
    $('pvResult').hidden = true;
    status('保存しました。このお手本を使用中にしました。');
    await render();
    onChanged();
  });

  $('pvDiscard').addEventListener('click', () => { draft = null; $('pvResult').hidden = true; status('破棄しました'); });

  $('presetImport').addEventListener('change', async () => {
    const f = $('presetImport').files[0];
    $('presetImport').value = '';
    if (!f) return;
    try {
      const p = JSON.parse(await f.text());
      if (!validatePreset(p)) throw new Error('プリセットの形式ではありません');
      if (await getPreset(p.id)) p.id = crypto.randomUUID();
      await putPreset(p);
      await render();
      onChanged();
    } catch (e) {
      alert('読み込めませんでした: ' + e.message);
    }
  });

  async function render() {
    const list = $('presetList');
    const items = await allPresets();
    const active = settings.get('presetId', '');
    if (!items.length) { list.innerHTML = '<p class="muted">まだお手本がありません。下の「動画から作成」で作れます。</p>'; return; }
    list.innerHTML = items.map((p) => {
      const src = p.source ? `<div class="muted">出典: ${esc(p.source)}</div>` : '';
      return `<div class="preset" data-id="${p.id}"><b>${esc(p.name)}${p.id === active ? ' ✅使用中' : ''}</b>` +
        `<div class="muted">${VIEW_LABEL[p.view]}・投球 ${p.throwsCount} 件・${new Date(p.createdAt).toLocaleDateString('ja-JP')}・測定方式 ${(p.method || '2d') === '3d' ? '3D' : '2D(旧方式。作り直し推奨)'}</div>${src}` +
        `<div class="actions"><button class="small" data-act="use">${p.id === active ? '使用をやめる' : '使用する'}</button>` +
        `<button class="small" data-act="export">書き出し</button><button class="small danger" data-act="del">削除</button></div></div>`;
    }).join('');
    list.querySelectorAll('.preset').forEach((el) => el.addEventListener('click', async (ev) => {
      const act = ev.target.dataset && ev.target.dataset.act;
      if (!act) return;
      const id = el.dataset.id;
      if (act === 'use') { settings.set('presetId', settings.get('presetId', '') === id ? '' : id); }
      if (act === 'del') { if (!confirm('このお手本を削除しますか？')) return; await removePreset(id); if (settings.get('presetId', '') === id) settings.set('presetId', ''); }
      if (act === 'export') {
        const p = await getPreset(id);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }));
        a.download = `preset-${p.name}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        return;
      }
      await render();
      onChanged();
    }));
  }

  return { render };
}
