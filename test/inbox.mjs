// 動画の受け口(inbox.mjs)のテスト。実際に HTTP サーバーを立てて、アップロードの成功・拒否を確認する。 node test/inbox.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInbox, loadOrCreateToken } from '../inbox.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-inbox-'));
const token = loadOrCreateToken(dir, '');
assert.match(token, /^[0-9a-f]{24}$/, 'a token is generated');
assert.equal(loadOrCreateToken(dir, ''), token, 'the same token is reused');
assert.equal(loadOrCreateToken(dir, 'from-env'), 'from-env', 'an env token wins');

const inbox = createInbox({ dir, token, maxVideoBytes: 1000, maxMetaBytes: 200 });
const server = http.createServer((req, res) => { if (!inbox.handle(req, res)) { res.writeHead(404); res.end('static'); } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const call = (method, p, { body = null, headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'X-Inbox-Token': token, ...headers } }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(data); } catch { return data; } })() }));
  });
  req.on('error', reject);
  if (body !== null) req.write(body);
  req.end();
});

const id = '123e4567-e89b-42d3-a456-426614174000';

try {
  // ping は認証なし。/inbox/ 以外は素通し
  assert.equal((await call('GET', '/inbox/ping', { headers: { 'X-Inbox-Token': '' } })).status, 200);
  assert.equal((await call('GET', '/index.html')).json, 'static');

  // メタ情報の保存
  let r = await call('PUT', `/inbox/${id}/meta`, { body: JSON.stringify({ id, view: 'rear', hand: 'right' }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 201);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, id, 'meta.json'), 'utf8'));
  assert.equal(meta.view, 'rear');
  assert.ok(meta._receivedAt, 'receive time is recorded');

  // 動画の保存(Content-Type に codecs が付いていても受け付ける)
  const data = Buffer.alloc(500, 7);
  r = await call('PUT', `/inbox/${id}/video`, { body: data, headers: { 'Content-Type': 'video/mp4;codecs=avc1', 'Content-Length': 500 } });
  assert.equal(r.status, 201);
  assert.equal(r.json.bytes, 500);
  assert.deepEqual(fs.readFileSync(path.join(dir, id, 'video.mp4')), data);
  assert.ok(!fs.readdirSync(path.join(dir, id)).some((f) => f.endsWith('.part')), 'no partial file is left');
  // 送り直すと置き換わる(拡張子が変わっても古い動画は残らない)
  r = await call('PUT', `/inbox/${id}/video`, { body: Buffer.alloc(10, 1), headers: { 'Content-Type': 'video/webm', 'Content-Length': 10 } });
  assert.equal(r.status, 201);
  assert.deepEqual(fs.readdirSync(path.join(dir, id)).sort(), ['meta.json', 'video.webm']);

  // 拒否するもの
  assert.equal((await call('PUT', `/inbox/${id}/meta`, { body: '{}', headers: { 'X-Inbox-Token': 'wrong', 'Content-Type': 'application/json' } })).status, 401, 'wrong token');
  assert.equal((await call('PUT', `/inbox/${id}/meta`, { body: '{}', headers: { 'X-Inbox-Token': '' } })).status, 401, 'empty token');
  assert.equal((await call('PUT', `/inbox/../etc/meta`, { body: '{}' })).status, 404, 'path tricks never reach a handler');
  assert.equal((await call('PUT', `/inbox/not-a-uuid/meta`, { body: '{}' })).status, 400, 'bad id');
  assert.equal((await call('PUT', `/inbox/${id}/meta`, { body: 'not json' })).status, 400, 'bad json');
  assert.equal((await call('PUT', `/inbox/${id}/meta`, { body: '[1,2]' })).status, 400, 'json must be an object');
  assert.equal((await call('PUT', `/inbox/${id}/meta`, { body: JSON.stringify({ pad: 'x'.repeat(300) }) })).status, 413, 'meta too large');
  assert.equal((await call('PUT', `/inbox/${id}/video`, { body: Buffer.alloc(5), headers: { 'Content-Type': 'application/zip' } })).status, 415, 'not a video');
  assert.equal((await call('PUT', `/inbox/${id}/video`, { body: Buffer.alloc(2000, 1), headers: { 'Content-Type': 'video/mp4', 'Content-Length': 2000 } })).status, 413, 'video too large (declared)');
  assert.equal((await call('PUT', `/inbox/${id}/other`, { body: '{}' })).status, 404, 'unknown kind');
  assert.equal((await call('POST', `/inbox/${id}/meta`, { body: '{}' })).status, 405, 'only PUT');
  assert.equal((await call('PUT', `/inbox/${id}/meta`, { body: '{}', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' } })).status, 403, 'foreign origin');
  assert.equal((await call('PUT', `/inbox/${id}/meta`, { body: '{}', headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' } })).status, 201, 'same origin is fine');

  // 申告より多く送ってきたときも、上限で止める(部分ファイルを残さない)
  const id2 = '223e4567-e89b-42d3-a456-426614174000';
  await call('PUT', `/inbox/${id2}/video`, { body: Buffer.alloc(3000, 1), headers: { 'Content-Type': 'video/mp4' } }).catch(() => ({}));
  const leftovers = fs.existsSync(path.join(dir, id2)) ? fs.readdirSync(path.join(dir, id2)) : [];
  assert.ok(!leftovers.some((f) => f.startsWith('video.')), `oversized upload leaves nothing: ${leftovers}`);

  // 書き込みは inbox の外に出ない
  assert.ok(fs.readdirSync(dir).every((f) => f === '.token' || /^[0-9a-f-]{36}$/.test(f)), 'only <uuid> folders and the token live in the inbox');
  console.log('inbox OK');
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
