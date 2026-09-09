'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFamilyHarness } = require('./helpers/family-harness.cjs');
const { MCP_KEY } = require('./gas-harness.cjs');

const PASS = 'Synthetic family password!';
const EMAIL = 'parent@example.invalid';
test('family billing projection respects the authenticated child links and rejects missing sessions',()=>{
  const h=createFamilyHarness(),v=verified(h,create(h,['test-a']));
  h.context().ensureBillingSchema_();const sh=h.ledger.getSheetByName('入金管理');
  for(const [id,amount] of [['test-a',3000],['test-b',99999]]){const row={'年月':'2026-09','生徒ID':id,'請求ID':'invoice-'+id,'請求額':amount,'状態':'未入金'};sh.appendRow(sh.values[0].map(k=>row[k]??''));}
  const home=ok(h.family('familyHome',{ftoken:v.ftoken}));assert.equal(home.billing[0].amount,3000);assert.equal(home.billing[0].children.length,1);assert.equal(JSON.stringify(home.billing).includes('99999'),false);
  rejected(h.family('familyHome',{}));
});
function ok(r) { assert.equal(r.ok, true, JSON.stringify(r)); return r; }
function rejected(r) { assert.ok(r.error, JSON.stringify(r)); return r; }
function create(h, studentIds = ['test-a', 'test-b'], label = '【テスト】兄弟保護者') {
  return ok(h.admin('familyCreate', { label, studentIds }));
}
function register(h, c = create(h), email = EMAIL) {
  return { ...c, registration: ok(h.family('familyRegister', { inviteCode: c.inviteCode, email, pass: PASS })) };
}
function verified(h, c, email = EMAIL) {
  const r = register(h, c, email);
  ok(h.family('familyVerify', { challenge: h.latestChallenge() }));
  return { ...r, ...ok(h.family('familyLogin', { email, pass: PASS })) };
}
function row(h, id) { return h.rows('familyAccounts').find(r => r.id === id); }
function secretLeaks(value) { return /passSalt|passHash|tokenHash|secretHash|securityVersion|inviteHash|fc1\.|fa1\./.test(JSON.stringify(value)); }

test('teacher creates siblings explicitly; secrets only invitation response and old parents unchanged', () => {
  const h = createFamilyHarness();
  ok(h.admin('state'));
  const before = h.rows('parents');
  const c = create(h);
  assert.match(c.inviteCode, /^fi1\.[a-f0-9]{32}\.[a-f0-9]{64}$/);
  assert.deepEqual(c.family.children.map(s => s.studentId), ['test-a', 'test-b']);
  const list = ok(h.admin('familyList'));
  assert.equal(secretLeaks(list), false);
  assert.equal(JSON.stringify(list).includes(c.inviteCode), false);
  assert.deepEqual(h.rows('parents'), before);
  assert.equal(h.mailbox.length, 0);
  assert.equal(list.students.length, 3);
});

test('teacher family operations deny parent, MCP and unauthenticated callers', () => {
  const h = createFamilyHarness();
  rejected(h.request({ action: 'admin', op: 'familyCreate', studentIds: ['test-a'], label: 'x' }));
  rejected(h.request({ action: 'admin', op: 'familyList', mcpKey: MCP_KEY }));
  rejected(h.family('familyCreate', { studentIds: ['test-a'], label: 'x' }));
  const v = verified(h);
  rejected(h.request({ action: 'admin', op: 'familyList', token: v.ftoken }));
});

test('inactive, duplicate and unknown children are rejected before family creation', () => {
  const h = createFamilyHarness();
  for (const studentIds of [[], ['test-inactive'], ['test-a', 'test-a'], ['missing']]) rejected(h.admin('familyCreate', { label: 'x', studentIds }));
  assert.equal(h.rows('familyAccounts').length, 0);
});

