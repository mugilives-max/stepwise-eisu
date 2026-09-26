'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSchedulingHarness } = require('./helpers/scheduling-harness.cjs');
const { createParity } = require('./helpers/parity-harness.cjs');
const { TEACHER_TOKEN } = require('./gas-harness.cjs');

test.before(async () => { const { generate } = await import('../scripts/build-gas-bundle.mjs'); generate(); });

test('authenticated teacher parsing calls Anthropic from the Worker without identity fields', async () => {
  const h = createSchedulingHarness(), p = await createParity(h);
  const worker = (await import('../cf/worker/index.mjs')).default;
  const calls = [], oldFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'propose_schedule', input: { items: [{ kind: 'offer', dates: [new Date(Date.now()+2*86400000).toISOString().slice(0,10)], start: '17:00', min: 90, subject: '英語' }], questions: [], summary: '英語の授業です' } }], usage: { input_tokens: 100, output_tokens: 30 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const env = { ...p.env, NL_ENABLED: '1', ANTHROPIC_API_KEY: 'synthetic-api-key', WRITE_MODE: 'worker' };
    const body = { action: 'admin', op: 'scheduleParseTeacher', token: TEACHER_TOKEN, studentId: 'test-a', text: '明日17時から90分英語', subjects: ['英語', '数学'] };
    const response = await worker.fetch(new Request('https://api.invalid/', { method: 'POST', headers: { origin: 'https://www.stepwise-education.jp', 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, { waitUntil() {} });
    const result = await response.json();
    assert.equal(result.ok, true); assert.equal(result.items[0].subject, '英語'); assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(calls[0].headers['x-api-key'], 'synthetic-api-key');
    assert.equal(calls[0].body.model, 'claude-haiku-4-5-20251001');
    const sent = JSON.stringify(calls[0].body);
    assert.equal(sent.includes(TEACHER_TOKEN), false); assert.equal(sent.includes('test-a'), false); assert.equal(sent.includes('【テスト】'), false);
  } finally { global.fetch = oldFetch; }
});

test('an invalid teacher session is rejected before any Claude request', async () => {
  const h = createSchedulingHarness(), p = await createParity(h);
  const worker = (await import('../cf/worker/index.mjs')).default;
  let calls = 0, oldFetch = global.fetch; global.fetch = async () => { calls++; throw Error('must not fetch'); };
  try {
    const env = { ...p.env, NL_ENABLED: '1', ANTHROPIC_API_KEY: 'synthetic-api-key', WRITE_MODE: 'worker' };
    const response = await worker.fetch(new Request('https://api.invalid/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'admin', op: 'scheduleParseTeacher', token: 'invalid', studentId: 'test-a', text: '明日17時から英語' }) }), env, { waitUntil() {} });
    const result = await response.json(); assert.equal(result.badAuth, true); assert.equal(calls, 0);
  } finally { global.fetch = oldFetch; }
});

test('a missing Worker secret returns a safe setup error without an external request', async () => {
  const h = createSchedulingHarness(), p = await createParity(h);
  const worker = (await import('../cf/worker/index.mjs')).default;
  let calls = 0, oldFetch = global.fetch; global.fetch = async () => { calls++; throw Error('must not fetch'); };
  try {
    const env = { ...p.env, NL_ENABLED: '1', WRITE_MODE: 'worker' };
    const body = { action: 'admin', op: 'scheduleParseTeacher', token: TEACHER_TOKEN, studentId: 'test-a', text: '明日17時から英語' };
    const response = await worker.fetch(new Request('https://api.invalid/', { method: 'POST', headers: { origin: 'https://www.stepwise-education.jp', 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, { waitUntil() {} });
    const result = await response.json();
    assert.equal(result.errorCode, 'notConfigured'); assert.equal(calls, 0);
  } finally { global.fetch = oldFetch; }
});
