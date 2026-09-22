'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSchedulingHarness, failWriteOnce } = require('./helpers/scheduling-harness.cjs');

function fixture() {
  const h = createSchedulingHarness(); h.approve();
  // A synthetic non-test name exercises the side-effect branch. Every external
  // service below is replaced by this test's local double; there is no network.
  h.setRow('students', 'id', 'test-a', { name: '架空の受講者A', email: 'fixture@example.invalid' });
  h.context().setConfig_('calendarSync', 'on');
  h.context().setConfig_('emailNotify', 'on');
  const events = new Map(), calls = { get: 0, insert: 0, patch: 0, mail: 0, conferenceRequests: [] };
  let loseInsert = false, losePatch = false, failMail = false, conferenceResult = 'success', providerUpdate = 0;
  function applyConferenceResult(event, status) {
    event.conferenceData.createRequest.status = { statusCode: status };
    if (status === 'success') event.hangoutLink = 'https://meet.google.com/synthetic';
    else delete event.hangoutLink;
  }
  function configure(ctx) {
    ctx.Calendar = { Events: {
      get(calendar, id) { calls.get++; if (!events.has(id)) throw new Error('Google Calendar 404 Not Found'); return structuredClone(events.get(id)); },
      insert(body, calendar, options) {
        calls.insert++; assert.equal(calendar, 'primary'); assert.match(body.id, /^[0-9a-v]{5,1024}$/);
        assert.equal(options.conferenceDataVersion, 1); assert.equal(options.sendUpdates, 'none'); assert.equal(body.attendees, undefined);
        if (events.has(body.id)) throw new Error('409 The requested identifier already exists');
        const event = structuredClone({ ...body, iCalUID: body.id + '@google.com', etag: 'etag-1', status: 'confirmed' });
        if (body.conferenceData) { applyConferenceResult(event, conferenceResult); calls.conferenceRequests.push(body.conferenceData.createRequest.requestId); }
        events.set(body.id, event);
        if (loseInsert) { loseInsert = false; throw new Error('Synthetic timeout after committed Calendar insert'); }
        return structuredClone(event);
      },
      patch(body, calendar, id, options) {
        assert.equal(options.sendUpdates, 'none'); assert.equal(body.attendees, undefined);
        calls.patch++; const prior = events.get(id); if (!prior) throw new Error('404 Not Found');
        const event = structuredClone({ ...prior, ...body, etag: 'etag-' + (calls.patch + 1) });
        if (body.conferenceData === null) { delete event.conferenceData; delete event.hangoutLink; }
        else if (body.conferenceData) { applyConferenceResult(event, conferenceResult); calls.conferenceRequests.push(body.conferenceData.createRequest.requestId); }
        events.set(id, event);
        if (losePatch) { losePatch = false; throw new Error('Synthetic timeout after committed Calendar patch'); }
        return structuredClone(event);
      }
    } };
    ctx.MailApp.sendEmail = () => { calls.mail++; if (failMail) throw new Error('Synthetic ambiguous mail send'); };
  }
  return Object.assign(h, { events, calls, configure,
    send: req => h.requestWith(req, configure),
    batch: (ids, id = 'calendar-batch-request') => h.requestWith({ action: 'acceptMany', k: 'synthetic-link-a', slotIds: ids, requestId: id, expectedSnapshots: ids.map(h.snapshot) }, configure),
    loseInsert: () => { loseInsert = true; }, losePatch: () => { losePatch = true; }, failMail: () => { failMail = true; },
    nextConferenceResult: status => { conferenceResult = status; },
    finishConference: (id, status = 'success') => { const event = events.get(id); applyConferenceResult(event, status); event.etag = 'provider-update-' + (++providerUpdate); }
  });
}

test('a lost Calendar insert response reuses its deterministic event and sends one summary', () => {
  const h = fixture(), slot = h.seedSlot({ deliveryMode: 'online' });
  h.loseInsert();
  assert.equal(h.batch([slot.id]).pending, true);
  assert.equal(h.events.size, 1); assert.equal(h.rows('slots')[0].status, 'offered');
  const resumed = h.batch([slot.id]);
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(h.calls.insert, 1); assert.equal(h.calls.mail, 1);
  assert.equal(h.rows('slots')[0].meetUrl, 'https://meet.google.com/synthetic');
  assert.match(h.rows('slots')[0].eventId, /@google\.com$/);
  assert.equal(h.batch([slot.id]).ok, true);
  assert.equal(h.calls.insert, 1); assert.equal(h.calls.mail, 1);
});

