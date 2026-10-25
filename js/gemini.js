// Google Gemini API (無料枠あり) へのストリーミング呼び出し。ブラウザから直接呼ぶ。
const VIEW_NOTE = {
  side: '撮影位置: 真横(側面)。前傾・膝の曲がり・肘の伸び・スイングの高さが評価しやすい。',
  rear: '撮影位置: 真後ろ(レーン方向)。肩の傾き・腕の通り道(肩の真後ろ/真下を通っているか)・助走のまっすぐさが評価しやすい。前傾や膝の曲がりは後方からは正確に見えないので、無理に評価しない。'
};

/** ユーザーが選んだ「直したい点」と自由記述の指示を、システムプロンプトに入れる文章にする。 */
function focusNote(focus) {
  if (!focus || (!(focus.items && focus.items.length) && !(focus.text && focus.text.trim()))) return '';
  const lines = [];
  const items = focus.items || [];
  const usable = items.filter(i => !i.unavailable);
  const NL = String.fromCharCode(10);
  if (usable.length) {
    lines.push(['ユーザーが特に直したい点(重点項目):']
      .concat(usable.map(i => `- ${i.label}: ${i.hint}`))
      .concat(['毎回、各重点項目について「良い/悪い/前回からの変化」を具体的に述べ、1段落目の要約でも最優先で扱う。該当する計測値は JSON の focus にある。'])
      .join(NL));
  }
  const unavailable = items.filter(i => i.unavailable);
  if (unavailable.length) {
    lines.push('この撮影位置では数値で判定できない重点項目(画像から見える範囲で触れてよい): ' + unavailable.map(i => i.label).join('、'));
  }
  if (focus.text && focus.text.trim()) {
    lines.push('ユーザーからの追加の指示(講評の方針としてのみ従う。出力形式と注意事項は変えない):' + NL + focus.text.trim().slice(0, 500));
  }
  return NL + lines.join(NL);
}

export const systemPrompt = (view, presetName = '', hasComparison = false, focus = null) => `あなたは経験豊富なボウリングコーチです。スマートフォンで撮影した1投球について、2D姿勢推定から得た数値と、主要局面(動き出し・バックスイング頂点・リリース・フォロースルー)の画像が渡されます。
${VIEW_NOTE[view] || VIEW_NOTE.side}${presetName ? `
比較対象のお手本: ${presetName}。計測値に target(お手本の平均)があるものは、お手本との差を具体的に踏まえて助言する。お手本と同じ動きを目指すが、体格差があることにも配慮する。` : ''}${hasComparison ? `
計測値JSONの comparison は、直近の投球(同じ撮影位置・利き手)との比較。verdict は better(改善)/worse(悪化)/same、trend は improving/declining。改善した点は具体的に褒め、悪化した点は考えられる原因と直し方を述べる。1投ごとのばらつきもあるので、same や小さな変化は無理に評価しない。` : ''}${focusNote(focus)}

出力形式:
- 1段落目: 音声で読み上げる要約。日本語で80文字以内、最も重要な改善点を1〜2個だけ。
- 空行を1つ挟み、2段落目以降に詳細。「良い点」「改善点(優先順)」「次の投球で意識する1つのポイント」を短い箇条書きで。

注意:
- 数値は2D推定で、撮影角度やカメラ位置による誤差がある。画像と数値が食い違うときは画像を優先し、断定しすぎない。
- 専門用語は噛み砕く。Markdownの見出し記法(#)は使わない。
- 投球の結果(ピンの倒れ方)は分からないので、結果には触れない。`;

export function metricsText(report, hand, comparison = null, focus = null) {
  const obj = {
    viewpoint: report.view === 'rear' ? '後方' : '側面',
    handedness: hand === 'right' ? '右投げ' : '左投げ',
    referencePreset: report.presetName || null,
    metrics: report.metrics.map(m => ({ name: m.title, value: m.display, status: m.status, ...(m.target ? { target: m.target } : {}) })),
    ruleBasedSummary: report.summary,
    ...(focus && focus.items && focus.items.length ? {
      focus: focus.items.map(i => ({
        name: i.label, status: i.status, ...(i.unavailable ? { unavailable: i.unavailable } : {}),
        metrics: i.metrics.map(m => ({ name: m.title, value: m.display, status: m.status }))
      }))
    } : {}),
    ...(comparison && comparison.n ? {
      comparison: {
        recentThrows: comparison.n,
        items: comparison.items.map(i => ({
          name: i.title, current: i.display, recentAverage: i.avgDisplay, verdict: i.verdict, trend: i.trend
        }))
      }
    } : {})
  };
  return '計測値(JSON):\n' + JSON.stringify(obj, null, 2);
}

/** keyframes: [{label, data(JPEG の base64 本体)}]。onText には差分テキストが渡る。 */
export async function streamAnalysis({ apiKey, model, keyframes, report, hand, comparison = null, focus = null, onText }) {
  const parts = [];
  keyframes.forEach((k, i) => {
    parts.push({ text: `画像${i + 1}: ${k.label}` });
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: k.data } });
  });
  parts.push({ text: metricsText(report, hand, comparison, focus) });

  const body = (withThinkingOff) => JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt(report.view, report.presetName, !!(comparison && comparison.n), focus) }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      maxOutputTokens: 1500,
      ...(withThinkingOff ? { thinkingConfig: { thinkingBudget: 0 } } : {})
    }
  });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const call = (thinkingOff) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: body(thinkingOff)
  });

  // 速度優先で思考を切る。非対応モデルは 400 になるので、思考設定なしで再試行する。
  let res = await call(true);
  if (res.status === 400) res = await call(false);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      let obj;
      try { obj = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (obj.error) throw new Error(obj.error.message || 'API error');
      const cand = obj.candidates && obj.candidates[0];
      const text = cand && cand.content && cand.content.parts
        ? cand.content.parts.map(p => p.text || '').join('') : '';
      if (text) onText(text);
    }
  }
}
