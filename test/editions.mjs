// 一般公開版(GitHub Pages)とローカル版(開発機能)が混ざっていないことを確かめる。
//   node test/editions.mjs          リポジトリの作業ツリーを検査
//   node test/editions.mjs _site    公開用に組んだ _site を検査(js/local が無いことも確かめる)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staged = !!process.argv[2];
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// 1. リポジトリ上の edition.js は 'public'(ローカル版への差し替えは serve.mjs だけが行う)
assert.match(read('js/edition.js'), /EDITION = 'public'/);

// 2. 公開版に載るファイル(js/local 以外)に、開発機能の痕跡がない。唯一の例外は main.js の、ローカル版だけの動的 import
const publicFiles = ['index.html', ...fs.readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js') && f !== 'edition.js').map((f) => 'js/' + f)];   // edition.js は 1. で確認済み
for (const f of publicFiles) {
  let text = read(f);
  if (f === 'js/main.js') {
    const guarded = /if \(EDITION === 'local'\) \{\s*import\('\.\/local\/index\.js'\)/;
    assert.match(text, guarded, 'main.js must load js/local only when EDITION is local');
    text = text.replace(guarded, '');
  }
  for (const word of ['inbox', 'js/local', './local/', 'bulkSend', 'sendPc', 'sentToPcAt', 'X-Inbox-Token']) {
    assert.ok(!text.includes(word), `${f} contains "${word}" (local-only feature in the public edition)`);
  }
}

// 3. 公開用に組んだサイトには js/local が入っていない
if (staged) assert.ok(!fs.existsSync(path.join(root, 'js/local')), 'js/local must not be published');
else {
  // 4. ローカルサーバーは edition.js を 'local' で返し、js/local を配信できる
  const serve = read('serve.mjs');
  assert.match(serve, /EDITION = 'local'/);
  assert.ok(fs.existsSync(path.join(root, 'js/local/index.js')));
}
console.log('OK');
