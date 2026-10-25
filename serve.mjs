// LAN 内の iPhone 向けに web/ を HTTPS で配信する(カメラは HTTPS が必須)。
//   node web/serve.mjs
// 証明書は mkcert で作成したものを使う。リポジトリには置かず、環境変数 BF_CERT_DIR (既定: ~/.bowlingform-certs) から読む。
//   - HTTPS (既定 8443): アプリ本体
//   - HTTP  (既定 8080): iPhone にルート証明書(CA の公開証明書のみ)を入れるための配布用。アプリは配信しない。
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const certDir = process.env.BF_CERT_DIR || path.join(os.homedir(), '.bowlingform-certs');
const httpsPort = Number(process.env.BF_HTTPS_PORT || 8443);
const httpPort = Number(process.env.BF_HTTP_PORT || 8080);
const caFile = process.env.BF_CA_FILE || path.join(process.env.LOCALAPPDATA || '', 'mkcert', 'rootCA.pem');

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
const allowedTop = new Set(['index.html', 'style.css', 'manifest.webmanifest', 'js']);

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  const top = rel.split('/')[0];
  const file = path.resolve(root, rel);
  if (!allowedTop.has(top) || !file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': types[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(file).pipe(res);
}

const files = fs.readdirSync(certDir);
const certName = files.find(f => f.endsWith('.pem') && !f.endsWith('-key.pem'));
const keyName = files.find(f => f.endsWith('-key.pem'));
if (!certName || !keyName) {
  console.error(`証明書が見つかりません: ${certDir}`);
  process.exit(1);
}
https.createServer({ cert: fs.readFileSync(path.join(certDir, certName)), key: fs.readFileSync(path.join(certDir, keyName)) }, serveStatic)
  .listen(httpsPort, '0.0.0.0');

http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/rootCA.crt' && fs.existsSync(caFile)) {
    res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="rootCA.crt"' });
    fs.createReadStream(caFile).pipe(res);
  } else {
    const ip = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<meta name=viewport content="width=device-width"><body style="font:18px sans-serif;padding:24px">
      <p><a href="/rootCA.crt">① ルート証明書をダウンロード</a></p>
      <p>② 設定 → 一般 → VPNとデバイス管理 → 「mkcert …」をインストール</p>
      <p>③ 設定 → 一般 → 情報 → 証明書信頼設定 → 該当証明書をオン</p>
      <p>④ <a href="https://${ip}:${httpsPort}/">アプリを開く (https://${ip}:${httpsPort}/)</a></p>`);
  }
}).listen(httpPort, '0.0.0.0');

const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
for (const ip of ips) console.log(`https://${ip}:${httpsPort}/   (証明書の配布: http://${ip}:${httpPort}/)`);