test('invitation has expiry, five-attempt invalidation and rotation', () => {
  const h = createFamilyHarness(); const c = create(h);
  const bad = c.inviteCode.slice(0, -1) + (c.inviteCode.endsWith('a') ? 'b' : 'a');
  for (let i = 0; i < 5; i++) rejected(h.family('familyRegister', { inviteCode: bad, email: EMAIL, pass: PASS }));
  rejected(h.family('familyRegister', { inviteCode: c.inviteCode, email: EMAIL, pass: PASS }));
  const next = ok(h.admin('familyInvite', { familyId: c.family.id }));
  assert.notEqual(next.inviteCode, c.inviteCode);
  h.advance(24 * 3600000 + 1);
  rejected(h.family('familyRegister', { inviteCode: next.inviteCode, email: EMAIL, pass: PASS }));
});

test('unverified accounts cannot login or access data; verified siblings share one login but data stays child-scoped', () => {
  const h = createFamilyHarness(); const r = register(h);
  assert.equal(r.registration.verificationRequired, true);
  assert.equal(r.registration.mailStatus, 'sent');
  rejected(h.family('familyLogin', { email: EMAIL, pass: PASS }));
  rejected(h.family('familyData', { studentId: 'test-a' }));
  const challenge = h.latestChallenge();
  ok(h.family('familyVerify', { challenge }));
  rejected(h.family('familyVerify', { challenge }));
  const login = ok(h.family('familyLogin', { email: ' Parent@Example.Invalid ', pass: PASS }));
  assert.deepEqual(login.children.map(s => s.studentId), ['test-a', 'test-b']);
  for (const child of login.children) {
    const d = ok(h.family('familyData', { ftoken: login.ftoken, studentId: child.studentId }));
    assert.equal(d.data.name, child.name);
    assert.equal(secretLeaks(d), false);
    assert.equal(JSON.stringify(d).includes('synthetic-link-'), false);
  }
  rejected(h.family('familyData', { ftoken: login.ftoken, studentId: 'test-inactive' }));
  rejected(h.family('familyData', { ftoken: login.ftoken, studentId: 'missing' }));
});

test('known email never joins another family, including unverified account and case variants', () => {
  const h = createFamilyHarness(); register(h, create(h, ['test-a']));
  const other = create(h, ['test-b'], '【テスト】別家族');
  rejected(h.family('familyRegister', { inviteCode: other.inviteCode, email: 'PARENT@example.invalid', pass: PASS }));
  assert.equal(row(h, other.family.id).passHash, '');
  assert.deepEqual(h.rows('familyLinks').filter(l => l.familyId === other.family.id).map(l => l.studentId), ['test-b']);
});

test('mail challenge stores hash only, no URL, password, token or raw mail exception in rows/logs', () => {
  const h = createFamilyHarness(); const r = register(h);
  const token = h.latestChallenge();
  const persisted = JSON.stringify(['familyAccounts', 'familyChallenges', 'familyOutbox', 'log'].map(n => h.rows(n)));
  assert.equal(persisted.includes(token), false);
  assert.equal(persisted.includes(r.inviteCode), false);
  assert.equal(persisted.includes(PASS), false);
  assert.equal(persisted.includes('fc1.'), false);
  assert.match(row(h, r.family.id).passHash, /^pbkdf2-sha256\$10\$/);
  assert.equal(secretLeaks(ok(h.admin('familyList'))), false);
});

test('unverified mail can be reissued with password; cooldown and old challenge invalidation', () => {
  const h = createFamilyHarness(); register(h); const first = h.latestChallenge();
  ok(h.family('familyResendVerification', { email: EMAIL, pass: PASS })); assert.equal(h.mailbox.length, 1);
  h.advance(61000);
  const unknown = h.family('familyResendVerification', { email: 'none@example.invalid', pass: PASS });
  const known = h.family('familyResendVerification', { email: EMAIL, pass: PASS });
  assert.deepEqual(known, unknown);assert.equal(h.mailbox.length, 2);
  rejected(h.family('familyVerify', { challenge: first }));
  ok(h.family('familyVerify', { challenge: h.latestChallenge() }));
});

