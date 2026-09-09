'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const flush = () => new Promise(resolve => setImmediate(resolve));
const sessionKey = child => 'sw_pt_v2:' + child;
const studentState = child => ({ me: { id: child, name: '【テスト】' + child } });
const parentData = child => ({ name: '【テスト保護者】' + child, month: '2026-09', planMonths: [
  { ym: '2026-10', status: 'proposed', revision: 1, termsKnown: true, rate30: 1500, monthly: 0,
    rows: [{ subject: '数学', count: 4 }], total: 4 }
] });
const studentCard = () => ({ id: 'test-id', name: '【テスト】カルテ', active: true,
  code: 'synthetic-link', lessons: [], grades: [], payments: [], meetings: [], month: '2026-09',
  thisMonth: { count: 0, minutes: 0, fee: 0 },
  parentAuth: { configured: false, setAt: '', lastLogin: '', setupExpiresAt: 0 } });

// Execute each complete production script unchanged. This DOM stub only tracks ids,
// input values, redraws and delegated events; responses remain explicitly controlled.
function createUI(kind = 'parent', shared = {}) {
  const elements = new Map(), events = new Map(), requests = [];
  const local = shared.local || new Map([['sw_k', 'child-a'], ['sw_admt', 'synthetic-teacher-token']]);
  const session = shared.session || new Map();
  let sessionUnavailable = false;
  function element(id) {
    const children = new Set();
    let html = '';
    const e = { id, value: '', textContent: '', focus() {}, scrollIntoView() {},
      classList: { add() {}, remove() {} },
      addEventListener: (name, handler) => events.set(id + ':' + name, handler),
      removeChildren() {
        for (const child of children) {
          if (elements.has(child)) elements.get(child).removeChildren();
          elements.delete(child);
        }
        children.clear();
      }
    };
    Object.defineProperty(e, 'innerHTML', {
      get: () => html,
      set(value) {
        e.removeChildren(); html = String(value);
        for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
          const child = element(match[1]);
          child.value = (match[0].match(/\bvalue="([^"]*)"/) || [])[1] || '';
          elements.set(child.id, child); children.add(child.id);
        }
      }
    });
    return e;
  }
  for (const id of ['app', 'nav', 'tabs', 'toast']) elements.set(id, element(id));
  const storage = (map, isSession) => ({
    getItem: key => map.get(key) ?? null,
    setItem(key, value) { if (isSession && sessionUnavailable) throw Error('storage unavailable'); map.set(key, String(value)); },
    removeItem: key => map.delete(key)
  });
  const context = {
    document: { getElementById: id => elements.get(id) || null,
      addEventListener: (name, handler) => events.set('document:' + name, handler) },
    window: { scrollTo() {}, addEventListener: (name, handler) => events.set('window:' + name, handler) },
    location: { hash: kind === 'admin' ? '#s=test-id&tab=settings' : '#parent/billing', search: '',
      pathname: kind === 'admin' ? '/kanri/' : '/yoyaku/', href: 'https://example.invalid/kanri/' },
    history: { replaceState() {} }, URL, URLSearchParams, navigator: {},
    localStorage: storage(local, false), sessionStorage: storage(session, true),
    setTimeout: () => 0, clearTimeout() {}, confirm: () => true, console: { log() {} },
    fetch(url, options) {
      const body = options ? JSON.parse(options.body) : Object.fromEntries(new URL(url).searchParams);
      return new Promise((resolve, reject) => requests.push({ body,
        reply: value => resolve({ json: () => Promise.resolve(value) }), fail: () => reject(Error('network failed')) }));
    }
  };
  const file = kind === 'admin' ? 'kanri/index.html' : 'yoyaku/index.html';
  const script = kind === 'admin' ? fs.readFileSync(path.resolve(__dirname,'..',file),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1] : fs.readFileSync(path.resolve(__dirname,'../assets/portal.js'),'utf8');
  context.window.StepwiseBoard=require('../assets/schedule-board.js');
  context.window.StepwiseReport=require('../assets/lesson-report.js');
  vm.runInNewContext(script, context, { filename: file });
  const ui = { local, session, requests,
    el: id => elements.get(id), html: () => elements.get('app').innerHTML,
    async ready() {
      requests[0].reply(kind === 'admin' ? { data: studentCard() } : studentState(local.get('sw_k')));
      await flush(); return ui;
    },
    click(action, attrs = {}) {
      assert.ok(ui.html().includes('data-action="' + action + '"'), 'action is visible: ' + action);
      const btn = { disabled: false, getAttribute: key => key === 'data-action' ? action : attrs[key] || null };
      events.get((kind === 'admin' ? 'document' : 'app') + ':click')({ target: { closest: () => btn }, preventDefault() {} });
    },
    submit() {
      const form = ui.el('parent-auth-form'); assert.ok(form, 'auth form is visible');
      events.get('app:submit')({ target: form, preventDefault() {} });
    },
    switchStudent(child) {
      const oldValue = local.get('sw_k'); local.set('sw_k', child);
      events.get('window:storage')({ key: 'sw_k', oldValue, newValue: child });
    },
    disableSession() { sessionUnavailable = true; }
  };
  return ui;
}

