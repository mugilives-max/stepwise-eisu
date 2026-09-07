'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));

// A small DOM/storage boundary harness; all application handlers run unchanged.
function createUI(kind = 'student', options = {}) {
  const elements = new Map(), events = new Map(), requests = [], writes = [], logs = [], replaced = [];
  const local = options.local || new Map([['sw_k', 'test-link-a'], ['sw_admt', 'test-teacher-token']]);
  const session = options.session || new Map();
  const decode = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const attrs = tag => { const result = {}; for (const m of tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) result[m[1]] = decode(m[2] || ''); return result; };
  const on = (k, f) => { if (!events.has(k)) events.set(k, []); events.get(k).push(f); };
  const emit = (k, ev) => { for (const f of events.get(k) || []) f(ev); };
  function element(id, a = {}) {
    let html = ''; const children = new Set();
    const e = { id, attrs: a, value: a.value || '', textContent: '', checked: Object.hasOwn(a, 'checked'), disabled: Object.hasOwn(a, 'disabled'),
      getAttribute: k => Object.hasOwn(a, k) ? a[k] : null, hasAttribute: k => Object.hasOwn(a, k), focus() {}, scrollIntoView() {},
      classList: { add() {}, remove() {} }, addEventListener: (k, f) => on(id + ':' + k, f),
      clear() { for (const child of children) { elements.get(child)?.clear(); elements.delete(child); } children.clear(); } };
    Object.defineProperty(e, 'innerHTML', { get: () => html, set(value) {
      e.clear(); html = String(value);
      for (const m of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
        const child = element(m[3], attrs(m[2])), start = m.index + m[0].length;
        if (m[1] === 'textarea') child.value = decode(html.slice(start, html.indexOf('</textarea>', start)));
        if (m[1] === 'select') { const opts = [...html.slice(start, html.indexOf('</select>', start)).matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)], selected = opts.find(x => /\bselected\b/.test(x[1])) || opts[0]; if (selected) child.value = attrs(selected[1]).value ?? decode(selected[2]); }
        elements.set(child.id, child); children.add(child.id);
      }
    } }); return e;
  }
  ['app', 'nav', 'tabs', 'toast'].forEach(id => elements.set(id, element(id)));
  const storage = map => ({ getItem: k => map.get(k) ?? null, setItem(k, v) { writes.push([k, String(v)]); map.set(k, String(v)); }, removeItem: k => map.delete(k) });
  let requestId = 0, confirmCount = 0;
  const location = { hash: options.hash || (kind === 'admin' ? '#s=test-a' : '#home'), search: options.search || '', pathname: kind === 'admin' ? '/kanri/' : '/yoyaku/', href: 'https://example.invalid/' + (kind === 'admin' ? 'kanri/' : 'yoyaku/') };
  const context = { document: { getElementById: id => elements.get(id) || null, addEventListener: (k, f) => on('document:' + k, f), querySelector: () => null, querySelectorAll: () => [] },
    window: { scrollTo() {}, addEventListener: (k, f) => on('window:' + k, f), crypto: { randomUUID: () => 'test-request-' + (++requestId) } }, location,
    history: { replaceState(a, b, url) { replaced.push(url); const u = new URL(url, location.href); location.hash = u.hash; location.search = u.search; } },
    URL, URLSearchParams, navigator: { clipboard: { writeText: value => { ui.clipboard = value; return Promise.resolve(); } } },
    localStorage: storage(local), sessionStorage: storage(session), setTimeout: () => 0, clearTimeout() {}, confirm: () => { ++confirmCount; return true; }, console: { log: (...v) => logs.push(v) },
    fetch(url, config) { const body = config ? JSON.parse(config.body) : Object.fromEntries(new URL(url).searchParams); return new Promise((resolve, reject) => requests.push({ body, reply: value => resolve({ json: () => Promise.resolve(value) }), fail: () => reject(new Error('network failed')) })); } };
  const source = fs.readFileSync(path.join(__dirname, '..', kind === 'admin' ? 'kanri/index.html' : 'yoyaku/index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(source, context);
  const ui = { requests, local, session, writes, logs, replaced, location, el: id => elements.get(id), html: () => elements.get('app').innerHTML, confirms: () => confirmCount,
    input(id, value) { const el = elements.get(id); assert.ok(el, 'visible input: ' + id); el.value = value; emit('document:input', { target: el }); emit('app:input', { target: el }); },
    change(id, value) { const el = elements.get(id); assert.ok(el, 'visible input: ' + id); el.value = value; emit('document:change', { target: el }); emit('app:change', { target: el }); },
    check(attribute, id, checked) { const tag = [...ui.html().matchAll(/<input\b[^>]*>/g)].find(m => attrs(m[0])[attribute] === id); assert.ok(tag, 'visible checkbox: ' + id); const el = element('', attrs(tag[0])); el.checked = checked; if (el.disabled) return; emit('document:change', { target: el }); emit('app:change', { target: el }); },
    click(action, wanted = {}) { const tags = [...(ui.html() + elements.get('nav').innerHTML).matchAll(/<[^>]+\bdata-action="([^"]+)"[^>]*>/g)]; const tag = tags.find(m => m[1] === action && Object.keys(wanted).every(k => attrs(m[0])[k] === wanted[k])); assert.ok(tag, 'visible action: ' + action); const btn = element('', attrs(tag[0])); if (!btn.disabled) emit((kind === 'admin' ? 'document' : 'app') + ':click', { target: { closest: () => btn }, preventDefault() {} }); },
    submit(id) { assert.ok(elements.has(id), 'visible form: ' + id); emit('app:submit', { target: elements.get(id), preventDefault() {} }); },
    navigate(hash) { location.hash = hash; emit('window:hashchange', {}); },
    switchStudent(k) { const oldValue = local.get('sw_k'); local.set('sw_k', k); emit('window:storage', { key: 'sw_k', oldValue, newValue: k }); },
    beforeUnload() { let blocked = false; emit('window:beforeunload', { preventDefault() { blocked = true; } }); return blocked; }
  }; return ui;
}
function slot(id, overrides = {}) { return { id, date: '2026-09-10', start: id === 'slot-b' ? '18:00' : '17:00', min: 30, subject: '英語', deliveryMode: 'in_person', st: 'offer', ...overrides }; }
function state(slots = [slot('slot-a'), slot('slot-b', { deliveryMode: 'online' })], name = '【テスト】生徒A') { return { me: { name }, today: '2026-09-08', slots, history: [], tasks: [], blocked: [], teacherOff: [], wishes: [], events: [], plan: {} }; }
function card(overrides = {}) { return { id: 'test-a', name: '【テスト】生徒A', active: true, code: 'test-link-a', month: '2026-09', today: '2026-09-08', rate30: 1000, monthly: 0, deliveryMode: 'online', lessons: [], grades: [], exams: [], payments: [], meetings: [], tasks: [], profile: {}, thisMonth: {}, plan: { months: [] }, parentAuth: {}, ...overrides }; }
async function studentReady(s = state()) { const ui = createUI(); ui.requests[0].reply(s); await flush(); return ui; }
async function adminReady(c = card()) { const ui = createUI('admin'); ui.requests[0].reply({ data: c }); await flush(); return ui; }

test('batch selection confirms exact dates in the DOM before one POST and one state adoption', async () => {
  const ui = await studentReady(); ui.click('batchall'); ui.check('data-accept-id', 'slot-b', false); ui.click('batchreview');
  assert.equal(ui.requests.length, 1); assert.match(ui.html(), /次の1件を確定/); assert.equal(ui.confirms(), 0);
  ui.click('batchsend'); const r = ui.requests.at(-1); assert.deepEqual(r.body.slotIds, ['slot-a']); assert.equal(r.body.action, 'acceptMany');
  ui.click('batchsend'); assert.equal(ui.requests.length, 2);
  r.reply({ ok: true, pending: false, completed: 1, results: [{ slotId: 'slot-a', status: 'booked' }], state: state([slot('slot-a', { st: 'mine' }), slot('slot-b')]) }); await flush();
  assert.equal(ui.requests.length, 2, 'response state needs no per-slot refresh'); assert.equal(ui.beforeUnload(), false); assert.match(ui.html(), /確定済み/);
});

test('batch partial and network failures retain the identical request and show completed versus pending dates', async () => {
  const ui = await studentReady(); ui.click('batchall'); ui.click('batchreview'); ui.click('batchsend'); const first = ui.requests.at(-1), payload = structuredClone(first.body);
  first.reply({ ok: false, pending: true, completed: 1, results: [{ slotId: 'slot-a', status: 'booked' }, { slotId: 'slot-b', status: 'pending', error: '外部処理待ち' }], state: state([slot('slot-a', { st: 'mine' }), slot('slot-b')]) }); await flush();
  assert.match(ui.html(), /確定済み/); assert.match(ui.html(), /未完了/); assert.equal(ui.beforeUnload(), true);
  ui.click('batchsend'); assert.deepEqual(ui.requests.at(-1).body, payload); ui.requests.at(-1).fail(); await flush();
  ui.click('batchsend'); assert.deepEqual(ui.requests.at(-1).body, payload);
});

test('a late batch response cannot display the previous student after a dedicated-link switch', async () => {
  const ui = await studentReady(); ui.click('batchall'); ui.click('batchreview'); ui.click('batchsend'); const old = ui.requests.at(-1);
  ui.switchStudent('test-link-b'); ui.requests.at(-1).reply(state([], '【テスト】生徒B')); await flush();
  old.reply({ ok: true, pending: false, results: [], state: state([], '古いAの応答') }); await flush();
  assert.match(ui.html(), /生徒B/); assert.equal(ui.html().includes('古いAの応答'), false);
});

test('batch validation failure permits correction and uncertain mail never offers a notification resend', async () => {
  const ui = await studentReady(); ui.click('batchall'); ui.click('batchreview'); ui.click('batchsend');
  ui.requests.at(-1).reply({ error: '定員を確認してください', results: [{ slotId: 'slot-b', status: 'error' }] }); await flush();
  assert.equal(ui.beforeUnload(), false); ui.check('data-accept-id', 'slot-b', false); ui.click('batchreview'); ui.click('batchsend');
  assert.deepEqual(ui.requests.at(-1).body.slotIds, ['slot-a']);
  ui.requests.at(-1).reply({ ok: true, pending: false, notification: 'uncertain', warning: '通知の到達を確認してください', results: [], state: state([]) }); await flush();
  assert.match(ui.html(), /通知の到達を確認/); assert.equal(ui.html().includes('data-action="batchsend"'), false);
});

test('teacher offers inherit the student default, allow one-off mode, and retain all failed dates', async () => {
  const ui = await adminReady(); assert.equal(ui.el('f-delivery').value, 'online');
  ui.input('f-subject', '英語'); ui.input('f-delivery', 'in_person'); ui.input('f-date', '2026-09-10'); ui.input('f-start', '17:00'); ui.input('f-rep', '4'); ui.click('offerslot');
  const r = ui.requests.at(-1); assert.equal(r.body.deliveryMode, 'in_person'); assert.equal(r.body.repeat, 4);
  r.reply({ error: '定員超過のため案内できません', errorCode: 'capacity', conflicts: [{ date: '2026-09-17', start: '17:00', error: '対面定員' }, { date: '2026-10-01', start: '17:00', error: '全体定員' }] }); await flush();
  assert.match(ui.html(), /2026-09-17/); assert.match(ui.html(), /2026-10-01/); assert.equal(ui.el('f-delivery').value, 'in_person'); assert.equal(ui.el('f-rep').value, '4');
});

test('slot mode changes carry the old mode and target only that student and slot', async () => {
  const s = slot('slot-a', { status: 'booked', studentId: 'test-a', done: false }); const ui = await adminReady(card({ lessons: [s] }));
  ui.input('slot-mode-slot-a', 'online'); ui.click('slotmode', { 'data-id': 'slot-a' });
  const b = ui.requests.at(-1).body; assert.equal(b.op, 'setSlotDeliveryMode'); assert.equal(b.studentId, 'test-a'); assert.equal(b.slotId, 'slot-a'); assert.equal(b.expectedMode, 'in_person'); assert.equal(b.deliveryMode, 'online');
});

test('select all limits the batch to 31 and a single confirmation uses the same resumable API', async () => {
  const ui = await studentReady(state(Array.from({ length: 32 }, (_, i) => slot('slot-' + i))));
  ui.click('batchreview'); assert.equal(ui.requests.length, 1);
  ui.click('batchall'); ui.click('batchreview'); ui.click('batchsend'); assert.equal(ui.requests.at(-1).body.slotIds.length, 31);
  const single = await studentReady(); single.click('askaccept', { 'data-id': 'slot-a' }); single.click('doaccept');
  assert.equal(single.requests.at(-1).body.action, 'acceptMany'); assert.deepEqual(single.requests.at(-1).body.slotIds, ['slot-a']);
  single.requests.at(-1).fail(); await flush(); assert.match(single.html(), /同じ処理を再試行/);
});

test('changing a student default does not send slot fields and adopts a refreshed card with a visible notification warning', async () => {
  const original = slot('slot-a', { status: 'booked', studentId: 'test-a' }); const ui = await adminReady(card({ lessons: [original] }));
  ui.change('student-delivery', 'in_person'); ui.click('studentmode');
  const b = ui.requests.at(-1).body; assert.equal(b.op, 'setDeliveryMode'); assert.equal(b.deliveryMode, 'in_person'); assert.equal(b.slotId, undefined);
  ui.requests.at(-1).reply({ ok: true, data: card({ deliveryMode: 'in_person', lessons: [original] }), notificationWarning: '保存は完了しましたが通知を確認してください' }); await flush();
  assert.equal(ui.el('student-delivery').value, 'in_person'); assert.equal(ui.el('slot-mode-slot-a').value, 'in_person'); assert.match(ui.html(), /role="alert".*通知を確認/);
});

test('unfinished batch payload survives reload and lock-timeout responses without changing request ID', async () => {
  const ui = await studentReady(); ui.click('batchall'); ui.click('batchreview'); ui.click('batchsend'); const payload = structuredClone(ui.requests.at(-1).body);
  ui.requests.at(-1).reply({ error: '他の処理を確認中です', errorCode: 'pending' }); await flush();
  assert.equal(ui.beforeUnload(), true); assert.ok(ui.session.has('sw_accept_v1:test-link-a'));
  const reloaded = createUI('student', { session: ui.session }); reloaded.requests[0].reply(state()); await flush();
  assert.match(reloaded.html(), /前回の確定処理/); reloaded.click('batchsend'); assert.deepEqual(reloaded.requests.at(-1).body, payload);
  reloaded.requests.at(-1).reply({ ok: true, pending: false, results: [], state: state([]) }); await flush();
  assert.equal(reloaded.session.has('sw_accept_v1:test-link-a'), false);
});

test('server pending recovery overrides stale local state and shows snapshots even when no offers remain', async () => {
  const session = new Map([['sw_accept_v1:test-link-a', JSON.stringify({ requestId: 'stale-request', slotIds: ['stale-slot'], slots: [slot('stale-slot')] })]]);
  const ui = createUI('student', { session }); const slots = [slot('slot-a'), slot('slot-b')];
  ui.requests[0].reply({ ...state(slots.map(s => ({ ...s, st: 'mine' }))), pendingAccepts: [{ requestId: 'server-pending-request', slotIds: ['slot-a', 'slot-b'], slots }] }); await flush();
  assert.match(ui.html(), /次の2件を確定/); assert.match(ui.html(), /17:00/); assert.match(ui.html(), /18:00/); assert.match(ui.html(), /未完了の確定処理/);
  ui.click('batchsend'); assert.equal(ui.requests.at(-1).body.requestId, 'server-pending-request'); assert.deepEqual(ui.requests.at(-1).body.slotIds, ['slot-a', 'slot-b']);
});
