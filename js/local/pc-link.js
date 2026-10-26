// PC へ動画と付随情報を送る(PC 側の詳細分析・その日のレポート用)。
// PC のローカルサーバー(serve.mjs の /inbox/)から開いているときだけ使える。
import { localDay, pendingForDay, daysWithCounts } from './day.js';

export function initPcLink({ $, allThrows, putThrow, settings, getOpenRecord, renderHistory }) {
  let pcInbox = null; // null = 未確認 / true = 送信できる / false = できない
  async function checkInbox() {
    if (pcInbox !== null) return pcInbox;
    try {
      const r = await fetch('inbox/ping', { cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      pcInbox = !!(j && j.name === 'bowlingform-inbox');
    } catch { pcInbox = false; }
    return pcInbox;
  }

  /** PC 側の解析ツールに渡す付随情報 */
  function buildMeta(r) {
    return {
      schema: 1, id: r.id, date: r.date, day: localDay(r.date), view: r.view || 'side', hand: r.hand, mime: r.mime,
      videoStart: r.videoStart, trimStart: r.trimStart, presetName: r.presetName || '',
      report: r.report, poses: r.poses || null
    };
  }

  /** 送信キー(初回だけ入力)。入力されなければ null */
  function inboxToken() {
    let token = settings.get('inboxToken', '');
    if (!token) {
      token = (prompt('PC送信キーを入力してください(PC で node serve.mjs を起動したときに表示される24文字。初回のみ)') || '').trim();
      if (!token) return null;
      settings.set('inboxToken', token);
    }
    return token;
  }

  /** 1件を PC へ送る。戻り値: {ok} | {ok:false, unauthorized:true} | {ok:false, error} */
  async function uploadRecord(r, token) {
    try {
      let res = await fetch(`inbox/${r.id}/meta`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Inbox-Token': token }, body: JSON.stringify(buildMeta(r))
      });
      if (res.status === 401) return { ok: false, unauthorized: true };
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
      res = await fetch(`inbox/${r.id}/video`, {
        method: 'PUT', headers: { 'Content-Type': r.video.type || r.mime || 'video/mp4', 'X-Inbox-Token': token }, body: r.video
      });
      if (res.status === 401) return { ok: false, unauthorized: true };
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
      r.sentToPcAt = Date.now();
      await putThrow(r);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---- 画面部品(一般公開版の index.html には置かない。ここで足す)
  const bulkBox = document.createElement('div');
  bulkBox.className = 'note';
  bulkBox.hidden = true;
  bulkBox.innerHTML = `
    <b>PC へまとめて送信(その日のレポート用)</b>
    <label class="field">日付 <input type="date" id="bulkDay"></label>
    <label class="field check"><input type="checkbox" id="bulkResend"> 送信済みも、もう一度送る</label>
    <div class="actions"><button id="bulkSend" class="small primary">この日の投球をまとめて送信</button></div>
    <p id="bulkStatus" class="muted"></p>`;
  $('historyList').before(bulkBox);

  const sendBtn = document.createElement('button');
  sendBtn.className = 'small';
  sendBtn.hidden = true;
  sendBtn.textContent = 'PCへ送信';
  const sendStatus = document.createElement('p');
  sendStatus.className = 'muted';
  $('delBtn').before(sendBtn);
  $('delBtn').closest('.actions').after(sendStatus);

  async function sendToPc(r) {
    const status = (t) => { sendStatus.textContent = t; };
    const token = inboxToken();
    if (!token) { status('送信をやめました'); return; }
    sendBtn.disabled = true;
    status('PC へ送信中…');
    const res = await uploadRecord(r, token);
    if (res.ok) status('PC へ送信しました(PC の BowlingFormInbox フォルダ)');
    else if (res.unauthorized) { settings.set('inboxToken', ''); status('送信キーが違います。もう一度「PCへ送信」を押して、入力し直してください'); }
    else status('送信に失敗しました: ' + res.error);
    sendBtn.disabled = false;
  }

  /** その日の投球を、まとめて PC へ送る(PC 側で、その日のレポートを作る) */
  async function bulkSend() {
    const status = (t) => { $('bulkStatus').textContent = t; };
    const day = $('bulkDay').value || localDay(new Date());
    const targets = pendingForDay(await allThrows(), day, $('bulkResend').checked);
    if (!targets.length) { status(`${day} に、送る投球がありません(送信済みは除いています)`); return; }
    const token = inboxToken();
    if (!token) { status('送信をやめました'); return; }
    $('bulkSend').disabled = true;
    let done = 0;
    for (const r of targets) {
      status(`送信中 ${done + 1}/${targets.length}(${new Date(r.date).toLocaleTimeString('ja-JP')})…`);
      const res = await uploadRecord(r, token);
      if (res.unauthorized) { settings.set('inboxToken', ''); status(`送信キーが違います(${done}件は送信済み)。もう一度押して、入力し直してください`); $('bulkSend').disabled = false; return; }
      if (!res.ok) { status(`${done + 1} 件目で失敗しました: ${res.error}(${done}件は送信済み。もう一度押すと、続きから送ります)`); $('bulkSend').disabled = false; return; }
      done += 1;
    }
    status(`${day} の ${done} 件を PC へ送信しました。PC で、その日のレポートを作れます。`);
    $('bulkSend').disabled = false;
    renderHistory();
  }

  sendBtn.addEventListener('click', () => { const r = getOpenRecord(); if (r) sendToPc(r); });
  $('bulkSend').addEventListener('click', bulkSend);

  return {
    tag: (r) => (r.sentToPcAt ? '<span class="tag">PC済</span>' : ''),
    onHistory(items) {
      // PC のローカルサーバーから開いているときだけ出す。日付は、投球のある最新の日を初期値にする
      checkInbox().then((ok) => {
        bulkBox.hidden = !ok;
        if (ok && !$('bulkDay').value) $('bulkDay').value = (daysWithCounts(items)[0] || { day: localDay(new Date()) }).day;
      });
    },
    onDetail(r) {
      sendStatus.textContent = '';
      sendBtn.hidden = true;
      checkInbox().then((ok) => { const o = getOpenRecord(); if (o && o.id === r.id) sendBtn.hidden = !ok; });
    }
  };
}