async function parentWithSession() {
  const session = new Map([[sessionKey('child-a'), 'synthetic-parent-a']]);
  const ui = await createUI('parent', { session }).ready();
  ui.click('parentresume'); ui.requests.at(-1).reply({ data: parentData('child-a') });
  await flush(); return ui;
}

test('parent setup rejects mismatch, preserves password whitespace and code zeroes, and clears inputs before sending', async () => {
  const ui = await createUI().ready();
  ui.click('parentmode');
  assert.match(ui.html(), /autocomplete="new-password"/);
  const pass = ui.el('f-ppass'), confirmation = ui.el('f-ppass2');
  pass.value = ' valid parent pass '; confirmation.value = 'mismatched parent pass';
  ui.el('f-pcode').value = '001234'; ui.submit();
  assert.equal(ui.requests.length, 1, 'mismatch must not reach API');
  confirmation.value = pass.value; ui.submit();
  assert.equal(ui.requests.at(-1).body.action, 'parentSetup');
  assert.equal(ui.requests.at(-1).body.pass, ' valid parent pass ');
  assert.equal(ui.requests.at(-1).body.setupCode, '001234');
  assert.equal(pass.value, ''); assert.equal(confirmation.value, '');
  ui.submit(); assert.equal(ui.requests.length, 2, 'busy form must not send twice');
  ui.requests.at(-1).reply({ error: '設定コードがちがいます' }); await flush();
});

test('parentData expiry clears scoped and legacy tokens and returns to login', async () => {
  const session = new Map([[sessionKey('child-a'), 'expired'], ['sw_pt', 'legacy']]);
  const ui = await createUI('parent', { session }).ready();
  assert.equal(session.has('sw_pt'), false, 'boot removes legacy token');
  ui.click('parentresume'); ui.requests.at(-1).reply({ error: '認証期限切れ', parentAuthRequired: true });
  await flush();
  assert.equal(session.has(sessionKey('child-a')), false);
  assert.match(ui.html(), /autocomplete="current-password"/);
  assert.match(ui.html(), /認証期限切れ/);
});

test('approval expiry removes displayed parent data and requires login', async () => {
  const ui = await parentWithSession();
  ui.click('planok', { 'data-ym': '2026-10' });
  ui.requests.at(-1).reply({ error: '承認時に期限切れ', parentAuthRequired: true }); await flush();
  assert.equal(ui.session.has(sessionKey('child-a')), false);
  assert.equal(ui.html().includes('【テスト保護者】child-a'), false);
  assert.match(ui.html(), /承認時に期限切れ/);
  assert.ok(ui.el('parent-auth-form'));
});