test('password reset is generic, expires, one-use and revokes old sessions and password', () => {
  const h = createFamilyHarness(); const v = verified(h);
  assert.deepEqual(h.family('familyResetRequest', { email: 'unknown@example.invalid' }), h.family('familyResetRequest', { email: EMAIL }));
  const expired = h.latestChallenge('reset');h.advance(30 * 60000 + 1);
  rejected(h.family('familyResetConfirm', { challenge: expired, pass: PASS + 'new' }));
  ok(h.family('familyResetRequest', { email: EMAIL })); const challenge = h.latestChallenge('reset');
  ok(h.family('familyResetConfirm', { challenge, pass: PASS + 'new' }));
  rejected(h.family('familyResetConfirm', { challenge, pass: PASS + 'new' }));
  rejected(h.family('familyHome', { ftoken: v.ftoken }));
  rejected(h.family('familyLogin', { email: EMAIL, pass: PASS }));
  ok(h.family('familyLogin', { email: EMAIL, pass: PASS + 'new' }));
});

test('email change requires current password, verifies new address and revokes all earlier challenges and sessions', () => {
  const h = createFamilyHarness(); const v = verified(h);
  ok(h.family('familyResetRequest', { email: EMAIL })); const oldReset = h.latestChallenge('reset');
  rejected(h.family('familyEmailChange', { ftoken: v.ftoken, email: 'new@example.invalid', pass: 'Wrong password!' }));
  const result = ok(h.family('familyEmailChange', { ftoken: v.ftoken, email: 'new@example.invalid', pass: PASS }));
  assert.equal(result.mailStatus, 'sent');
  assert.equal(row(h, v.family.id).email, EMAIL);
  rejected(h.family('familyHome', { ftoken: v.ftoken }));
  rejected(h.family('familyResetConfirm', { challenge: oldReset, pass: PASS + 'bad' }));
  const verify = h.latestChallenge(); const oldLogin = ok(h.family('familyLogin', { email: EMAIL, pass: PASS }));
  ok(h.family('familyVerify', { challenge: verify }));
  rejected(h.family('familyHome', { ftoken: oldLogin.ftoken }));
  rejected(h.family('familyLogin', { email: EMAIL, pass: PASS }));
  ok(h.family('familyLogin', { email: 'new@example.invalid', pass: PASS }));
});

test('unlink and account disable revoke session; relinking never revives old tokens', () => {
  const h = createFamilyHarness();const v = verified(h);
  ok(h.admin('familySetChildren', { familyId: v.family.id, studentIds: ['test-a'] }));
  rejected(h.family('familyHome', { ftoken: v.ftoken }));
  const v2 = ok(h.family('familyLogin', { email: EMAIL, pass: PASS }));
  rejected(h.family('familyData', { ftoken: v2.ftoken, studentId: 'test-b' }));
  ok(h.admin('familySetActive', { familyId: v.family.id, active: false }));
  rejected(h.family('familyHome', { ftoken: v2.ftoken }));
  rejected(h.family('familyLogin', { email: EMAIL, pass: PASS }));
  ok(h.admin('familySetActive', { familyId: v.family.id, active: true }));
  rejected(h.family('familyHome', { ftoken: v2.ftoken }));
  ok(h.family('familyLogin', { email: EMAIL, pass: PASS }));
});

test('stopped student absent immediately, invalidation hook revokes session and pending challenges', () => {
  const h = createFamilyHarness();const v = verified(h);
  ok(h.family('familyResetRequest', { email: EMAIL }));const challenge = h.latestChallenge('reset');
  h.setRow('students', 'id', 'test-b', { active: false });
  rejected(h.family('familyData', { ftoken: v.ftoken, studentId: 'test-b' }));
  h.context().familyInvalidateStudent_('test-b');
  rejected(h.family('familyHome', { ftoken: v.ftoken }));
  rejected(h.family('familyResetConfirm', { challenge, pass: PASS + 'new' }));
});

test('empty family still authenticates but grants no child data', () => {
  const h = createFamilyHarness(); const v = verified(h);
  ok(h.admin('familySetChildren', { familyId: v.family.id, studentIds: [] }));
  const login = ok(h.family('familyLogin', { email: EMAIL, pass: PASS }));assert.deepEqual(login.children, []);
  rejected(h.family('familyData', { ftoken: login.ftoken, studentId: 'test-a' }));
});

