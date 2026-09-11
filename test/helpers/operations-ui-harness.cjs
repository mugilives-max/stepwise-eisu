'use strict';
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
  ['app', 'nav', 'tabs', 'toast', 'parent-header-actions'].forEach(id => elements.set(id, element(id)));
  const storage = map => ({ getItem: k => map.get(k) ?? null, setItem(k, v) { writes.push([k, String(v)]); map.set(k, String(v)); }, removeItem: k => map.delete(k) });
  let requestId = 0, confirmCount = 0;
  const location = { hash: options.hash || (kind === 'admin' ? '#s=test-a' : '#home'), search: options.search || '', pathname: kind === 'admin' ? '/kanri/' : '/yoyaku/', href: 'https://example.invalid/' + (kind === 'admin' ? 'kanri/' : 'yoyaku/') };
  const context = { Date: options.now ? class extends Date { constructor(...args) { super(...(args.length ? args : [options.now])); } static now() { return new Date(options.now).getTime(); } } : Date, crypto: require('node:crypto').webcrypto, document: { getElementById: id => elements.get(id) || null, addEventListener: (k, f) => on('document:' + k, f), querySelector: () => null, querySelectorAll: () => [] },
    window: { scrollTo() {}, addEventListener: (k, f) => on('window:' + k, f), crypto: { randomUUID: () => 'test-request-' + (++requestId) } }, location,
    history: { replaceState(a, b, url) { replaced.push(url); const u = new URL(url, location.href); location.hash = u.hash; location.search = u.search; } },
    URL, URLSearchParams, navigator: { clipboard: { writeText: value => { ui.clipboard = value; return Promise.resolve(); } } },
    localStorage: storage(local), sessionStorage: storage(session), setTimeout: () => 0, clearTimeout() {}, confirm: () => { ++confirmCount; return true; }, console: { log: (...v) => logs.push(v) },
    fetch(url, config) { const body = config ? JSON.parse(config.body) : Object.fromEntries(new URL(url).searchParams); return new Promise((resolve, reject) => requests.push({ body, reply: value => resolve({ json: () => Promise.resolve(value) }), fail: () => reject(new Error('network failed')) })); } };
  const source = kind === 'admin' ? fs.readFileSync(path.join(__dirname,'../../kanri/index.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1] : fs.readFileSync(path.join(__dirname,'../../assets/portal.js'),'utf8');
  context.window.StepwiseBoard=require('../../assets/schedule-board.js');
  context.window.StepwiseReport=require('../../assets/lesson-report.js');
  vm.runInNewContext(source, context);
  const ui = { requests, local, session, writes, logs, replaced, location, el: id => elements.get(id), html: () => elements.get('app').innerHTML, confirms: () => confirmCount,
    input(id, value) { const el = elements.get(id); assert.ok(el, 'visible input: ' + id); el.value = value; emit('document:input', { target: el }); emit('app:input', { target: el }); },
    change(id, value) { const el = elements.get(id); assert.ok(el, 'visible input: ' + id); el.value = value; emit('document:change', { target: el }); emit('app:change', { target: el }); },
    check(attribute, id, checked) { const tag = [...ui.html().matchAll(/<input\b[^>]*>/g)].find(m => attrs(m[0])[attribute] === id); assert.ok(tag, 'visible checkbox: ' + id); const el = element('', attrs(tag[0])); el.checked = checked; if (el.disabled) return; emit('document:change', { target: el }); emit('app:change', { target: el }); },
    click(action, wanted = {}) { const tags = [...(ui.html() + [...elements.values()].map(e => e.innerHTML).join('')).matchAll(/<[^>]+\bdata-action="([^"]+)"[^>]*>/g)]; const tag = tags.find(m => m[1] === action && Object.keys(wanted).every(k => attrs(m[0])[k] === wanted[k])); assert.ok(tag, 'visible action: ' + action); const btn = element('', attrs(tag[0])); if (!btn.disabled) emit((kind === 'admin' ? 'document' : action==='fa-notices' && elements.get('parent-header-actions').innerHTML.includes('fa-notices') ? 'parent-header-actions' : 'app') + ':click', { target: { closest: () => btn }, preventDefault() {} }); },
    submit(id) { assert.ok(elements.has(id), 'visible form: ' + id); emit('app:submit', { target: elements.get(id), preventDefault() {} }); },
    navigate(hash) { location.hash = hash; emit('window:hashchange', {}); },
    switchStudent(k) { const oldValue = local.get('sw_k'); local.set('sw_k', k); emit('window:storage', { key: 'sw_k', oldValue, newValue: k }); },
    beforeUnload() { let blocked = false; emit('window:beforeunload', { preventDefault() { blocked = true; } }); return blocked; }
  }; return ui;
}
function slot(id, overrides = {}) { return { id, date: '2026-09-10', start: id === 'slot-b' ? '18:00' : '17:00', min: 30, subject: '英語', deliveryMode: 'in_person', st: 'offer', ...overrides }; }
function state(slots = [slot('slot-a'), slot('slot-b', { deliveryMode: 'online' })], name = '【テスト】生徒A') { return { me: { name }, today: '2026-09-08', slots, history: [], tasks: [], blocked: [], teacherOff: [], wishes: [], events: [], plan: {} }; }
function card(overrides = {}) { return { id: 'test-a', name: '【テスト】生徒A', active: true, code: 'test-link-a', month: '2026-09', today: '2026-09-08', rate30: 1000, monthly: 0, deliveryMode: 'online', lessons: [], grades: [], exams: [], payments: [], meetings: [], tasks: [], profile: {}, thisMonth: {}, plan: { lines: [], defaultRows: [] }, parentAuth: {}, ...overrides }; }
async function studentReady(s = state()) { const ui = createUI(); ui.requests[0].reply(s); await flush(); return ui; }
async function adminReady(c = card(), section = 'overview') { const ui = createUI('admin', {hash:'#s='+c.id+'&tab='+section}); ui.requests[0].reply({ data: c }); await flush(); return ui; }


function line(overrides = {}) { return { id: 'line-1', subject: '英語', kind: '', count: 4, approvedCount: null, startDate: '2026-09-01', endDate: '2026-09-30', period: '2026年9月', month: '2026-09', lessonMin: 90, rate30: 1000, lessonFee: 3000, comment: '', status: 'proposed', revision: 7, proposedAt: '2026-09-01T00:00:00Z', approvedAt: '', approvedVia: '', consentDate: '', memo: '', ...overrides }; }
module.exports = { line, createUI, slot, state, card, studentReady, adminReady, flush };