for (const after of [false, true]) test(`Calendar is not duplicated when booking cells fail ${after ? 'after persistence' : 'before persistence'}`, () => {
  const h = fixture(), slot = h.seedSlot();
  failWriteOnce(h.spreadsheet.getSheetByName('slots'), values => values[0][4] === 'booked', after);
  assert.equal(h.batch([slot.id]).pending, true);
  const result = h.batch([slot.id]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(h.calls.insert, 1); assert.equal(h.events.size, 1); assert.equal(h.calls.mail, 1);
  assert.equal(h.rows('slots')[0].meetUrl, '');
  assert.equal(h.calls.conferenceRequests.length, 0);
});

test('12 confirmations send one summary while Calendar creates exactly one event per lesson', () => {
  const h = fixture();
  const ids = Array.from({ length: 12 }, (_, i) => h.seedSlot({ date: '2026-09-' + String(i + 10).padStart(2, '0') }).id);
  assert.equal(h.batch(ids).ok, true);
  assert.equal(h.calls.insert, 12); assert.equal(h.calls.mail, 1);
  assert.equal(h.batch(ids).ok, true);
  assert.equal(h.calls.insert, 12); assert.equal(h.calls.mail, 1);
});

test('uncertain notification is visible and never automatically sent twice', () => {
  const h = fixture(), slot = h.seedSlot(); h.failMail();
  const result = h.batch([slot.id]);
  assert.equal(result.ok, true); assert.equal(result.pending, false);
  assert.equal(result.notification, 'uncertain'); assert.ok(result.warning);
  const replay = h.batch([slot.id]);
  assert.equal(replay.notification, 'uncertain'); assert.equal(h.calls.mail, 1);
});

test('a saved notification claim with a lost response becomes uncertain instead of a duplicate send', () => {
  const h = fixture(), slot = h.seedSlot();
  failWriteOnce(h.spreadsheet.getSheetByName('acceptWrites'), values => values[0][6] === 'attempting', true);
  assert.equal(h.batch([slot.id]).pending, true);
  const result = h.batch([slot.id]);
  assert.equal(result.ok, true); assert.equal(result.notification, 'uncertain');
  assert.equal(h.calls.mail, 0); // Cannot prove whether a real send started after this durable boundary.
});

test('mode change converges after a lost Calendar response and supports repeated online/in-person changes', () => {
  const h = fixture(), slot = h.seedSlot();
  assert.equal(h.batch([slot.id]).ok, true);
  const req = h.teacherRequest('setSlotDeliveryMode', { studentId: 'test-a', slotId: slot.id, expectedMode: 'in_person', deliveryMode: 'online' });
  h.losePatch();
  assert.equal(h.send(req).errorCode, 'pending');
  assert.equal(h.rows('slots')[0].deliveryMode, 'in_person');
  assert.equal(h.send(req).ok, true);
  assert.equal(h.rows('slots')[0].deliveryMode, 'online');
  assert.equal(h.calls.conferenceRequests.length, 1);
  assert.equal(h.send({ ...req, requestId: 'synthetic-mode-back', expectedMode: 'online', deliveryMode: 'in_person' }).ok, true);
  assert.equal(h.rows('slots')[0].meetUrl, '');
  assert.equal(h.send({ ...req, requestId: 'synthetic-mode-again' }).ok, true);
  assert.equal(h.calls.conferenceRequests.length, 2);
  assert.notEqual(h.calls.conferenceRequests[0], h.calls.conferenceRequests[1]);
});

test('test students skip Calendar and Mail even with integration settings enabled', () => {
  const h = fixture(); h.setRow('students', 'id', 'test-a', { name: '【テスト】副作用なし' });
  const slot = h.seedSlot({ deliveryMode: 'online' });
  assert.equal(h.batch([slot.id]).ok, true);
  assert.equal(h.calls.get + h.calls.insert + h.calls.mail, 0);
});

// Meet は Google 側で少し遅れて発行される。以前はそれが済むまで確定を保留していたが、
// その待ち時間はそのまま生徒・先生の待ち時間になっていた。今は台帳を先に確定し、
// URL は発行されしだい書き戻す（画面はそれまで「準備中」と出す）。

test('Meet がまだでも、オンライン授業はその場で確定する', () => {
  const h = fixture(), slot = h.seedSlot({ deliveryMode: 'online' }); h.nextConferenceResult('pending');
  const first = h.batch([slot.id]);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.pending, false, '確定を保留している');
  assert.equal(h.rows('slots')[0].status, 'booked');
  assert.match(h.rows('slots')[0].eventId, /@google\.com$/, 'カレンダーの予定が結びついていない');
  assert.equal(h.rows('slots')[0].meetUrl, '', 'まだ出ていない URL を入れている');
  assert.equal(h.calls.mail, 1, '確定の知らせが出ていない');
  assert.equal(h.calls.insert, 1); assert.equal(h.calls.patch, 0, '発行待ちのまま作り直している');
});