test('shared parent logins coexist and device logout cannot terminate another session', () => {
  const h = createFamilyHarness(); const v = verified(h);
  for (let i = 0; i < 5; i++) rejected(h.family('familyLogin', { email: EMAIL, pass: PASS + 'bad' }));
  rejected(h.family('familyLogin', { email: EMAIL, pass: PASS }));h.advance(15 * 60000 + 1);
  const newer = ok(h.family('familyLogin', { email: EMAIL, pass: PASS }));
  ok(h.family('familyHome',{ftoken:v.ftoken}));
  ok(h.family('familyLogout', { ftoken: v.ftoken }));rejected(h.family('familyHome',{ftoken:v.ftoken}));ok(h.family('familyHome', { ftoken: newer.ftoken }));
  ok(h.family('familyLogout', { ftoken: newer.ftoken }));rejected(h.family('familyHome', { ftoken: newer.ftoken }));
});

test('child approval is scoped to linked child and preserves expected revision requirement', () => {
  const h = createFamilyHarness(); const v = verified(h, create(h, ['test-a']));
  for (const studentId of ['test-a', 'test-b']) {
    ok(h.admin('planSet', { studentId, ym: '2026-09', subject: '数学', count: 2 }));
    ok(h.admin('planPropose', { studentId, ym: '2026-09', rate30: 1500, monthly: 0 }));
  }
  rejected(h.family('familyPlanDecide', { ftoken: v.ftoken, studentId: 'test-b', ym: '2026-09', approve: true, expectedRevision: 2 }));
  rejected(h.family('familyPlanDecide', { ftoken: v.ftoken, studentId: 'test-a', ym: '2026-09', approve: true }));
  const data = ok(h.family('familyData', { ftoken: v.ftoken, studentId: 'test-a' })).data;
  const rev = data.planMonths.find(m => m.ym === '2026-09').revision;
  const result = ok(h.family('familyPlanDecide', { ftoken: v.ftoken, studentId: 'test-a', ym: '2026-09', approve: true, expectedRevision: rev }));
  assert.equal(result.data.planMonths.find(m => m.ym === '2026-09').status, 'approved');
  assert.equal(h.rows('monthAgreements').find(a => a.studentId === 'test-b').status, 'proposed');
});

test('notification event key is idempotent; quota zero is safely retryable; unknown send outcome never retries', () => {
  const h = createFamilyHarness(); const v = verified(h); h.mailbox.length = 0;
  const notify = key => h.context().familyNotifySafe_('invoiceCreated', 'test-a', key, { ym: '2026-09', revision: 2 });
  ok(notify('one')); ok(notify('one'));assert.equal(h.mailbox.length, 1);
  h.setQuota(0);ok(notify('two'));assert.equal(h.mailbox.length, 1);
  let out = h.rows('familyOutbox').find(r => r.eventKey === 'two');assert.equal(out.status, 'failed');
  h.setQuota(100);ok(h.admin('familyRetryNotifications', { ids: [out.id] }));assert.equal(h.mailbox.length, 2);
  h.setMailFailure(true, true);ok(notify('three'));assert.equal(h.mailbox.length, 3);
  out = h.rows('familyOutbox').find(r => r.eventKey === 'three');assert.equal(out.status, 'uncertain');
  h.setMailFailure(false);ok(notify('three'));rejected(h.admin('familyRetryNotifications', { ids: [out.id] }));assert.equal(h.mailbox.length, 3);
  const exposed = JSON.stringify(ok(h.admin('familyList')));assert.equal(exposed.includes('Synthetic send'), false);
  assert.equal(secretLeaks(JSON.parse(exposed)), false);
  assert.ok(v.family.id);
});

test('notification delivery rechecks current child link and verified recipient before retry', () => {
  const h = createFamilyHarness(); const v = verified(h); h.setQuota(0);
  ok(h.context().familyNotifySafe_('invoiceCreated', 'test-b', 'stale-child', { ym: '2026-09' }));
  const out = h.rows('familyOutbox').find(r => r.eventKey === 'stale-child');
  ok(h.admin('familySetChildren', { familyId: v.family.id, studentIds: ['test-a'] }));h.setQuota(100);
  const before = h.mailbox.length;ok(h.admin('familyRetryNotifications', { ids: [out.id] }));
  assert.equal(h.mailbox.length, before);assert.equal(h.rows('familyOutbox').find(r => r.id === out.id).status, 'cancelled');
});

