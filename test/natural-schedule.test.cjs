'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createHarness, TEACHER_TOKEN } = require('./gas-harness.cjs');
const KEY = 'synthetic-anthropic-key-only-for-test';
function toolReply(input) { return { content: [{ type: 'tool_use', name: 'propose_schedule', input }], usage: { input_tokens: 900, output_tokens: 120 } }; }
function setup(options = {}) {
  const h = createHarness(), calls = [];
  const ctx = () => {
    const c = h.context();
    c.UrlFetchApp = { fetch: (url, o) => {
      calls.push({ url, o, payload: JSON.parse(o.payload) });
      const r = options.respond ? options.respond(calls.length) : null;
      return { getResponseCode: () => r ? r.code : 200, getContentText: () => JSON.stringify(r ? r.body : toolReply(options.input || { items: [], summary: '' })) };
    } };
    return c;
  };
  const post = req => JSON.parse(ctx().doPost({ postData: { contents: JSON.stringify(req) } }).getContent());
  const parse = (text, k = 'synthetic-link-a') => post({ action: 'scheduleParse', k, text });
  const setKey = () => ctx().PropertiesService.getScriptProperties().setProperty('ANTHROPIC_API_KEY', KEY);
  return { h, calls, ctx, post, parse, setKey };
}
const dump = h => JSON.stringify(h.rows('log'));

test('sentence parsing is off without a key, needs the student link, and bounds the text', () => {
  const t = setup();
  assert.equal(t.ctx().studentState_('synthetic-link-a').nlEnabled, false);
  assert.equal(t.parse('来週の月曜').errorCode, 'notConfigured');
  assert.equal(t.parse('来週の月曜', 'missing').badCode, true);
  t.setKey();
  assert.equal(t.ctx().studentState_('synthetic-link-a').nlEnabled, true);
  assert.ok(t.parse('   ').error); assert.ok(t.parse('あ'.repeat(401)).error);
  assert.equal(t.calls.length, 0);
});

test('only the text and calendar go to the API, and the proposal is normalized before it reaches the page', () => {
  const t = setup({ input: {
    items: [
      { kind: 'wish', dates: ['2026-09-09', '2026-09-01', '2026-13-01', '2027-09-01', '2026-09-09'], start: '16:00', end: '19:00', note: ' 英語 希望 ', confidence: 'high' },
      { kind: 'wish', dates: ['2026-09-10'], start: '夕方', end: '', confidence: 'low' },
      { kind: 'block', dates: ['2026-09-10'], start: '12:00', end: '', note: 'x'.repeat(150) },
      { kind: 'event', dates: ['2026-09-20', '2026-09-21', '2026-09-22'], title: '  修学旅行  ', alsoBlock: true, test: 'yes' },
      { kind: 'event', dates: ['2026-09-25'], title: '' },
      { kind: 'cancel', dates: ['2026-09-08'] },
      { kind: 'block', dates: ['2026-09-01'] }
    ],
    questions: ['夕方は何時からですか？', '', 'q'.repeat(300), '4', '5', '6', '7'],
    summary: '授業できる日と修学旅行を読み取りました。'
  } });
  t.setKey();
  const r = t.parse('来週の水曜は16時から19時、木曜は夕方。20日から3日間修学旅行。');
  assert.equal(r.ok, true); assert.equal(r.today, '2026-09-07');
  assert.deepEqual(r.items, [
    { kind: 'wish', dates: ['2026-09-09'], start: '16:00', end: '19:00', note: '英語 希望', confidence: 'high', needsTime: false },
    { kind: 'wish', dates: ['2026-09-10'], start: '', end: '', note: '', confidence: 'low', needsTime: true },
    { kind: 'block', dates: ['2026-09-10'], start: '', end: '', note: 'x'.repeat(100), confidence: 'high' },
    { kind: 'event', dates: ['2026-09-20', '2026-09-21', '2026-09-22'], start: '', end: '', note: '', confidence: 'high', title: '修学旅行', test: false, alsoBlock: true }
  ]);
  assert.equal(r.questions.length, 5); assert.equal(r.questions[1].length, 200); assert.equal(r.summary, '授業できる日と修学旅行を読み取りました。');
  assert.equal(t.calls.length, 1);
  const call = t.calls[0];
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.o.headers['x-api-key'], KEY); assert.equal(call.o.headers['anthropic-version'], '2023-06-01'); assert.equal(call.o.muteHttpExceptions, true);
  assert.equal(call.payload.model, 'claude-haiku-4-5-20251001'); assert.deepEqual(call.payload.tool_choice, { type: 'tool', name: 'propose_schedule' });
  assert.match(call.payload.messages[0].content, /来週の水曜は16時から19時/); assert.match(call.payload.system, /2026-09-07\(月\)/); assert.match(call.payload.system, /2026-11-15\(日\)/);
  const sent = JSON.stringify(call.payload);
  assert.equal(sent.includes('【テスト】'), false); assert.equal(sent.includes('synthetic-link'), false); assert.equal(sent.includes('test-a'), false);
  const log = dump(t.h);
  assert.match(log, /scheduleParse test-a chars=\d+ status=200 items=4/); assert.equal(log.includes(KEY), false); assert.equal(log.includes('修学旅行'), false);
});