test('発行し直しが要る失敗のときも、確定は止めない', () => {
  const h = fixture(), slot = h.seedSlot({ deliveryMode: 'online' }); h.nextConferenceResult('failure');
  const out = h.batch([slot.id]);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(h.rows('slots')[0].status, 'booked');
  assert.equal(h.rows('slots')[0].meetUrl, '', '失敗した会議室の URL を入れている');
  assert.equal(h.events.size, 1); assert.equal(h.calls.insert, 1);
});

test('Meet が出たあとに同じ処理を送り直しても、予定は増えない', () => {
  const h = fixture(), slot = h.seedSlot({ deliveryMode: 'online' }); h.nextConferenceResult('pending');
  assert.equal(h.batch([slot.id]).ok, true);
  h.finishConference([...h.events.keys()][0]);
  const again = h.batch([slot.id]);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(h.events.size, 1, 'カレンダーの予定が増えている');
  assert.equal(h.calls.insert, 1); assert.equal(h.calls.mail, 1, '知らせを二度出している');
});

test('対面からオンラインへの切り替えも、Meet を待たずに通る', () => {
  const h = fixture(), slot = h.seedSlot(); assert.equal(h.batch([slot.id]).ok, true);
  const req = h.teacherRequest('setSlotDeliveryMode', { studentId: 'test-a', slotId: slot.id, expectedMode: 'in_person', deliveryMode: 'online' });
  h.nextConferenceResult('pending');
  const out = h.send(req);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(h.rows('slots')[0].deliveryMode, 'online', '切り替わっていない');
  assert.equal(h.rows('slots')[0].meetUrl, '', 'まだ出ていない URL を入れている');
});

test('すでに出ている Meet を、空で上書きしない', () => {
  const h = fixture(), slot = h.seedSlot({ deliveryMode: 'online' });
  assert.equal(h.batch([slot.id]).ok, true);
  h.finishConference([...h.events.keys()][0]);
  // いちど URL が入った状態を作る
  const mode = h.teacherRequest('setSlotDeliveryMode', { studentId: 'test-a', slotId: slot.id, expectedMode: 'online', deliveryMode: 'online' });
  h.send(mode);
  const saved = h.rows('slots')[0].meetUrl;
  assert.match(String(saved), /^https:\/\//, '前提が崩れている（URL が入っていない）');
  // 題名だけが変わるような書き換えのあとも、URL は残る
  h.send(h.teacherRequest('setSlotDeliveryMode', { studentId: 'test-a', slotId: slot.id, expectedMode: 'online', deliveryMode: 'online' }));
  assert.equal(h.rows('slots')[0].meetUrl, saved, 'URL が消えている');
});

test('カレンダーの予定が無い古い予約も、切り替えでその場で直る', () => {
  const h = fixture(), slot = h.seedSlot({ status: 'booked', eventId: '', meetUrl: '' });
  const req = h.teacherRequest('setSlotDeliveryMode', { studentId: 'test-a', slotId: slot.id, expectedMode: 'in_person', deliveryMode: 'online' });
  h.nextConferenceResult('pending');
  const out = h.send(req);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(h.rows('slots')[0].deliveryMode, 'online');
  assert.match(h.rows('slots')[0].eventId, /@google\.com$/, 'カレンダーの予定が作られていない');
  assert.equal(h.events.size, 1); assert.equal(h.calls.mail, 0);
});

test('同じ処理番号で内容を変えた送り直しは断る。新しい処理番号なら戻せる', () => {
  const h = fixture(), slot = h.seedSlot({ status: 'booked', eventId: '', meetUrl: '' });
  const req = h.teacherRequest('setSlotDeliveryMode', { studentId: 'test-a', slotId: slot.id, expectedMode: 'in_person', deliveryMode: 'online' });
  h.nextConferenceResult('pending');
  assert.equal(h.send(req).ok, true, 'Meet を待たずに通らない');
  // 同じ処理番号で中身だけ変えた送り直しは、取り違えになるので断る
  assert.equal(h.send({ ...req, deliveryMode: 'in_person' }).errorCode, 'conflict');
  // 新しい処理番号なら、対面に戻せる
  assert.equal(h.send({ ...req, requestId: 'synthetic-mode-back', expectedMode: 'online', deliveryMode: 'in_person' }).ok, true);
  assert.equal(h.rows('slots')[0].deliveryMode, 'in_person'); assert.equal(h.rows('slots')[0].meetUrl, '');
  const event = [...h.events.values()][0]; assert.equal(event.conferenceData, undefined); assert.match(event.summary, /対面/);
  assert.equal(h.calls.insert, 1); assert.equal(h.events.size, 1);
});