test('test-family guard suppresses real send including authentication and business mail', () => {
  const h = createFamilyHarness();h.enableTestGuard();
  const r = register(h);assert.equal(r.registration.mailStatus, 'suppressed');assert.equal(h.mailbox.length, 0);
  assert.equal(h.rows('familyOutbox')[0].status, 'suppressed');
  const c = h.context();const a = c.familyAccount_(r.family.id);a.status='active';a.verifiedAt=new Date(h.now()).toISOString();c.familySave_(a);
  ok(h.context().familyNotifySafe_('invoiceCreated', 'test-a', 'test-only', { ym: '2026-09' }));assert.equal(h.mailbox.length, 0);
});

test('notification write or send failure never escapes to parent business operation', () => {
  const h = createFamilyHarness();verified(h);const c = h.context();
  c.familyOutboxAdd_ = () => { throw new Error('Synthetic Sheets outage'); };
  assert.equal(c.familyNotifySafe_('invoiceCreated', 'test-a', 'broken', { ym:'2026-09' }).ok, false);
  h.setMailFailure(true);assert.equal(h.context().familyNotifySafe_('invoiceCreated', 'test-a', 'send-broken', { ym:'2026-09' }).ok, true);
  const list = ok(h.admin('familyList'));assert.equal(list.notifications[0].status, 'uncertain');
  assert.equal(JSON.stringify(h.rows('familyOutbox')).includes('challenge='), false);
});

test('literal labels and email addresses cannot create spreadsheet formulas', () => {
  const h = createFamilyHarness();const c = create(h, ['test-a'], '=IMPORTXML("https://example.invalid")');
  register(h, c, '=notice@example.invalid');
  assert.equal(row(h, c.family.id).label, '=IMPORTXML("https://example.invalid")');
  assert.equal(row(h, c.family.id).email, '=notice@example.invalid');
});

function interruptWriteOnce(sheet, predicate, afterWrite = false) {
  const getRange = sheet.getRange;
  sheet.getRange = function(...args) {
    const range = getRange.apply(this, args), setValues = range.setValues;
    range.setValues = function(values) {
      if (!predicate(values)) return setValues.call(this, values);
      sheet.getRange = getRange;
      if (afterWrite) setValues.call(this, values);
      throw new Error('Synthetic interrupted family write');
    };
    return range;
  };
}

test('interrupted verification consumes proof safely and can recover by a newly issued email', () => {
  const h = createFamilyHarness();const r = register(h);const first = h.latestChallenge();
  const accounts = h.spreadsheet.getSheetByName('familyAccounts'), statusIndex = accounts.values[0].indexOf('status');
  interruptWriteOnce(accounts, values => values[0][statusIndex] === 'active');
  rejected(h.family('familyVerify', { challenge: first }));
  assert.equal(row(h, r.family.id).status, 'pending');
  rejected(h.family('familyVerify', { challenge: first }));
  rejected(h.family('familyLogin', { email: EMAIL, pass: PASS }));
  h.advance(61000);ok(h.family('familyResendVerification', { email: EMAIL, pass: PASS }));
  ok(h.family('familyVerify', { challenge: h.latestChallenge() }));ok(h.family('familyLogin', { email: EMAIL, pass: PASS }));
});

test('interrupted child relinking revokes session before adding any new child', () => {
  const h = createFamilyHarness();const v = verified(h, create(h, ['test-a']));
  const links = h.spreadsheet.getSheetByName('familyLinks'), childIndex = links.values[0].indexOf('studentId');
  interruptWriteOnce(links, values => values[0][childIndex] === 'test-b', true);
  rejected(h.admin('familySetChildren', { familyId: v.family.id, studentIds: ['test-a', 'test-b'] }));
  rejected(h.family('familyHome', { ftoken: v.ftoken }));
  rejected(h.family('familyData', { ftoken: v.ftoken, studentId: 'test-b' }));
  ok(h.admin('familySetChildren', { familyId: v.family.id, studentIds: ['test-a', 'test-b'] }));
  assert.equal(h.rows('familyLinks').length, 2);
});

