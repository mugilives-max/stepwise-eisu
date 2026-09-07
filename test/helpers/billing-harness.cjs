'use strict';

const { createHarness, TEACHER_TOKEN, MCP_KEY } = require('../gas-harness.cjs');

// Only fixture construction lives here. Requests run the actual GAS dispatch,
// authorization, approval, fee calculation and persistence implementations.
// Every student and record is synthetic; no Google services are connected.
function createBillingHarness(options = {}) {
  const h = createHarness({ iterations: 10, ...options });
  const initialized = h.admin('state');
  if (!initialized.ok) throw new Error('Cannot initialize billing fixture: ' + JSON.stringify(initialized));
  let sequence = 0;

  function append(name, record, target = h.spreadsheet) {
    const sheet = target.getSheetByName(name);
    if (!sheet) throw new Error('Fixture sheet is missing: ' + name);
    const headers = sheet.values[0];
    for (const field of Object.keys(record)) {
      if (!headers.includes(field)) throw new Error('Unknown fixture field: ' + name + '.' + field);
    }
    sheet.appendRow(headers.map(field => record[field] ?? ''));
    return record;
  }

  function slot(overrides = {}) {
    return append('slots', {
      id: 'synthetic-billing-slot-' + (++sequence), date: '2026-09-15', start: '16:00',
      min: 60, status: 'offered', studentId: 'test-a', done: '', eventId: '',
      meetUrl: '', subject: '数学', req: '', ...overrides
    });
  }

  function plan(overrides = {}) {
    return append('plans', {
      id: 'synthetic-billing-plan-' + (++sequence), studentId: 'test-a', ym: '2026-09',
      subject: '数学', count: 2, status: 'draft', proposedAt: '', approvedAt: '',
      approvedVia: '', memo: '', ...overrides
    });
  }

  function payment(overrides = {}) {
    // Creating ledger structure through its real helper also follows any new
    // appended columns without duplicating production schema declarations here.
    h.context().ledgerSheet_('入金管理');
    return append('入金管理', {
      '年月': '2026-09', '生徒ID': 'test-a', '氏名': h.studentRow().name,
      '請求額': 3000, '請求日': '2026-09-07', '入金日': '', '入金方法': '',
      '状態': '未入金', '備考': '架空の過去請求', ...overrides
    }, h.ledger);
  }

  return Object.assign(h, {
    seedSlot: slot, seedPlan: plan, seedPayment: payment,
    payments: () => h.rows('入金管理', h.ledger),
    accept: (slotId, k = 'synthetic-link-a') => h.request({ action: 'accept', slotId, k }),
    mcp: (op, args = {}) => h.request({ action: 'admin', op, mcpKey: MCP_KEY, ...args })
  });
}

module.exports = { createBillingHarness, TEACHER_TOKEN, MCP_KEY };