test('failed logout hides data and survives refresh until server-confirmed retry', async () => {
  const ui = await parentWithSession();
  ui.click('parentclose'); assert.equal(ui.html().includes('【テスト保護者】child-a'), false);
  ui.requests.at(-1).fail(); await flush();
  assert.match(ui.html(), /ログアウトが完了していません/);
  assert.equal(ui.session.get(sessionKey('child-a')), 'synthetic-parent-a');
  assert.equal(ui.session.get(sessionKey('child-a') + ':logout'), '1');
  const reloaded = await createUI('parent', ui).ready();
  assert.match(reloaded.html(), /ログアウトを再試行/);
  assert.equal(reloaded.html().includes('data-action="parentresume"'), false);
  reloaded.click('parentclose'); assert.equal(reloaded.requests.at(-1).body.action, 'parentLogout');
  reloaded.requests.at(-1).reply({ ok: true }); await flush();
  assert.equal(ui.session.has(sessionKey('child-a')), false);
  assert.equal(ui.session.has(sessionKey('child-a') + ':logout'), false);
  assert.ok(reloaded.el('parent-auth-form'));
});

for (const response of [{ data: parentData('stale') }, { error: 'stale expiry', parentAuthRequired: true }]) {
  test('student switching ignores pending approval ' + (response.error ? 'error' : 'success'), async () => {
    const ui = await parentWithSession();
    ui.click('planok', { 'data-ym': '2026-10' }); const approval = ui.requests.at(-1);
    ui.session.set(sessionKey('child-b'), 'synthetic-parent-b'); ui.switchStudent('child-b');
    assert.equal(ui.html().includes('【テスト保護者】child-a'), false);
    ui.requests.at(-1).reply(studentState('child-b')); await flush();
    ui.click('parentresume'); ui.requests.at(-1).reply({ data: parentData('child-b') }); await flush();
    approval.reply(response); await flush();
    assert.match(ui.html(), /【テスト保護者】child-b/);
    assert.equal(ui.session.get(sessionKey('child-b')), 'synthetic-parent-b');
    assert.equal(ui.html().includes('stale'), false);
  });
}

test('old-student logout completion cannot clear another student session or display', async () => {
  const ui = await parentWithSession(); ui.click('parentclose'); const logout = ui.requests.at(-1);
  ui.session.set(sessionKey('child-b'), 'synthetic-parent-b'); ui.switchStudent('child-b');
  ui.requests.at(-1).reply(studentState('child-b')); await flush();
  ui.click('parentresume'); ui.requests.at(-1).reply({ data: parentData('child-b') }); await flush();
  logout.reply({ ok: true }); await flush();
  assert.equal(ui.session.has(sessionKey('child-a')), false);
  assert.equal(ui.session.get(sessionKey('child-b')), 'synthetic-parent-b');
  assert.match(ui.html(), /【テスト保護者】child-b/);
});

test('unavailable session storage rejects login before issuing a server session', async () => {
  const ui = await createUI().ready(); ui.disableSession();
  ui.el('f-ppass').value = 'valid parent password'; ui.submit();
  assert.equal(ui.requests.length, 1);
  assert.match(ui.html(), /ログインを一時保存できません/);
});

test('admin issued code preserves zeroes, never enters cache, and disappears on redraw', async () => {
  const ui = await createUI('admin').ready(); ui.click('parentissue'); ui.click('parentissue');
  assert.equal(ui.requests.length, 2, 'busy prevents duplicate issuance');
  ui.requests.at(-1).reply({ ok: true, setupCode: '001234', expiresAt: Date.now() + 86400000,
    parentAuth: { configured: false, setAt: '', lastLogin: '', setupExpiresAt: Date.now() + 86400000 } });
  await flush();
  assert.match(ui.el('parent-setup-issued').innerHTML, /001234/);
  const cached = ui.local.get('sw_kanri_sections_v1'); assert.ok(cached);
  assert.equal(cached.includes('001234'), false); assert.equal(cached.includes('setupCode'), false);
  ui.click('parentissue'); // A new render must remove the previous code immediately.
  assert.equal(ui.el('parent-setup-issued').innerHTML, '');
  ui.requests.at(-1).reply({ error: '先生ログインの期限切れ', badAuth: true }); await flush();
  assert.equal(ui.local.has('sw_admt'), false);
  assert.equal(ui.el('parent-setup-issued'), undefined);
});
