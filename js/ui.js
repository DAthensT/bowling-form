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
}
