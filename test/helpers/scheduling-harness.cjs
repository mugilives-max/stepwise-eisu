'use strict';

const { createHarness, TEACHER_TOKEN } = require('../gas-harness.cjs');

function createSchedulingHarness(options = {}) {
  const h = createHarness({ iterations: 10, ...options });
  const initialized = h.admin('state');
  if (!initialized.ok) throw new Error(JSON.stringify(initialized));
  h.context().ensureSchedulingSchema_();
  for (const id of ['test-a', 'test-b', 'test-inactive']) h.setRow('students', 'id', id, { deliveryMode: 'in_person' });
  let seq = 0;
  function append(name, row) {
    const sheet = h.spreadsheet.getSheetByName(name);
    sheet.appendRow(sheet.values[0].map(key => row[key] ?? ''));
    return row;
  }
  append('students', { id: 'test-c', name: '【テスト】同時人数C', active: true, code: 'synthetic-link-c', rate30: 1500, deliveryMode: 'in_person' });
  function slot(patch = {}) {
    return append('slots', { id: 'synthetic-schedule-' + (++seq), date: '2026-09-15', start: '16:00', min: 60,
      status: 'offered', studentId: 'test-a', done: '', eventId: '', meetUrl: '', subject: '数学', req: '', deliveryMode: 'in_person', ...patch });
  }
  // 月の案内の行を作って送信し、先生の承諾記録で承認済みにする(旧: planSet+planPropose+planApproveTeacher)
  function approve({ studentId = 'test-a', ym = '2026-09', count = 12, subject = '数学', kind = '通常', lessonMin = 90, lessonFee = 4500, comment = '' } = {}) {
    const end = h.context().planMonthEnd_(ym);
    const sent = h.admin('planLineSave', { studentId, subject, kind, count, startDate: ym + '-01', endDate: end, lessonMin, lessonFee, comment, propose: true });
    if (!sent.ok) throw new Error(JSON.stringify(sent));
    return approveLine(sent.line.id, undefined, studentId);
  }
  // 行を承認済みにする。下書きなら再送信してから承認。approvedCount を渡すと保護者として回数を減らして承認
  function approveLine(lineId, approvedCount, studentId = 'test-a') {
    let l = h.context().planLine_(studentId, lineId); if (!l) throw new Error('line not found ' + lineId);
    if (l.status !== 'proposed') {
      const sent = h.admin('planLineSave', { studentId, lineId, subject: l.subject, kind: l.kind || '通常', count: l.count, startDate: l.startDate, endDate: l.endDate, lessonMin: l.lessonMin, lessonFee: Math.round(l.rate30 * l.lessonMin / 30), comment: l.comment, propose: true, expectedRevision: l.revision });
      if (!sent.ok) throw new Error(JSON.stringify(sent));
      l = h.context().planLine_(studentId, lineId);
    }
    let result;
    if (approvedCount != null) { const c = h.context(); result = c.planLineParentDecide_(c.findStudent_(studentId), { lineId, expectedRevision: l.revision, approve: true, approvedCount }); }
    else result = h.admin('planLineApproveTeacher', { studentId, lineId, expectedRevision: l.revision, via: '電話', consentDate: '2026-09-06', memo: '架空の承諾記録' });
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result;
  }
  function requestWith(req, configure) {
    const ctx = h.context();
    configure?.(ctx);
    return JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(req) } }).getContent());
  }
  function snapshot(slotId) {
    const s = h.rows('slots').find(row => row.id === slotId);
    return s ? { id: s.id, date: s.date, start: s.start, min: Number(s.min), subject: String(s.subject || ''), deliveryMode: String(s.deliveryMode || '') } : { id: slotId };
  }
  return Object.assign(h, {
    seedSlot: slot, append, approve, approveLine, requestWith, snapshot,
    offer: (args = {}) => h.admin('offer', { studentId: 'test-a', date: '2026-09-15', start: '16:00', min: 60, subject: '数学', ...args }),
    acceptMany: (slotIds, requestId = 'synthetic-batch-request', extra = {}) => h.request({ action: 'acceptMany', k: 'synthetic-link-a', slotIds, requestId, expectedSnapshots: slotIds.map(snapshot), ...extra }),
    accept: slotId => h.request({ action: 'accept', k: 'synthetic-link-a', slotId, expectedSnapshot: snapshot(slotId) }),
    teacherRequest: (op, args = {}) => ({ action: 'admin', op, token: TEACHER_TOKEN, ...(op === 'setSlotDeliveryMode' ? { requestId: 'synthetic-mode-' + (++seq) } : {}), ...args })
  });
}

// Interrupt an actual write, optionally after its cells became durable. A fresh
// request then exercises recovery from persisted data instead of mutated mocks.
function failWriteOnce(sheet, matches, afterWrite = false) {
  const getRange = sheet.getRange;
  sheet.getRange = function(...args) {
    const range = getRange.apply(this, args), setValues = range.setValues;
    range.setValues = function(values) {
      if (!matches(values, range)) return setValues.call(this, values);
      sheet.getRange = getRange;
      if (afterWrite) setValues.call(this, values);
      throw new Error('Synthetic scheduling persistence interruption');
    };
    return range;
  };
}

module.exports = { createSchedulingHarness, failWriteOnce };
