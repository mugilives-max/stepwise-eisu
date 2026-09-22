// 通知に使う鍵（VAPID）を作る。
//
// 公開鍵 … 画面に配る。これが端末側で「送り主はこのサーバー」の確認に使われる
// 秘密鍵 … Cloudflare の Secret にだけ置く。ここから外に出してはいけない
//
// 秘密鍵を画面に出さずに登録できるよう、既定ではファイルに書き出して案内だけを表示する。
//   node scripts/vapid-keys.mjs
// 作ったファイルは登録後に消すこと（案内に消し方も出す）。

import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const b64url = buf => Buffer.from(buf).toString('base64url');

const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await webcrypto.subtle.exportKey('jwk', keys.privateKey);
const publicKey = b64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));

const dir = path.resolve('.vapid');
fs.mkdirSync(dir, { recursive: true });
const publicFile = path.join(dir, 'public.txt');
const privateFile = path.join(dir, 'private.txt');
fs.writeFileSync(publicFile, publicKey, 'utf8');
fs.writeFileSync(privateFile, jwk.d, 'utf8');

console.log(`通知の鍵を作りました。

公開鍵（これは人に見えても構いません）
  ${publicKey}

秘密鍵は ${privateFile} に書き出しました。中身は見なくて構いません。
次の 3 つを順に実行すると、値を画面に出さずに登録できます。

  cd cf
  npx wrangler secret put VAPID_PUBLIC_KEY < ../.vapid/public.txt
  npx wrangler secret put VAPID_PRIVATE_KEY < ../.vapid/private.txt

登録できたら、書き出したファイルを消してください。

  rm -r ../.vapid

鍵を作り直すと、それまでに登録された端末には届かなくなります（端末は登録し直しが要ります）。
`);