test('lost sent receipt keeps uncertain record and cannot deliver duplicate mail', () => {
  const h = createFamilyHarness();verified(h);const before = h.mailbox.length;
  const sheet = h.spreadsheet.getSheetByName('familyOutbox'), statusIndex = sheet.values[0].indexOf('status');
  interruptWriteOnce(sheet, values => values[0][statusIndex] === 'sent');
  const first = h.context().familyNotifySafe_('invoiceCreated', 'test-a', 'lost-receipt', { ym:'2026-09' });
  assert.equal(first.ok, true);assert.equal(first.statuses[0], 'uncertain');
  assert.equal(h.rows('familyOutbox').find(o => o.eventKey === 'lost-receipt').status, 'uncertain');
  ok(h.context().familyNotifySafe_('invoiceCreated', 'test-a', 'lost-receipt', { ym:'2026-09' }));
  assert.equal(h.mailbox.length, before + 1);
});

test('auth mail quota failures allow a new challenge without exposing status on reset lookup', () => {
  const h = createFamilyHarness();h.setQuota(0);const r = register(h);
  assert.equal(r.registration.mailStatus, 'failed');assert.equal(h.mailbox.length, 0);
  h.advance(61000);h.setQuota(100);ok(h.family('familyResendVerification', { email: EMAIL, pass: PASS }));
  ok(h.family('familyVerify', { challenge: h.latestChallenge() }));
  const c = h.context();c.familyMailQuota_ = () => { throw new Error('Synthetic quota failure'); };
  const known = c.familyResetRequest_({ email: EMAIL }), unknown = c.familyResetRequest_({ email:'none@example.invalid' });
  assert.equal(JSON.stringify(known), JSON.stringify(unknown));
});

test('schema mismatch fails before adding any other family tables', () => {
  const h = createFamilyHarness();h.spreadsheet.insertSheet('familyChallenges').appendRow(['wrong']);
  assert.throws(() => h.context().ensureFamilySchema_(), /列構成/);
  assert.equal(h.spreadsheet.getSheetByName('familyAccounts'), null);
  assert.deepEqual(h.spreadsheet.getSheetByName('familyChallenges').values, [['wrong']]);
});

test('removing all children from a test-only account cannot enable real auth email delivery', () => {
  const h = createFamilyHarness();const v = verified(h);h.enableTestGuard();
  ok(h.admin('familySetChildren', { familyId: v.family.id, studentIds: [] }));
  const before = h.mailbox.length;ok(h.family('familyResetRequest', { email: EMAIL }));
  assert.equal(h.mailbox.length, before);
  assert.equal(h.rows('familyOutbox').at(-1).status, 'suppressed');
});

test('family upcoming lessons include only the selected child with public fields', () => {
  const h = createFamilyHarness();const v = verified(h);
  const slots = h.spreadsheet.getSheetByName('slots'), headers = slots.values[0];
  for (const [id, studentId, status] of [['family-upcoming-a', 'test-a', 'offered'], ['family-booked-a', 'test-a', 'booked'], ['family-upcoming-b', 'test-b', 'booked']]) {
    const slot = { id, studentId, status, date:'2026-09-15', start:'15:00', min:30, subject:'数学', deliveryMode:'online', done:false, eventId:'PRIVATE_CALENDAR_EVENT', req:'PRIVATE_INTERNAL_REQUEST', meetUrl: 'https://meet.example.invalid/' + studentId };
    slots.appendRow(headers.map(key => slot[key] ?? ''));
  }
  const a = ok(h.family('familyData', { ftoken: v.ftoken, studentId:'test-a' })).data;
  assert.deepEqual(a.upcoming.map(s => s.id).sort(), ['family-booked-a', 'family-upcoming-a']);
  assert.equal(JSON.stringify(a.upcoming).includes('test-b'), false);
  assert.equal(JSON.stringify(a.upcoming).includes('PRIVATE_'), false);
  assert.equal(a.upcoming.every(s => s.deliveryMode === 'online'), true);
  const b = ok(h.family('familyData', { ftoken: v.ftoken, studentId:'test-b' })).data;
  assert.deepEqual(b.upcoming.map(s => s.id), ['family-upcoming-b']);
  assert.equal(JSON.stringify(b.upcoming).includes('test-a'), false);
});

