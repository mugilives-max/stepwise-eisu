// stepwise-effects: v2（Worker）に頼まれたメール・カレンダーの代行だけをする、独立した Apps Script。
//
// 2026-10-10 の決定（issues/stepwise-v2-google-relay.md）: 旧システムのシートに紐づいた Apps Script（gas/。30 ファイル）から、
// v2 が使う部分（gas/Sync.gs の effectsOp_ とその下）だけを取り出した。シートは使わない。設定は Script Properties だけ。
//   WORKER_SYNC_KEY : Worker の SYNC_KEY と同じ文字列（24 文字以上）。これが合うときだけ動く
//   CALENDAR_SYNC   : 'off' にするとカレンダーには触らない（メールだけ送る）。無ければ on
// 公開は「ウェブアプリ」（実行するユーザー: 自分、アクセス: 全員）。その URL を Worker の GAS_URL に入れる。
// 頼まれる形（cf/v2/effects.mjs の deliverEffects と同じ）:
//   { action: 'effects', key, items: [{ kind: 'mail'|'calendarCreate'|'calendarPatch'|'calendarMeet'|'calendarDelete', ... }] }
// 返す形: { ok: true, done, writebacks: [{ marker, eventId, meetUrl }], failed: [{ kind, error }] }

var KIND_HANDLERS_ = {
  mail: function (item) { sendMail_(item); return null; },
  calendarCreate: createEvent_,
  calendarPatch: patchEvent_,
  calendarMeet: meetOnly_,
  calendarDelete: function (item) { deleteEvent_(item); return null; },
};

function doGet() { return json_({ ok: true, service: 'stepwise-effects', calendar: calendarOn_() }); }

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: 'JSON ではありません' }); }
  if (!req || req.action !== 'effects') return json_({ error: '知らない操作です' });
  var key = String(PropertiesService.getScriptProperties().getProperty('WORKER_SYNC_KEY') || '').trim();
  if (key.length < 24 || String(req.key || '') !== key) { Utilities.sleep(300); return json_({ error: '鍵が正しくありません', badAuth: true }); }
  var items = Array.isArray(req.items) ? req.items : [];
  var writebacks = [], done = 0, failed = [];
  for (var i = 0; i < items.length && i < 50; i++) {
    var item = items[i] || {};
    try {
      var handler = KIND_HANDLERS_[String(item.kind || '')];
      if (!handler) throw new Error('知らない種類: ' + item.kind);
      var w = handler(item);
      if (w) writebacks.push(w);
      done++;
    } catch (err) {
      failed.push({ kind: String(item.kind || ''), error: String((err && err.message) || err).slice(0, 200) });
    }
  }
  return json_({ ok: true, done: done, writebacks: writebacks, failed: failed });
}

function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function calendarOn_() { return String(PropertiesService.getScriptProperties().getProperty('CALENDAR_SYNC') || 'on').trim() !== 'off'; }

// 宛先 'TEACHER' は代表自身のアドレス（Worker には実アドレスを置かない）
function sendMail_(item) {
  var to = String(item.to || '') === 'TEACHER' ? Session.getEffectiveUser().getEmail() : String(item.to || '');
  if (!to) return;
  var options = { to: to, subject: String(item.subject || ''), body: String(item.body || '') };
  if (item.name) options.name = String(item.name);
  MailApp.sendEmail(options);
}

function createEvent_(item) {
  if (!calendarOn_()) return null;
  var ev = Calendar.Events.insert(item.body, 'primary', { conferenceDataVersion: 1, sendUpdates: 'none' });
  var eventId = String(ev.iCalUID || ev.id + '@google.com');
  return { marker: String(item.marker || ''), eventId: eventId, meetUrl: item.wantMeet ? meetUrl_(eventId, 5) : '' };
}

// 既にある予定の書き換え（題名の変更、対面⇔オンラインの切り替え）
function patchEvent_(item) {
  if (!calendarOn_()) return null;
  var id = String(item.marker || '').split('@')[0];
  if (!id) return null;
  var event;
  try { event = Calendar.Events.patch(item.body || {}, 'primary', id, { conferenceDataVersion: 1, sendUpdates: 'none' }); }
  catch (err) { if (!missing_(err)) throw err; return null; }
  var eventId = String(event.iCalUID || event.id + '@google.com');
  return { marker: String(item.marker || ''), eventId: eventId, meetUrl: item.wantMeet ? meetUrl_(eventId, 5) : '' };
}

// 発行が間に合わなかった Meet の取り直し。取れたときだけ書き戻す
function meetOnly_(item) {
  if (!calendarOn_()) return null;
  var eventId = String(item.eventId || '');
  if (!eventId) return null;
  var meet = meetUrl_(eventId, 2);
  return meet ? { marker: eventId, eventId: eventId, meetUrl: meet } : null;
}

function deleteEvent_(item) {
  if (!calendarOn_()) return;
  try { Calendar.Events.remove('primary', String(item.eventId || '').split('@')[0], { sendUpdates: 'none' }); }
  catch (err) { if (!/\b404\b|\b410\b|not found|already deleted/i.test(String(err))) throw err; }
}

// Meet は発行までに少し間がある。利用者を待たせていない場所なので何度か取りに行き、取れなければ空（画面は「準備中」のまま）
function meetUrl_(eventId, tries) {
  var meet = '';
  for (var i = 0; i < tries && !meet; i++) {
    if (i) Utilities.sleep(1200);
    try { meet = addMeet_(eventId); } catch (err) { meet = ''; }
  }
  return meet;
}

function addMeet_(calEventId) {
  var id = String(calEventId).split('@')[0];
  var existing = Calendar.Events.get('primary', id);
  if (existing.hangoutLink) return existing.hangoutLink;
  var res = Calendar.Events.patch({ conferenceData: { createRequest: { requestId: Utilities.getUuid(), conferenceSolutionKey: { type: 'hangoutsMeet' } } } },
    'primary', id, { conferenceDataVersion: 1, sendUpdates: 'none' });
  if (res.hangoutLink) return res.hangoutLink;
  var eps = (res.conferenceData && res.conferenceData.entryPoints) || [];
  for (var i = 0; i < eps.length; i++) if (eps[i].entryPointType === 'video') return eps[i].uri || '';
  return '';
}

function missing_(err) { return /\b404\b|not found/i.test(String(err)); }

/** エディタから一度実行して、メールとカレンダーの権限に同意する（公開の前に） */
function authorize() {
  MailApp.getRemainingDailyQuota();
  Calendar.CalendarList.list({ maxResults: 1 });
  return 'ok: ' + Session.getEffectiveUser().getEmail();
}
