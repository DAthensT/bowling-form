// 撮影した動画を、アプリから PC へ受け取るための窓口(LAN 内のローカルサーバー用)。
//
//   GET /inbox/ping              → 200 {"ok":true,...}  (アプリが「PCへ送信」を出せるかの確認。認証なし)
//   PUT /inbox/<id>/meta         → 付随情報 (JSON)。 <inbox>/<id>/meta.json に保存
//   PUT /inbox/<id>/video        → 動画 (video/mp4 | video/webm | video/quicktime)。 <inbox>/<id>/video.<ext> に保存
//
// 安全のため:
//   - 送信キー(トークン)が必須(ヘッダ X-Inbox-Token)。キーは初回に自動生成してフォルダの .token に置き、サーバー起動時に表示する。
//   - 保存先は inbox フォルダ配下に固定。<id> は UUID 形式だけを受け付け、ファイル名はサーバー側で決める。
//   - 動画の種類とサイズに上限。Origin ヘッダがあれば、このサーバー自身のものだけ許可(他サイトのページからの書き込みを拒否)。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };

/** 環境変数 BF_INBOX_TOKEN があればそれを、なければ <dir>/.token を読み(なければ作り)、トークンを返す。 */
export function loadOrCreateToken(dir, fromEnv = process.env.BF_INBOX_TOKEN) {
  if (fromEnv) return fromEnv;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.token');
  if (fs.existsSync(file)) {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  }
  const t = crypto.randomBytes(12).toString('hex'); // 24 文字(手入力しやすい長さ)
  fs.writeFileSync(file, t + '\n');
  return t;
}

export function createInbox({ dir, token, maxVideoBytes = 1024 * 1024 * 1024, maxMetaBytes = 4 * 1024 * 1024 }) {
  fs.mkdirSync(dir, { recursive: true });

  const send = (res, status, obj) => {
    const body = JSON.stringify(obj);
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    // 大きすぎる送信には、先に返事をしてから接続を閉じる(残りを受け取り続けない)
    if (status === 413) {
      headers.Connection = 'close';
      res.once('finish', () => { if (res.req) res.req.destroy(); });
    }
    res.writeHead(status, headers);
    res.end(body);
  };

  const tokenOk = (req) => {
    const got = req.headers['x-inbox-token'];
    if (typeof got !== 'string') return false;
    const a = Buffer.from(got), b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const sameOrigin = (req) => {
    const o = req.headers.origin;
    if (!o) return true; // ブラウザ以外(スクリプト)は Origin を付けない。その場合はトークンで守る
    try { return new URL(o).host === req.headers.host; } catch { return false; }
  };

  const tooLarge = () => Object.assign(new Error('too large'), { status: 413 });

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let n = 0;
      let over = false;
      req.on('data', (c) => {
        if (over) return;
        n += c.length;
        if (n > limit) { over = true; chunks.length = 0; reject(tooLarge()); req.pause(); return; }
        chunks.push(c);
      });
      req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
      req.on('error', reject);
    });
  }

  function saveStream(req, file, limit) {
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file);
      let n = 0;
      let over = false;
      const fail = (err) => { out.destroy(); fs.rm(file, { force: true }, () => reject(err)); };
      req.on('data', (c) => {
        if (over) return;
        n += c.length;
        if (n > limit) { over = true; fail(tooLarge()); req.pause(); return; }
        if (!out.write(c)) { req.pause(); out.once('drain', () => req.resume()); }
      });
      req.on('end', () => { if (!over) out.end(() => resolve(n)); });
      req.on('error', fail);
      out.on('error', fail);
    });
  }

  async function put(req, res, id, kind) {
    if (!sameOrigin(req)) return send(res, 403, { error: 'origin not allowed' });
    if (!tokenOk(req)) return send(res, 401, { error: 'invalid token' });
    if (!ID_RE.test(id)) return send(res, 400, { error: 'invalid id' });
    const target = path.join(dir, id);

    if (kind === 'meta') {
      const body = await readBody(req, maxMetaBytes);
      let meta;
      try { meta = JSON.parse(body.toString('utf8')); } catch { return send(res, 400, { error: 'invalid json' }); }
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return send(res, 400, { error: 'invalid json' });
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'meta.json'), JSON.stringify({ ...meta, _receivedAt: new Date().toISOString() }));
      return send(res, 201, { ok: true });
    }

    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = EXT[type];
    if (!ext) return send(res, 415, { error: 'unsupported video type' });
    const length = Number(req.headers['content-length']);
    if (Number.isFinite(length) && length > maxVideoBytes) return send(res, 413, { error: 'too large' });
    fs.mkdirSync(target, { recursive: true });
    for (const old of fs.readdirSync(target)) if (old.startsWith('video.')) fs.rmSync(path.join(target, old), { force: true });
    const part = path.join(target, `video.${ext}.part`);
    const bytes = await saveStream(req, part, maxVideoBytes);
    fs.renameSync(part, path.join(target, `video.${ext}`));
    return send(res, 201, { ok: true, bytes });
  }

  return {
    dir,
    /** 処理したら true(呼び出し側は何もしない)。/inbox/ 以外は false。 */
    handle(req, res) {
      const url = new URL(req.url, 'http://x');
      if (!url.pathname.startsWith('/inbox/')) return false;
      if (req.method === 'GET' && url.pathname === '/inbox/ping') {
        send(res, 200, { ok: true, name: 'bowlingform-inbox', version: 1 });
        return true;
      }
      const m = /^\/inbox\/([^/]+)\/(meta|video)$/.exec(url.pathname);
      if (!m) { send(res, 404, { error: 'not found' }); return true; }
      if (req.method !== 'PUT') { send(res, 405, { error: 'method not allowed' }); return true; }
      put(req, res, m[1], m[2]).catch((err) => {
        if (res.headersSent) return;
        send(res, err.status || 500, { error: err.status === 413 ? 'too large' : 'upload failed' });
      });
      return true;
    }
  };
}