test('existing inactive child link may be retained but never newly linked or restored while inactive', () => {
  const h = createFamilyHarness();const v = verified(h);
  h.setRow('students', 'id', 'test-b', { active:false });
  ok(h.admin('familySetChildren', { familyId:v.family.id, studentIds:['test-a','test-b'] }));
  const login = ok(h.family('familyLogin', { email:EMAIL, pass:PASS }));
  assert.deepEqual(login.children.map(s => s.studentId), ['test-a']);
  rejected(h.family('familyData', { ftoken:login.ftoken, studentId:'test-b' }));
  rejected(h.admin('familySetChildren', { familyId:v.family.id, studentIds:['test-a','test-b','test-inactive'] }));
  ok(h.admin('familySetChildren', { familyId:v.family.id, studentIds:['test-a'] }));
  rejected(h.admin('familySetChildren', { familyId:v.family.id, studentIds:['test-a','test-b'] }));
});

test('notification failure preserves plan and invoice success while surfacing warning through teacher wrappers', () => {
  const h = createFamilyHarness();const v = verified(h);h.setQuota(0);
  ok(h.admin('planSet', { studentId:'test-a', ym:'2026-09', subject:'数学', count:2 }));
  const proposed = ok(h.admin('planPropose', { studentId:'test-a', ym:'2026-09', rate30:1500, monthly:0, from:'kanri' }));
  assert.match(proposed.notificationWarning, /保存は完了/);
  const revision = proposed.data.plan.months.find(m => m.ym === '2026-09').revision;
  ok(h.family('familyPlanDecide', { ftoken:v.ftoken, studentId:'test-a', ym:'2026-09', approve:true, expectedRevision:revision }));
  const sh=h.spreadsheet.getSheetByName('slots'),slot={id:'synthetic-warning-slot',studentId:'test-a',date:'2026-09-01',start:'10:00',min:60,status:'booked',done:true,subject:'数学'};sh.appendRow(sh.values[0].map(k=>slot[k]??''));
  const bill = ok(h.admin('kanriAddPayment', { studentId:'test-a', ym:'2026-09', requestId:'synthetic-family-warning', from:'kanri' }));
  assert.match(bill.notificationWarning, /メール通知/);assert.equal(bill.invoice.amount, 3000);
  const cancelled = ok(h.admin('kanriVoidInvoice', { studentId:'test-a', invoiceId:bill.invoice.id, reason:'架空の通知検証後の取消', from:'kanri' }));
  assert.match(cancelled.notificationWarning, /メール通知/);
  assert.equal(h.rows('入金管理', h.ledger)[0]['状態'], '取消');
  const notices = h.rows('familyOutbox').filter(o => ['planProposed','invoiceCreated','invoiceVoided'].includes(o.kind));
  assert.equal(notices.length, 3);assert.ok(notices.every(o => o.status === 'failed'));
});

test('pending parent can recover forgotten password by proving email ownership, and old verification is invalidated',()=>{
 const h=createFamilyHarness(),r=register(h);const old=h.latestChallenge();h.advance(61000);ok(h.family('familyResetRequest',{email:EMAIL}));const reset=h.latestChallenge('reset');ok(h.family('familyResetConfirm',{challenge:reset,pass:'Replacement password!'}));ok(h.family('familyLogin',{email:EMAIL,pass:'Replacement password!'}));rejected(h.family('familyVerify',{challenge:old}));rejected(h.family('familyResetConfirm',{challenge:reset,pass:'Another password!'}));
});

