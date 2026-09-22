// プッシュ通知。端末の登録と、実際の送信。
//
// 通知はメールの置き換えではなく、気づきの経路を増やすもの。だから送れなくても
// 台帳の処理は一切止めない（応答を返したあとに送る）。
//
// 登録できるのは本人だけ。生徒は専用リンクの鍵、保護者はログイン済みの合図で確かめる。
// どちらの確認も台帳側の関数（findStudentByCode_ / familyRequire_）をそのまま使う。
//
// endpoint は「知っていればその端末に通知を送れる」値なので、応答にも記録にも書き出さない。
import { createRuntime } from './read.mjs';
import { send } from '../lib/webpush.mjs';

export const PUSH_ACTIONS = ['pushInfo', 'pushSubscribe', 'pushUnsubscribe'];

const MAX_DEVICES = 10;      // ひとりが登録できる端末の数
const MAX_FAILURES = 5;      // これだけ続けて失敗したら、その登録は捨てる

function vapidOf(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return {
    publicKey: String(env.VAPID_PUBLIC_KEY),
    privateKey: String(env.VAPID_PRIVATE_KEY),
    subject: String(env.VAPID_SUBJECT || 'https://www.stepwise-education.jp'),
  };
}

export function pushEnabled(env) { return !!vapidOf(env); }

// 誰からの登録かを確かめる。台帳側の確認をそのまま使う
async function ownerOf(body, env, options) {
  const gas = await createRuntime(env, options);
  if (body.k) {
    const student = gas.findStudentByCode_(String(body.k));
    if (!student) return { error: '専用リンクからひらき直してください', badCode: true };
    return { ownerKind: 'student', owner: String(student.id) };
  }
  const h = gas.familyRequire_(body);
  if (h.error) return h;
  return { ownerKind: 'family', owner: String(h.account.id) };
}

function validSubscription(s) {
  if (!s || typeof s !== 'object') return false;
  const endpoint = String(s.endpoint || '');
  if (!/^https:\/\/[^\s]{10,500}$/.test(endpoint)) return false;
  return /^[A-Za-z0-9_-]{60,200}$/.test(String(s.p256dh || '')) && /^[A-Za-z0-9_-]{16,50}$/.test(String(s.auth || ''));
}

/**
 * 端末を登録する / 登録を外す。画面から直接呼ばれる。
 * 応答に endpoint は含めない（他人に渡ると、その端末へ通知を送れてしまう）。
 */
export async function handlePush(body, env, options = {}) {
  const action = String(body.action || '');
  if (PUSH_ACTIONS.indexOf(action) < 0) return null;
  const vapid = vapidOf(env);
  // 通知が使えるかどうかは、本人確認の前に答えてよい（公開鍵は配るためのもの）
  if (action === 'pushInfo') return { ok: true, enabled: !!vapid, publicKey: vapid ? vapid.publicKey : '' };
  if (!vapid) return { error: '通知はまだ使えません', errorCode: 'pushDisabled' };

  const who = await ownerOf(body, env, options);
  if (who.error) return who;

  const sub = body.subscription;
  if (!validSubscription(sub)) return { error: '通知の登録内容が正しくありません', errorCode: 'badSubscription' };
  const endpoint = String(sub.endpoint);

  if (action === 'pushUnsubscribe') {
    await env.DB.prepare('delete from pushSubs where endpoint = ? and ownerKind = ? and owner = ?')
      .bind(endpoint, who.ownerKind, who.owner).run();
    return { ok: true, subscribed: false };
  }

  const now = new Date().toISOString();
  await env.DB.batch([
    // 同じ端末を別の人が使い回した場合に備えて、古い結びつきは消してから入れ直す
    env.DB.prepare('delete from pushSubs where endpoint = ?').bind(endpoint),
    env.DB.prepare('insert into pushSubs (endpoint, ownerKind, owner, p256dh, auth, createdAt) values (?, ?, ?, ?, ?, ?)')
      .bind(endpoint, who.ownerKind, who.owner, String(sub.p256dh), String(sub.auth), now),
    // 端末が増えすぎたら古いものから落とす
    env.DB.prepare(`delete from pushSubs where ownerKind = ? and owner = ? and endpoint not in
      (select endpoint from pushSubs where ownerKind = ? and owner = ? order by createdAt desc limit ?)`)
      .bind(who.ownerKind, who.owner, who.ownerKind, who.owner, MAX_DEVICES),
  ]);
  return { ok: true, subscribed: true };
}