test('upstream failures are reported without details and calls are limited per student per hour', () => {
  let mode = 'error';
  const t = setup({ respond: () => mode === 'error' ? { code: 500, body: { error: { type: 'api_error', message: 'secret upstream detail' } } } : mode === 'busy' ? { code: 529, body: { error: { type: 'overloaded_error' } } } : null });
  t.setKey();
  const failed = t.parse('明日');
  assert.equal(failed.errorCode, 'upstream'); assert.equal(JSON.stringify(failed).includes('secret upstream detail'), false); assert.match(dump(t.h), /status=500 api_error/);
  mode = 'busy'; assert.match(t.parse('明日').error, /混み合って/);
  mode = 'ok';
  for (let i = t.calls.length; i < 20; i++) assert.equal(t.parse('明日').ok, true);
  assert.equal(t.parse('明日').errorCode, 'rateLimited'); assert.equal(t.calls.length, 20);
  assert.equal(t.parse('明日', 'synthetic-link-b').ok, true);
  t.h.advance(3601000); assert.equal(t.parse('明日').ok, true);
});

test('the teacher variant proposes offers, blocks and events with the subject and kind lists, and applies them through the existing admin paths', () => {
  const t = setup({ input: { items: [
    { kind: 'offer', dates: ['2026-09-16', '2026-09-23'], start: '17:00', min: 90, subject: '英語', lessonKind: '演習' },
    { kind: 'offer', dates: ['2026-09-17'], start: '', subject: '数学の授業', min: 50 },
    { kind: 'block', dates: ['2026-09-20'], note: '部活の大会' },
    { kind: 'event', dates: ['2026-09-25', '2026-09-26'], title: '中間テスト', test: true },
    { kind: 'wish', dates: ['2026-09-27'] }
  ], questions: [], summary: '案内2件と授業不可、テストを読み取りました。' } });
  t.setKey();
  const admin = (op, args) => t.post({ action: 'admin', token: TEACHER_TOKEN, op, ...args });
  assert.equal(admin('lessonKindSave', { name: '演習', standardMin: 60 }).ok, true);
  for (const id of ['test-a']) t.h.setRow('students', 'id', id, { deliveryMode: 'in_person' });
  assert.equal(admin('scheduleParseTeacher', { studentId: 'nobody', text: 'x' }).errorCode, 'notFound');
  assert.ok(admin('scheduleParseTeacher', { studentId: 'test-a', text: '  ' }).error);
  assert.equal(t.h.admin('kanriStudent', { studentId: 'test-a', section: 'overview' }).data.nlEnabled, true);
  const r = admin('scheduleParseTeacher', { studentId: 'test-a', text: '来週水曜と再来週水曜17時から90分英語の演習。木曜は数学。20日は部活で休み。25・26日は中間テスト', subjects: ['英語', '数学'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.items.map(i => [i.kind, i.dates.join(','), i.start, i.min, i.subject, i.lessonKind, i.needsTime, i.title || '']), [
    ['offer', '2026-09-16,2026-09-23', '17:00', 90, '英語', '演習', false, ''],
    ['offer', '2026-09-17', '', 0, '数学', '', true, ''],
    ['block', '2026-09-20', '', undefined, undefined, undefined, undefined, ''],
    ['event', '2026-09-25,2026-09-26', '', undefined, undefined, undefined, undefined, '中間テスト']
  ]);
  const call = t.calls.at(-1);
  assert.match(call.payload.system, /科目の一覧: 英語、数学。授業の種類の一覧: 通常、演習/); assert.match(call.payload.messages[0].content, /<teacher_text>/);
  assert.equal(JSON.stringify(call.payload).includes('【テスト】'), false); assert.equal(JSON.stringify(call.payload).includes('test-a'), false);
  const a = admin('nlApplyTeacher', { studentId: 'test-a', deliveryMode: 'in_person', from: 'kanri', items: [
    { kind: 'offer', dates: ['2026-09-16', '2026-09-23'], start: '17:00', min: 90, subject: '英語', lessonKind: '演習' },
    { kind: 'block', dates: ['2026-09-20'], note: '部活の大会' },
    { kind: 'event', dates: ['2026-09-25', '2026-09-26'], title: '中間テスト', test: true }
  ] });
  assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(a.added, 4); assert.ok(a.data && a.data.id === 'test-a', 'card refreshed');
  assert.deepEqual(a.results.map(x => [x.kind, x.status, x.count, x.errors.length]), [['offer', 'added', 2, 0], ['block', 'added', 1, 0], ['event', 'added', 1, 0]]);
  const offered = t.h.rows('slots').filter(x => x.studentId === 'test-a' && x.status === 'offered');
  assert.deepEqual(offered.map(x => [x.date, x.start, Number(x.min), x.subject, x.kind]), [['2026-09-16', '17:00', 90, '英語', '演習'], ['2026-09-23', '17:00', 90, '英語', '演習']]);
  assert.deepEqual(t.h.rows('blocked').filter(b => b.studentId === 'test-a').map(b => [b.date, b.note]), [['2026-09-20', '部活の大会']]);
  assert.deepEqual(t.h.rows('events').filter(e => e.studentId === 'test-a').map(e => [e.date, e.dateTo, e.title]), [['2026-09-25', '2026-09-26', '中間テスト']]);
  const again = admin('nlApplyTeacher', { studentId: 'test-a', items: [{ kind: 'block', dates: ['2026-09-20'] }, { kind: 'offer', dates: ['2026-09-30'], start: '', min: 90, subject: '英語' }] });
  assert.equal(again.ok, true); assert.deepEqual(again.results.map(x => x.status), ['error', 'error']); assert.equal(again.added, 0);
  assert.ok(admin('nlApplyTeacher', { studentId: 'test-a', items: [] }).error);
});