test('new student gets one automatic group and invitation reuses the existing group',()=>{
 const h=createFamilyHarness();const added=ok(h.admin('addStudent',{name:'【テスト】自動グループ'}));
 const list=ok(h.admin('familyList'));const group=list.families.find(f=>f.children.some(c=>c.studentId===added.id));assert.ok(group);
 const first=ok(h.admin('familyEnsureGroup',{studentId:added.id})),second=ok(h.admin('familyEnsureGroup',{studentId:added.id}));assert.equal(first.family.id,group.id);assert.equal(second.family.id,group.id);assert.equal(h.rows('familyAccounts').length,1);
});
test('moving siblings preserves target account, removes source access and retires empty source; retry is safe',()=>{
 const h=createFamilyHarness();const a=verified(h,create(h,['test-a'])),b=verified(h,create(h,['test-b']),'other@example.invalid');
 ok(h.admin('familyMoveStudent',{studentId:'test-a',familyId:b.family.id,sourceFamilyId:a.family.id}));
 rejected(h.family('familyHome',{ftoken:a.ftoken}));rejected(h.family('familyHome',{ftoken:b.ftoken}));
 const login=ok(h.family('familyLogin',{email:'other@example.invalid',pass:PASS}));assert.equal(login.children.length,2);assert.equal(h.rows('familyAccounts').find(x=>x.id===a.family.id).status,'disabled');
 ok(h.admin('familyMoveStudent',{studentId:'test-a',familyId:b.family.id,sourceFamilyId:a.family.id}));assert.equal(h.rows('familyLinks').filter(l=>l.studentId==='test-a'&&String(l.active)==='true').length,1);
 rejected(h.admin('familySetChildren',{familyId:a.family.id,studentIds:['test-a']}));
});
test('sessions expire independently and password reset revokes all devices',()=>{
 const h=createFamilyHarness(),a=verified(h);h.advance(60000);const b=ok(h.family('familyLogin',{email:EMAIL,pass:PASS}));h.advance(12*60*60000-60000);
 rejected(h.family('familyHome',{ftoken:a.ftoken}));ok(h.family('familyHome',{ftoken:b.ftoken}));
 ok(h.family('familyResetRequest',{email:EMAIL}));ok(h.family('familyResetConfirm',{challenge:h.latestChallenge('reset'),pass:'New synthetic password!'}));rejected(h.family('familyHome',{ftoken:b.ftoken}));
});

test('group move recovers after source detach without exposing the child to old sessions',()=>{
 const h=createFamilyHarness(),a=verified(h,create(h,['test-a'])),b=verified(h,create(h,['test-b']),'second@example.invalid');
 const sh=h.spreadsheet.getSheetByName('familyLinks'),get=sh.getRange;let failed=false;
 sh.getRange=function(...args){const range=get.apply(this,args),set=range.setValues;range.setValues=function(values){const result=set.call(this,values);if(!failed&&values[0]&&values[0][1]===a.family.id&&String(values[0][3])==='false'){failed=true;throw Error('Synthetic detached-write interruption');}return result;};return range;};
 const req={studentId:'test-a',familyId:b.family.id,sourceFamilyId:a.family.id};rejected(h.admin('familyMoveStudent',req));assert.equal(h.rows('familyLinks').filter(x=>x.studentId==='test-a'&&String(x.active)==='true').length,0);rejected(h.family('familyData',{ftoken:a.ftoken,studentId:'test-a'}));
 ok(h.admin('familyMoveStudent',req));assert.equal(h.rows('familyAccounts').find(x=>x.id===a.family.id).status,'disabled');assert.equal(h.rows('familyLinks').filter(x=>x.studentId==='test-a'&&String(x.active)==='true').length,1);
});
test('single-hash legacy session survives adding another device and is revoked individually',()=>{
 const h=createFamilyHarness(),v=verified(h),c=h.context(),a=c.familyAccount_(v.family.id);const sessions=JSON.parse(a.tokenHash);a.tokenHash=sessions[0].hash;c.familySave_(a);
 ok(h.family('familyHome',{ftoken:v.ftoken}));const b=ok(h.family('familyLogin',{email:EMAIL,pass:PASS}));ok(h.family('familyHome',{ftoken:v.ftoken}));ok(h.family('familyLogout',{ftoken:v.ftoken}));ok(h.family('familyHome',{ftoken:b.ftoken}));
});