/**
 * ひとりの登録端末すべてに送る。応答を返したあとに呼ぶ。
 * 送れない端末（消えている・続けて失敗している）は片付ける。
 */
export async function notify(env, ownerKind, owner, message, options = {}) {
  const vapid = vapidOf(env);
  if (!vapid || !owner) return { sent: 0 };
  const rows = await env.DB.prepare('select endpoint, p256dh, auth from pushSubs where ownerKind = ? and owner = ?')
    .bind(String(ownerKind), String(owner)).all();
  const subs = rows.results || [];
  if (!subs.length) return { sent: 0 };

  const payload = JSON.stringify(message);
  const now = new Date().toISOString();
  const statements = [];
  let sent = 0;
  for (const sub of subs) {
    let out;
    try { out = await send(sub, payload, vapid, options); }
    catch (e) { out = { ok: false, gone: false, status: 0, error: String((e && e.message) || e) }; }
    if (out.ok) {
      sent++;
      statements.push(env.DB.prepare('update pushSubs set lastOkAt = ?, failures = 0, lastError = ? where endpoint = ?').bind(now, '', sub.endpoint));
    } else if (out.gone) {
      statements.push(env.DB.prepare('delete from pushSubs where endpoint = ?').bind(sub.endpoint));
    } else {
      statements.push(env.DB.prepare('update pushSubs set failures = failures + 1, lastError = ? where endpoint = ?')
        .bind(('HTTP ' + out.status).slice(0, 100), sub.endpoint));
    }
  }
  statements.push(env.DB.prepare('delete from pushSubs where failures >= ?').bind(MAX_FAILURES));
  await env.DB.batch(statements);
  return { sent, devices: subs.length };
}

// ---- どの操作で、誰に、何を知らせるか ----
//
// 台帳を書いた結果から決める。通知を増やすときはここに足す。
// 本文は短く、誰の何かが分かる程度にとどめる（端末のロック画面に出るため）。

export function noticeFor(body, result) {
  if (!result || result.error) return null;
  const action = String(body.action || ''), op = String(body.op || '');

  if (action !== 'admin' || !result.ok) return null;

  // 先生が授業の案内を出した → その生徒へ（既にあるメール通知と同じ場面）
  if (op === 'offer' && Number(result.added) > 0) {
    return { ownerKind: 'student', owner: String(body.studentId || ''), message: {
      title: '授業の案内が届きました',
      body: Number(result.added) + '件の候補が届いています。予定を確認してください',
      url: '/yoyaku/#home', tag: 'offer',
    } };
  }
  // 先生が学習計画の案内を送った → その生徒の保護者へ（宛先は呼び出し側で解決する）
  if (op === 'planLineSave' && (body.propose === true || String(body.propose) === 'true')) {
    return { ownerKind: 'familyOfStudent', owner: String(body.studentId || ''), message: {
      title: '学習計画の承認のお願い',
      body: '先生から計画の案内が届いています。内容をご確認ください',
      url: '/hogosha/#family/home', tag: 'plan',
    } };
  }
  return null;
}

/** 応答を返したあとに呼ぶ。失敗しても利用者の操作は成功したまま。 */
export async function deliverNotice(env, body, result, options = {}) {
  if (!pushEnabled(env)) return { sent: 0 };
  const notice = noticeFor(body, result);
  if (!notice || !notice.owner) return { sent: 0 };

  if (notice.ownerKind === 'familyOfStudent') {
    const rows = await env.DB.prepare('select familyId from familyLinks where studentId = ? and active = 1').bind(notice.owner).all();
    let sent = 0;
    for (const row of rows.results || []) sent += (await notify(env, 'family', row.familyId, notice.message, options)).sent;
    return { sent };
  }
  return notify(env, notice.ownerKind, notice.owner, notice.message, options);
}
