'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createHarness, TEACHER_TOKEN, TEACHER_PASSWORD, MCP_KEY } = require('./gas-harness.cjs');

const PASSWORD = 'Parent test password!';
const REPLACEMENT = 'A different parent password!';
const HOUR = 3600000;
const FAST_ITERATIONS = 10;
const safeStatusKeys = ['configured', 'lastLogin', 'setAt', 'setupExpiresAt'];
const fixture = () => createHarness({ iterations: FAST_ITERATIONS });
function ok(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
function rejected(result) { assert.ok(result.error, JSON.stringify(result)); assert.notEqual(result.ok, true); return result; }
function authRejected(result) { rejected(result); assert.equal(result.parentAuthRequired, true); }
function issue(h, studentId = 'test-a') { return ok(h.admin('parentIssueSetupCode', { studentId })); }
function setup(h, args = {}) {
  const r = issue(h, args.studentId || 'test-a');
  return ok(h.parent('parentSetup', { setupCode: r.setupCode, pass: PASSWORD, ...args }));
}
function noSecrets(value, secrets) {
  const json = JSON.stringify(value);
  for (const secret of secrets.filter(s => typeof s === 'string' && s.length > 0)) {
    assert.equal(json.includes(secret), false, 'Credential value leaked to response/log');
  }
  assert.equal(/"(?:passHash|passSalt|tokenHash|setupHash|ptoken|setupCode|parentToken)"/.test(json), false, 'Credential field leaked to response/log');
}

test('production PBKDF2-SHA256 agrees with Node at 600,000 rounds for ASCII and Japanese UTF-8', () => {
  const context = createHarness().context();
  assert.equal(context.PARENT_PASSWORD_ITERATIONS_, 600000);
  for (const [password, salt] of [['parent password example', '0123456789abcdef'], ['日本語の保護者パスワード🔐', '日本語ソルト-abc']]) {
    const expected = crypto.pbkdf2Sync(password, salt, 600000, 32, 'sha256').toString('hex');
    assert.equal(context.parentPasswordHash_(password, salt), 'pbkdf2-sha256$600000$' + expected);
  }
});

test('schema initializes idempotently without changing legacy students or unrelated data', () => {
  const h = fixture();
  const before = h.rows('students');
  authRejected(h.parent('parentData'));
  authRejected(h.parent('parentData'));
  // Scheduling appends an unknown deliveryMode; every pre-existing value must
  // remain identical and schema setup must not infer a family's lesson format.
  assert.deepEqual(h.rows('students'), before.map(row => ({ ...row, deliveryMode: '' })));
  assert.equal(h.spreadsheet.getSheetByName('students').values[0][9], 'deliveryMode');
  assert.deepEqual(h.spreadsheet.getSheetByName('parents').values[0], [
    'studentId', 'passSalt', 'passHash', 'setAt', 'lastLogin', 'failCount', 'lockUntil',
    'setupHash', 'setupExpiresAt', 'setupFailCount', 'tokenHash', 'tokenExpiresAt'
  ]);
  assert.equal(h.rows('parents').length, 0);
});

test('setup issuance requires teacher authorization and excludes parents and MCP', () => {
  const h = fixture();
  rejected(h.request({ action: 'admin', op: 'parentIssueSetupCode', studentId: 'test-a' }));
  rejected(h.request({ action: 'admin', op: 'parentIssueSetupCode', studentId: 'test-a', pass: TEACHER_PASSWORD }));
  rejected(h.request({ action: 'parentIssueSetupCode', studentId: 'test-a' }));
  rejected(h.request({ action: 'admin', op: 'parentIssueSetupCode', studentId: 'test-a', mcpKey: MCP_KEY }));
  const { ptoken } = setup(h);
  rejected(h.request({ action: 'admin', op: 'parentIssueSetupCode', studentId: 'test-a', token: ptoken }));
  rejected(h.request({ action: 'admin', op: 'state', token: ptoken }));
  rejected(h.request({ action: 'admin', op: 'kanriStudent', studentId: 'test-a', token: ptoken }));
});

test('legacy PIN or reset teacher account cannot issue setup codes even with an old teacher token', () => {
  const h = fixture();
  h.setRow('config', 'key', 'passHash', { value: '' });
  for (const credentials of [{ pin: '0000' }, { pin: '0000', token: TEACHER_TOKEN }, { token: TEACHER_TOKEN }]) {
    rejected(h.request({ action: 'admin', op: 'parentIssueSetupCode', studentId: 'test-a', ...credentials }));
  }
  assert.equal(h.rows('parents').length, 0);
});

test('issue returns a six-digit code once, hashed storage and safe status, with 24-hour expiry', () => {
  const h = fixture();
  const r = issue(h);
  assert.match(r.setupCode, /^\d{6}$/);
  assert.equal(r.expiresAt, h.now() + 24 * HOUR);
  assert.deepEqual(Object.keys(r.parentAuth).sort(), safeStatusKeys);
  assert.equal(r.parentAuth.configured, false);
  assert.equal(r.parentAuth.setupExpiresAt, r.expiresAt);
  assert.match(h.parentRow().setupHash, /^[a-f0-9]{64}$/);
  assert.notEqual(h.parentRow().setupHash, r.setupCode);
  assert.equal(JSON.stringify(h.rows('parents')).includes(r.setupCode), false);
  noSecrets(h.rows('log'), [r.setupCode]);
  noSecrets(ok(h.admin('kanriStudent', { studentId: 'test-a' })), [r.setupCode, h.parentRow().setupHash]);
});

test('teacher password has no parent fallback; setup is one-time and hashed at rest', () => {
  const h = fixture();
  rejected(h.parent('parentLogin', { pass: TEACHER_PASSWORD }));
  rejected(h.parent('parentSetup', { setupCode: '000000', pass: PASSWORD }));
  const r = issue(h);
  const login = ok(h.parent('parentSetup', { setupCode: r.setupCode, pass: PASSWORD }));
  const row = h.parentRow();
  assert.match(row.passSalt, /^[a-f0-9]{64}$/);
  assert.match(row.passHash, /^pbkdf2-sha256\$10\$[a-f0-9]{64}$/);
  assert.equal(row.setupHash, '');
  assert.equal(row.setupExpiresAt, '');
  assert.ok(row.setAt);
  assert.ok(row.lastLogin);
  assert.equal(JSON.stringify(row).includes(PASSWORD), false);
  assert.equal(row.tokenExpiresAt, String(h.now() + 12 * HOUR));
  assert.match(row.tokenHash, /^[a-f0-9]{64}$/);
  assert.notEqual(row.tokenHash, login.ptoken);
  rejected(h.parent('parentSetup', { setupCode: r.setupCode, pass: REPLACEMENT }));
  rejected(h.parent('parentLogin', { pass: TEACHER_PASSWORD }));
  ok(h.parent('parentData', { ptoken: login.ptoken }));
  noSecrets(h.rows('log'), [PASSWORD, r.setupCode, login.ptoken, row.passHash, row.passSalt, row.tokenHash]);
});

test('setup code expiry boundary, failed attempts, replacement and full-width digits', () => {
  const h = fixture();
  let r = issue(h);
  h.advance(24 * HOUR);
  rejected(h.parent('parentSetup', { setupCode: r.setupCode, pass: PASSWORD }));
  r = issue(h);
  const wrong = r.setupCode === '000000' ? '999999' : '000000';
  for (let i = 0; i < 5; i++) rejected(h.parent('parentSetup', { setupCode: wrong, pass: PASSWORD }));
  assert.equal(h.parentRow().setupHash, '');
  rejected(h.parent('parentSetup', { setupCode: r.setupCode, pass: PASSWORD }));
  const replacement = issue(h);
  assert.equal(h.parentRow().setupFailCount, '0');
  // Code generation is random: issuance can in principle produce the same six
  // digits, so explicitly ensure the old value differs before testing rejection.
  if (replacement.setupCode !== r.setupCode) rejected(h.parent('parentSetup', { setupCode: r.setupCode, pass: PASSWORD }));
  const fullWidth = replacement.setupCode.replace(/\d/g, n => String.fromCharCode(n.charCodeAt(0) + 0xFEE0));
  ok(h.parent('parentSetup', { setupCode: fullWidth, pass: PASSWORD }));
});

test('issuing another pending setup code invalidates the previous code and binds it to its student', () => {
  const h = fixture();
  const first = issue(h);
  let second = issue(h);
  while (second.setupCode === first.setupCode) second = issue(h);
  rejected(h.parent('parentSetup', { setupCode: first.setupCode, pass: PASSWORD }));
  rejected(h.parent('parentSetup', { k: 'synthetic-link-b', setupCode: second.setupCode, pass: PASSWORD }));
  assert.equal(h.parentRow('test-b'), undefined);
  ok(h.parent('parentSetup', { setupCode: second.setupCode, pass: PASSWORD }));
});

test('password bounds reject 11 and 129 characters without consuming a valid setup code', () => {
  const h = fixture();
  const r = issue(h);
  for (const pass of ['', 'a'.repeat(11), 'a'.repeat(129)]) {
    rejected(h.parent('parentSetup', { setupCode: r.setupCode, pass }));
    assert.ok(h.parentRow().setupHash);
    assert.equal(h.parentRow().passHash, '');
    assert.equal(h.parentRow().setupFailCount, '0');
  }
  ok(h.parent('parentSetup', { setupCode: r.setupCode, pass: 'あ'.repeat(12) }));
  ok(h.parent('parentLogin', { pass: 'あ'.repeat(12) }));
  const rr = issue(h);
  ok(h.parent('parentSetup', { setupCode: rr.setupCode, pass: 'a'.repeat(128) }));
  ok(h.parent('parentLogin', { pass: 'a'.repeat(128) }));
});

test('fifth failed login locks for 15 minutes; elapsed lock resets the failure budget', () => {
  const h = fixture();
  setup(h);
  for (let i = 1; i <= 5; i++) {
    rejected(h.parent('parentLogin', { pass: 'Wrong parent password!' }));
    assert.equal(Number(h.parentRow().failCount), i);
  }
  assert.equal(Number(h.parentRow().lockUntil), h.now() + 15 * 60000);
  rejected(h.parent('parentLogin', { pass: PASSWORD }));
  h.advance(15 * 60000 - 1);
  rejected(h.parent('parentLogin', { pass: PASSWORD }));
  h.advance(1);
  rejected(h.parent('parentLogin', { pass: 'Wrong parent password!' }));
  assert.equal(Number(h.parentRow().failCount), 1);
  assert.equal(Number(h.parentRow().lockUntil), 0);
  const r = ok(h.parent('parentLogin', { pass: PASSWORD }));
  assert.equal(Number(h.parentRow().failCount), 0);
  assert.equal(Number(h.parentRow().lockUntil), 0);
  ok(h.parent('parentData', { ptoken: r.ptoken }));
});

test('short and oversized login inputs count toward lockout and do not derive expensive hashes', () => {
  const h = fixture();
  setup(h);
  const c = h.context();
  // This sentinel only checks a denial path: a malformed password must be
  // rejected before any KDF. Successful paths all execute the real KDF.
  c.parentPasswordHash_ = () => { throw new Error('KDF should not run for invalid length'); };
  for (const pass of ['', 'short', 'a'.repeat(129), 'a'.repeat(100000), 'x']) {
    const r = JSON.parse(c.doPost({ postData: { contents: JSON.stringify({ action: 'parentLogin', k: 'synthetic-link-a', pass }) } }).getContent());
    rejected(r);
    assert.equal(r.error.includes('KDF should not run'), false);
    c.memoClear_();
  }
  assert.equal(Number(h.parentRow().failCount), 5);
  assert.equal(Number(h.parentRow().lockUntil), h.now() + 15 * 60000);
});

test('sessions are student-bound, reject legacy/teacher tokens and expire at 12 hours', () => {
  const h = fixture();
  const { ptoken } = setup(h);
  for (const token of ['', 'forged-token', 'legacy-parent-token-a', TEACHER_TOKEN]) {
    authRejected(h.parent('parentData', { ptoken: token }));
    authRejected(h.parent('parentPlanDecide', { ptoken: token, ym: '2026-09', approve: true }));
  }
  authRejected(h.parent('parentData', { k: 'synthetic-link-b', ptoken }));
  authRejected(h.parent('parentPlanDecide', { k: 'synthetic-link-b', ptoken, ym: '2026-09', approve: true }));
  h.advance(12 * HOUR - 1);
  ok(h.parent('parentData', { ptoken }));
  h.advance(1);
  authRejected(h.parent('parentData', { ptoken }));
  authRejected(h.parent('parentPlanDecide', { ptoken, ym: '2026-09', approve: true }));
});

test('a later login replaces the session and stale/foreign logout cannot revoke it', () => {
  const h = fixture();
  const first = setup(h).ptoken;
  const second = ok(h.parent('parentLogin', { pass: PASSWORD })).ptoken;
  assert.notEqual(first, second);
  authRejected(h.parent('parentData', { ptoken: first }));
  ok(h.parent('parentLogout', { ptoken: first }));
  ok(h.parent('parentLogout', { k: 'synthetic-link-b', ptoken: second }));
  ok(h.parent('parentData', { ptoken: second }));
  ok(h.parent('parentLogout', { ptoken: second }));
  assert.equal(h.parentRow().tokenHash, '');
  authRejected(h.parent('parentData', { ptoken: second }));
  ok(h.parent('parentLogout', { ptoken: second }));
});

test('password reset immediately revokes sessions, keeps old password until setup, then replaces it', () => {
  const h = fixture();
  const first = setup(h).ptoken;
  const oldHash = h.parentRow().passHash;
  const code = issue(h).setupCode;
  authRejected(h.parent('parentData', { ptoken: first }));
  assert.equal(h.parentRow().passHash, oldHash);
  const oldLogin = ok(h.parent('parentLogin', { pass: PASSWORD })).ptoken;
  const replaced = ok(h.parent('parentSetup', { setupCode: code, pass: REPLACEMENT }));
  authRejected(h.parent('parentData', { ptoken: oldLogin }));
  assert.notEqual(h.parentRow().passHash, oldHash);
  rejected(h.parent('parentLogin', { pass: PASSWORD }));
  ok(h.parent('parentData', { ptoken: replaced.ptoken }));
  ok(h.parent('parentLogin', { pass: REPLACEMENT }));
});

test('failed or expired reset delivery does not disable the existing password', () => {
  const h = fixture();
  setup(h);
  const reset = issue(h);
  const wrong = reset.setupCode === '111111' ? '222222' : '111111';
  for (let i = 0; i < 5; i++) rejected(h.parent('parentSetup', { setupCode: wrong, pass: REPLACEMENT }));
  ok(h.parent('parentLogin', { pass: PASSWORD }));
  const next = issue(h);
  h.advance(24 * HOUR);
  rejected(h.parent('parentSetup', { setupCode: next.setupCode, pass: REPLACEMENT }));
  ok(h.parent('parentLogin', { pass: PASSWORD }));
});

test('successful reset clears login lock and failure counters', () => {
  const h = fixture();
  setup(h);
  for (let i = 0; i < 5; i++) rejected(h.parent('parentLogin', { pass: 'wrong password!' }));
  const reset = issue(h);
  ok(h.parent('parentSetup', { setupCode: reset.setupCode, pass: REPLACEMENT }));
  assert.equal(Number(h.parentRow().lockUntil), 0);
  assert.equal(Number(h.parentRow().failCount), 0);
  ok(h.parent('parentLogin', { pass: REPLACEMENT }));
});

test('regenerating the student link invalidates existing session and pending setup', () => {
  const h = fixture();
  setup(h);
  const reset = issue(h);
  const current = ok(h.parent('parentLogin', { pass: PASSWORD })).ptoken;
  ok(h.admin('newCode', { studentId: 'test-a' }));
  const newLink = h.studentRow().code;
  assert.notEqual(newLink, 'synthetic-link-a');
  assert.equal(h.parentRow().tokenHash, '');
  assert.equal(h.parentRow().setupHash, '');
  authRejected(h.parent('parentData', { ptoken: current }));
  authRejected(h.parent('parentData', { k: newLink, ptoken: current }));
  rejected(h.parent('parentSetup', { k: newLink, setupCode: reset.setupCode, pass: REPLACEMENT }));
  ok(h.parent('parentLogin', { k: newLink, pass: PASSWORD }));
});

test('inactive students cannot issue, setup, login, read, or approve; reactivation retains password only', () => {
  const h = fixture();
  rejected(h.admin('parentIssueSetupCode', { studentId: 'test-inactive' }));
  rejected(h.parent('parentLogin', { k: 'synthetic-link-inactive', pass: PASSWORD }));
  rejected(h.parent('parentSetup', { k: 'synthetic-link-inactive', setupCode: '123456', pass: PASSWORD }));
  setup(h);
  const pending = issue(h);
  const current = ok(h.parent('parentLogin', { pass: PASSWORD })).ptoken;
  ok(h.admin('kanriSetActive', { studentId: 'test-a', active: false }));
  assert.equal(h.parentRow().tokenHash, '');
  assert.equal(h.parentRow().setupHash, '');
  rejected(h.parent('parentLogin', { pass: PASSWORD }));
  rejected(h.parent('parentSetup', { setupCode: pending.setupCode, pass: REPLACEMENT }));
  authRejected(h.parent('parentData', { ptoken: current }));
  authRejected(h.parent('parentPlanDecide', { ptoken: current, ym: '2026-09', approve: true }));
  ok(h.admin('kanriSetActive', { studentId: 'test-a', active: true }));
  authRejected(h.parent('parentData', { ptoken: current }));
  ok(h.parent('parentLogin', { pass: PASSWORD }));
});

test('authenticated monthly approval changes only own plan and does not send test notifications', () => {
  const h = fixture();
  const { ptoken } = setup(h);
  const sh = h.spreadsheet.getSheetByName('plans');
  sh.appendRow(['plan-a', 'test-a', '2026-09', '数学', 4, 'proposed', '', '', '', '']);
  sh.appendRow(['plan-b', 'test-b', '2026-09', '英語', 2, 'proposed', '', '', '', '']);
  ok(h.admin('planPropose', {studentId:'test-a',ym:'2026-09',rate30:1500,monthly:0}));
  const revision=h.rows('monthAgreements')[0].revision;
  const before = h.rows('plans');
  authRejected(h.parent('parentPlanDecide', { ym: '2026-09', approve: true }));
  assert.deepEqual(h.rows('plans'), before);
  ok(h.parent('parentPlanDecide', { ptoken, ym: '2026-09', approve: true, expectedRevision:revision }));
  assert.equal(h.rows('plans')[0].status, 'approved');
  assert.equal(h.rows('plans')[1].status, 'proposed');
  assert.ok(h.rows('plans')[0].approvedAt);
  assert.equal(h.effects.some(e => e.kind === 'email' || e.kind === 'calendar'), false);
});

test('student, admin and MCP outputs and audit logs exclude parent credentials', () => {
  const h = fixture();
  const { ptoken } = setup(h);
  const pending = issue(h);
  const active = ok(h.parent('parentLogin', { pass: PASSWORD }));
  const row = h.parentRow();
  const secrets = [PASSWORD, ptoken, active.ptoken, pending.setupCode, row.passSalt, row.passHash, row.setupHash, row.tokenHash, 'legacy-parent-token-a'];
  const student = h.get({ action: 'state', k: 'synthetic-link-a' });
  assert.equal(student.me.name, '【テスト】保護者認証A');
  const teacher = ok(h.admin('kanriStudent', { studentId: 'test-a' }));
  assert.deepEqual(Object.keys(teacher.data.parentAuth).sort(), safeStatusKeys);
  assert.equal(teacher.data.parentAuth.configured, true);
  assert.ok(teacher.data.parentAuth.lastLogin);
  const outputs = [student, teacher, ok(h.admin('state')), ok(h.parent('parentData', { ptoken: active.ptoken }))];
  for (const op of ['mcpStudents', 'mcpStudent', 'mcpPending', 'mcpBilling', 'mcpSchedule']) {
    outputs.push(ok(h.request({ action: 'admin', op, studentId: 'test-a', mcpKey: MCP_KEY,
      ptoken: active.ptoken, setupCode: pending.setupCode, pass: PASSWORD, passHash: row.passHash, passSalt: row.passSalt,
      metadata: { pass: PASSWORD, token: active.ptoken } })));
  }
  noSecrets(outputs, secrets);
  noSecrets(h.rows('log'), secrets);
  noSecrets(h.rows('mcpLog'), secrets);
  noSecrets(h.effects, secrets);
});

test('parent data excludes teacher-only grade and payment notes and ledger row numbers', () => {
  const h = fixture();
  const { ptoken } = setup(h);
  const c = h.context();
  h.ledger.insertSheet('成績推移').appendRow(c.LEDGER_COLS['成績推移']).appendRow(['2026-09-01', 'test-a', '【テスト】保護者認証A', 'テスト', '数学', 80, 100, '', '', 'teacher-private-grade-note']);
  h.ledger.getSheetByName('入金管理').appendRow(['2026-09', 'test-a', '【テスト】保護者認証A', 6000, '', '', '', '未入金', 'teacher-private-payment-note']);
  const parent = ok(h.parent('parentData', { ptoken })).data;
  assert.equal(parent.grades[0].score, 80);
  assert.equal(parent.payments[0].amount, 6000);
  for (const item of [...parent.grades, ...parent.payments]) {
    assert.equal(Object.hasOwn(item, 'note'), false);
    assert.equal(Object.hasOwn(item, 'row'), false);
  }
  assert.equal(JSON.stringify(parent).includes('teacher-private'), false);
});

test('schema mismatch and duplicate parent rows fail closed without overwriting data', () => {
  const h = fixture();
  issue(h);
  const sheet = h.spreadsheet.getSheetByName('parents');
  sheet.values[0][1] = 'unexpectedColumn';
  h.advance(24 * HOUR);
  const before = JSON.stringify(sheet.values);
  rejected(h.parent('parentLogin', { pass: PASSWORD }));
  assert.equal(JSON.stringify(sheet.values), before);
  const clean = fixture();
  const { ptoken } = setup(clean);
  const cleanSheet = clean.spreadsheet.getSheetByName('parents');
  cleanSheet.appendRow(cleanSheet.values[1]);
  const duplicateBefore = JSON.stringify(cleanSheet.values);
  rejected(clean.parent('parentLogin', { pass: PASSWORD }));
  rejected(clean.parent('parentData', { ptoken }));
  rejected(clean.admin('parentIssueSetupCode', { studentId: 'test-a' }));
  assert.equal(JSON.stringify(cleanSheet.values), duplicateBefore);
});
