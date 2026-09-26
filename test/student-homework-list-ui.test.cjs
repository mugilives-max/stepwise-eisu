'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUI, state, flush } = require('./helpers/operations-ui-harness.cjs');

const task = (id, overrides = {}) => ({ id, type: '宿題', title: `【テスト】${id}`, dueMode: 'date', due: '2026-09-24', done: false, doneAt: '', createdBy: 'teacher', ...overrides });
const taskState = (tasks = [], name = '【テスト】生徒A') => ({ ...state([], name), today: '2026-09-23', tasks });
const initialTasks = () => [
  task('future', { title: '【テスト】後の期限', due: '2026-09-27' }),
  task('pending', { title: '【テスト】次回未定', dueMode: 'nextLesson', dueSubject: '数学', due: '', nextLessonPending: true }),
  task('today', { title: '【テスト】今日の宿題', due: '2026-09-23' }),
  task('overdue', { title: '【テスト】前の期限', due: '2026-09-22' }),
  task('none', { title: '【テスト】期限なしメモ', type: 'メモ', dueMode: 'none', due: '', createdBy: 'student' }),
  task('done', { title: '【テスト】完了した宿題', done: true, due: '2026-09-20', doneAt: '2026-09-20 18:00' })
];

async function ready(tasks = initialTasks(), hash = '#tasks', options = {}) {
  const ui = createUI('student', { hash, now: '2027-01-15T12:00:00+09:00', ...options });
  ui.requests[0].reply(taskState(tasks));
  await flush();
  return ui;
}

const familyHome = (preview = false) => ({ ok: true, family: { id: 'test-family', label: '【テスト】家族' }, children: preview
  ? [{ studentId: 'test-a', name: '【テスト】子A', active: true }]
  : [{ studentId: 'child-a', name: '【テスト】子A', active: true }, { studentId: 'child-b', name: '【テスト】子B', active: true }] });
const familyData = name => ({ ok: true, data: { name, month: '2026-09', thisMonth: {}, payments: [], upcoming: [], planLines: [] } });
async function familyReady(tasks = initialTasks(), options = {}) {
  const preview = !!options.preview;
  const ui = createUI('student', {
    hash: '#family/tasks', now: '2027-01-15T12:00:00+09:00',
    session: new Map(preview ? [] : [['sw_ft_v1', 'test-family-token']]),
    ...(preview ? { search: '?preview=parent:test-a', local: new Map([['sw_admt', 'test-teacher-token']]) } : {})
  });
  const answered = new Set();
  for (let pass = 0; pass < 12; pass++) {
    let count = 0;
    for (const request of [...ui.requests]) {
      if (answered.has(request)) continue;
      const { action, view, studentId } = request.body;
      let response;
      if (action === 'familyHome' || action === 'preview' && view === 'home') response = familyHome(preview);
      else if (action === 'familyData' || action === 'preview' && view === 'parent') response = familyData(studentId === 'child-b' ? '【テスト】子B' : '【テスト】子A');
      else if (action === 'familyStudentState' || action === 'preview' && view === 'student') response = { ...taskState(studentId === 'child-b' ? [task('child-b-only')] : tasks), viewer: preview ? 'preview' : 'family' };
      else if (action === 'familyNotices') response = { ok: true, notices: [] };
      else continue;
      answered.add(request); request.reply(response); count++;
    }
    await flush();
    if (!count) return ui;
  }
  assert.fail('family fixture did not settle');
}

function buttons(ui, action = 'tasktoggle') {
  return [...ui.html().matchAll(/<button\b[^>]*>/g)].map(match => match[0]).filter(tag => tag.includes(`data-action="${action}"`));
}
function toggleIds(ui) {
  return buttons(ui).map(tag => /data-id="([^"]+)"/.exec(tag)?.[1]);
}
function assertTitleOrder(html, titles) {
  const indexes = titles.map(title => html.indexOf(title));
  assert.ok(indexes.every((value, index) => value >= 0 && (index === 0 || value > indexes[index - 1])), `wrong order: ${JSON.stringify(indexes)}`);
}

test('student homework is a dedicated nav page; missing and invalid filters default to incomplete', async () => {
  const ui = await ready();
  assert.match(ui.html(), /<h1[^>]*>宿題<\/h1>/);
  assert.match(ui.el('tabs').innerHTML, /href="#tasks"[^>]*>宿題<\/a>/);
  assert.ok(toggleIds(ui).includes('overdue'));
  assert.ok(!toggleIds(ui).includes('done'));
  assert.match(ui.html(), /href="#tasks\?filter=done"/);
  assert.match(ui.html(), /href="#tasks\?filter=all"/);
  const initial = toggleIds(ui);
  ui.navigate('#tasks?filter=unknown');
  assert.deepEqual(toggleIds(ui), initial);
  ui.navigate('#tasks?filter=open');
  assert.deepEqual(toggleIds(ui), initial);
});

test('open homework is sorted by resolved due date, with pending-next and no-date items last', async () => {
  const ui = await ready();
  assertTitleOrder(ui.html(), ['【テスト】前の期限', '【テスト】今日の宿題', '【テスト】後の期限']);
  for (const unknown of ['【テスト】次回未定', '【テスト】期限なしメモ']) assert.ok(ui.html().indexOf(unknown) > ui.html().indexOf('【テスト】後の期限'));
  assert.match(ui.html(), /次回の数学授業（予定未定）/);
  assert.match(ui.html(), /期限なし/);
});

test('deadline urgency uses server today and resolved due, not the device clock or an invented next lesson date', async () => {
  const future = await ready([task('future', { due: '2026-09-24' })]);
  assert.doesNotMatch(future.html(), /期限切れ|期限を過ぎ|期限超過/);
  const late = await ready([task('late', { due: '2026-09-22' })]);
  assert.match(late.html(), /期限切れ|期限を過ぎ|期限超過/);
  const pending = await ready([task('waiting', { dueMode: 'nextLesson', dueSubject: '英語', due: '', nextLessonPending: true })]);
  assert.match(pending.html(), /次回の英語授業（予定未定）/);
  assert.doesNotMatch(pending.html(), /期限切れ|期限を過ぎ|期限超過/);
});

test('done and all filters show all returned completed tasks, not an arbitrary first twenty', async () => {
  const tasks = Array.from({ length: 26 }, (_, i) => task(`done-${i}`, { done: true, doneAt: `2026-09-${String(i % 20 + 1).padStart(2, '0')}`, title: `【テスト】完了項目${i}` }));
  tasks.push(task('open'));
  const ui = await ready(tasks, '#tasks?filter=done');
  assert.equal(toggleIds(ui).length, 26);
  assert.ok(toggleIds(ui).includes('done-25'));
  assert.ok(!toggleIds(ui).includes('open'));
  assert.ok(buttons(ui).every(tag => /data-done="false"/.test(tag)));
  assert.match(ui.html(), /取得|表示.*範囲/);
  assert.match(ui.html(), /全履歴では|すべての履歴.*では|全期間.*では/);
  ui.navigate('#tasks?filter=all');
  assert.equal(toggleIds(ui).length, 27);
  assert.ok(toggleIds(ui).includes('open'));
});

test('completion dates use Japan time for timestamps and preserve date-only values', async () => {
  const ui = await ready([
    task('timestamp', { done: true, doneAt: '2026-09-22T16:00:00.000Z' }),
    task('date-only', { done: true, doneAt: '2026-09-08' }),
    task('invalid-date', { done: true, doneAt: 'not-a-date' })
  ], '#tasks?filter=done');
  assert.match(ui.html(), /2026\/9\/23 に申告/);
  assert.match(ui.html(), /2026\/9\/8 に申告/);
  assert.doesNotMatch(ui.html(), /T16:00|not-a-date|Invalid Date/);
});

test('withdrawn tasks, whether incomplete or complete, are excluded from open, done and all filters', async () => {
  const tasks = [task('visible'), task('withdrawn', { withdrawn: true }), task('withdrawn-at', { withdrawnAt: '2026-09-23' }), task('withdrawn-done', { done: true, withdrawnAt: '2026-09-22' }), task('withdrawn-bool-done', { done: true, withdrawn: true })];
  const ui = await ready(tasks, '#tasks?filter=all');
  assert.deepEqual(toggleIds(ui), ['visible']);
  assert.doesNotMatch(ui.html(), /【テスト】withdrawn/);
  ui.navigate('#tasks?filter=done');
  assert.equal(toggleIds(ui).length, 0);
  ui.navigate('#home');
  assert.doesNotMatch(ui.html(), /【テスト】withdrawn/);
});

test('student and parent homes prioritize the calendar and keep homework in its dedicated menu', async () => {
  const ui = await ready(initialTasks(), '#home');
  const parent = await familyReady();
  parent.navigate('#family/home');
  for (const [view, href] of [[ui, '#tasks'], [parent, '#family/tasks']]) {
    assert.match(view.html(), /<h2>予定表<\/h2>[^]*<h2 class="schedule-day-heading">/);
    assert.equal(view.html().match(/<h[12][^>]*>(.*?)<\/h[12]>/)?.[1], '予定表');
    assert.equal(toggleIds(view).length, view === ui ? 5 : 0);
    assert.doesNotMatch(view.html(), /homework-summary|取り組む宿題|f-ttitle/);
    assert.ok(view.el('tabs').innerHTML.includes(`href="${href}"`));
    view.navigate(href);
    assert.match(view.html(), /<h1>宿題<\/h1>/);
    assert.equal(toggleIds(view).length, 5);
    assert.doesNotMatch(view.html(), /data-action="taskadd"|id="f-ttitle"/);
  }
});

test('homework, belongings and notes remain distinct; only self-created items expose deletion', async () => {
  const ui = await ready([task('homework'), task('bag', { type: '持ち物' }), task('memo', { type: 'メモ', createdBy: 'student' })]);
  assert.match(ui.html(), />宿題<\//);
  assert.match(ui.html(), />持ち物<\//);
  assert.match(ui.html(), />メモ<\//);
  const removals = buttons(ui, 'taskdel');
  assert.equal(removals.length, 1);
  assert.match(removals[0], /data-id="memo"/);
  ui.click('taskdel', { 'data-id': 'memo' });
  assert.deepEqual(ui.requests.at(-1).body, { action: 'taskDel', k: 'test-link-a', taskId: 'memo' });
  ui.requests.at(-1).reply({ ok: true, state: taskState([task('homework'), task('bag', { type: '持ち物' })]) });
  await flush();
  assert.ok(!toggleIds(ui).includes('memo'));
});

test('task text, task IDs and next-lesson subject are escaped in the list', async () => {
  const id = 'quoted"task';
  const ui = await ready([task(id, { title: '<img src=x onerror="unsafe()">', type: 'メモ', dueMode: 'nextLesson', dueSubject: '<script>unsafe()</script>', due: '', createdBy: 'student' })]);
  assert.doesNotMatch(ui.html(), /<img src=x|<script>unsafe/);
  assert.match(ui.html(), /&lt;img src=x onerror=&quot;unsafe\(\)&quot;&gt;/);
  assert.match(ui.html(), /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  assert.match(ui.html(), /data-id="quoted&quot;task"/);
  ui.click('tasktoggle', { 'data-id': id, 'data-done': 'true' });
  assert.equal(ui.requests.at(-1).body.taskId, id);
});

test('completion sends an explicit target once while busy and can be undone from the done filter', async () => {
  const original = task('toggle');
  const ui = await ready([original]);
  ui.click('tasktoggle', { 'data-id': original.id, 'data-done': 'true' });
  const first = ui.requests.at(-1), count = ui.requests.length;
  assert.deepEqual(first.body, { action: 'taskDone', k: 'test-link-a', taskId: original.id, done: true });
  assert.ok(buttons(ui).every(tag => /\bdisabled\b/.test(tag)));
  ui.click('tasktoggle', { 'data-id': original.id });
  assert.equal(ui.requests.length, count);
  first.reply({ ok: true, state: taskState([{ ...original, done: true, doneAt: '2026-09-23 15:00' }]) });
  await flush();
  assert.ok(!toggleIds(ui).includes(original.id));
  ui.navigate('#tasks?filter=done');
  ui.click('tasktoggle', { 'data-id': original.id, 'data-done': 'false' });
  assert.deepEqual(ui.requests.at(-1).body, { action: 'taskDone', k: 'test-link-a', taskId: original.id, done: false });
  ui.requests.at(-1).reply({ ok: true, state: taskState([original]) });
  await flush();
  assert.ok(!toggleIds(ui).includes(original.id));
  ui.navigate('#tasks?filter=open');
  assert.ok(toggleIds(ui).includes(original.id));
});

test('a rejected toggle leaves the task unchanged and can be retried with the same target', async () => {
  const ui = await ready([task('error')]);
  ui.click('tasktoggle', { 'data-id': 'error', 'data-done': 'true' });
  ui.requests.at(-1).reply({ error: '【テスト】保存できませんでした' });
  await flush();
  assert.match(ui.html() + ui.el('toast').textContent, /保存できませんでした/);
  assert.match(buttons(ui)[0], /data-done="true"/);
  assert.doesNotMatch(buttons(ui)[0], /\bdisabled\b/);
  ui.click('tasktoggle', { 'data-id': 'error', 'data-done': 'true' });
  assert.equal(ui.requests.at(-1).body.done, true);
});

test('network failure does not optimistically remove homework or leave the controls busy', async () => {
  const ui = await ready([task('network')]);
  ui.click('tasktoggle', { 'data-id': 'network', 'data-done': 'true' });
  ui.requests.at(-1).fail();
  await flush();
  assert.ok(toggleIds(ui).includes('network'));
  assert.doesNotMatch(buttons(ui)[0], /\bdisabled\b/);
  assert.match(ui.html() + ui.el('toast').textContent, /通信に失敗/);
});

test('the explicit retry survives filter and home navigation and resends the same completion target', async () => {
  const original = task('retry');
  const ui = await ready([original]);
  ui.click('tasktoggle', { 'data-id': original.id, 'data-done': 'true' });
  const first = ui.requests.at(-1), payload = structuredClone(first.body);
  first.fail();
  await flush();
  assert.match(ui.html(), /data-action="taskretry"/);
  ui.navigate('#tasks?filter=done');
  assert.equal(toggleIds(ui).length, 0);
  assert.match(ui.html(), /保存結果を確認できませんでした/);
  ui.navigate('#home');
  assert.match(ui.html(), /data-action="taskretry"/);
  ui.navigate('#tasks');
  assert.match(ui.html(), /data-action="taskretry"/);
  ui.click('taskretry');
  assert.deepEqual(ui.requests.at(-1).body, payload);
  const count = ui.requests.length;
  if (buttons(ui, 'taskretry').length) {
    assert.match(buttons(ui, 'taskretry')[0], /\bdisabled\b/);
    ui.click('taskretry');
  } else assert.match(ui.html(), /完了状態を保存しています/);
  assert.equal(ui.requests.length, count, 'retry cannot be sent again while the same request is pending');
  ui.requests.at(-1).reply({ ok: true, state: taskState([{ ...original, done: true, doneAt: '2026-09-23 16:00' }]) });
  await flush();
  assert.doesNotMatch(ui.html(), /data-action="taskretry"/);
  ui.navigate('#tasks?filter=done');
  assert.deepEqual(toggleIds(ui), [original.id]);
});

test('a late completion from the previous dedicated student link cannot overwrite the new list', async () => {
  const ui = await ready([task('only-a')]);
  ui.click('tasktoggle', { 'data-id': 'only-a', 'data-done': 'true' });
  const old = ui.requests.at(-1);
  ui.switchStudent('test-link-b');
  ui.requests.at(-1).reply(taskState([task('only-b')], '【テスト】生徒B'));
  await flush();
  old.reply({ ok: true, state: taskState([task('old-a-payload')], '【テスト】古い生徒A') });
  await flush();
  assert.deepEqual(toggleIds(ui), ['only-b']);
  assert.doesNotMatch(ui.html(), /old-a-payload/);
  ui.click('tasktoggle', { 'data-id': 'only-b', 'data-done': 'true' });
  assert.equal(ui.requests.at(-1).body.k, 'test-link-b');
});

test('parent homework reuses the filters and proxies completion through family token plus selected child', async () => {
  const ui = await familyReady();
  assert.match(ui.html(), /<h1[^>]*>宿題<\/h1>/);
  assert.match(ui.el('tabs').innerHTML, /href="#family\/tasks"[^>]*>宿題<\/a>/);
  assert.match(ui.html(), /保護者が代わりに操作できます/);
  assert.match(ui.html(), /href="#family\/tasks\?filter=done"/);
  ui.navigate('#family/tasks?filter=done');
  assert.deepEqual(toggleIds(ui), ['done']);
  ui.click('tasktoggle', { 'data-id': 'done', 'data-done': 'false' });
  assert.deepEqual(ui.requests.at(-1).body, { action: 'taskDone', taskId: 'done', done: false, ftoken: 'test-family-token', studentId: 'child-a' });
  ui.requests.at(-1).reply({ ok: true, state: { ...taskState(initialTasks().map(item => item.id === 'done' ? { ...item, done: false } : item)), viewer: 'family' } });
  await flush();
  assert.ok(!toggleIds(ui).includes('done'));
  ui.navigate('#family/tasks?filter=all');
  assert.ok(toggleIds(ui).includes('done'));
});

test('a delayed parent proxy success after switching children cannot overwrite or disable the new child list', async () => {
  const ui = await familyReady([task('only-a')]);
  ui.click('tasktoggle', { 'data-id': 'only-a', 'data-done': 'true' });
  const old = ui.requests.at(-1);
  ui.change('fa-mychild', 'child-b');
  const next = ui.requests.findLast(request => request.body.action === 'familyStudentState' && request.body.studentId === 'child-b');
  assert.ok(next, 'switching children requests the new student state');
  next.reply({ ...taskState([task('only-b')], '【テスト】子B'), viewer: 'family' });
  await flush();
  old.reply({ ok: true, state: { ...taskState([task('old-a-payload')], '【テスト】古い子A'), viewer: 'family' } });
  await flush();
  assert.deepEqual(toggleIds(ui), ['only-b']);
  assert.doesNotMatch(ui.html(), /old-a-payload/);
  ui.click('tasktoggle', { 'data-id': 'only-b', 'data-done': 'true' });
  assert.equal(ui.requests.at(-1).body.studentId, 'child-b');
  assert.equal(ui.requests.at(-1).body.ftoken, 'test-family-token');
});

test('a parent proxy failure after a child switch does not replace the new child state or surface an old error', async () => {
  const ui = await familyReady([task('only-a')]);
  ui.click('tasktoggle', { 'data-id': 'only-a', 'data-done': 'true' });
  const old = ui.requests.at(-1);
  ui.change('fa-mychild', 'child-b');
  ui.requests.findLast(request => request.body.action === 'familyStudentState' && request.body.studentId === 'child-b').reply({ ...taskState([task('only-b')], '【テスト】子B'), viewer: 'family' });
  await flush();
  old.reply({ error: '【テスト】前の子の保存エラー' });
  await flush();
  assert.deepEqual(toggleIds(ui), ['only-b']);
  assert.doesNotMatch(ui.html() + ui.el('toast').textContent, /前の子の保存エラー/);
  assert.doesNotMatch(buttons(ui)[0], /\bdisabled\b/);
});

test('a failed family completion retry stays with its child rather than being re-proxied to a sibling', async () => {
  const ui = await familyReady([task('retry-a')]);
  ui.click('tasktoggle', { 'data-id': 'retry-a', 'data-done': 'true' });
  const first = ui.requests.at(-1), payload = structuredClone(first.body);
  first.fail();
  await flush();
  assert.match(ui.html(), /data-action="taskretry"/);
  ui.change('fa-mychild', 'child-b');
  ui.requests.findLast(request => request.body.action === 'familyStudentState' && request.body.studentId === 'child-b').reply({ ...taskState([task('only-b')], '【テスト】子B'), viewer: 'family' });
  await flush();
  assert.doesNotMatch(ui.html(), /data-action="taskretry"|保存結果を確認できませんでした/);
  ui.change('fa-mychild', 'child-a');
  assert.match(ui.html(), /data-action="taskretry"/);
  ui.click('taskretry');
  assert.deepEqual(ui.requests.at(-1).body, payload);
  assert.equal(ui.requests.at(-1).body.studentId, 'child-a');
});

test('a parent completion succeeds even if another tab changes the unrelated student-link key mid-request', async () => {
  const original = task('family-key');
  const ui = await familyReady([original]);
  ui.click('tasktoggle', { 'data-id': original.id, 'data-done': 'true' });
  const pending = ui.requests.at(-1), count = ui.requests.length;
  ui.switchStudent('test-unrelated-link');
  assert.equal(ui.requests.length, count, 'a family page must not load the unrelated student link');
  pending.reply({ ok: true, state: { ...taskState([{ ...original, done: true, doneAt: '2026-09-23 17:00' }]), viewer: 'family' } });
  await flush();
  assert.ok(!toggleIds(ui).includes(original.id));
  ui.navigate('#family/tasks?filter=done');
  assert.deepEqual(toggleIds(ui), [original.id]);
  assert.doesNotMatch(buttons(ui)[0], /\bdisabled\b/);
  ui.click('tasktoggle', { 'data-id': original.id, 'data-done': 'false' });
  assert.deepEqual(ui.requests.at(-1).body, { action: 'taskDone', taskId: original.id, done: false, ftoken: 'test-family-token', studentId: 'child-a' });
});

for (const failure of ['server', 'network']) {
  test(`a parent ${failure} failure releases busy and preserves retry despite an unrelated student-link change`, async () => {
    const ui = await familyReady([task('family-key-error')]);
    ui.click('tasktoggle', { 'data-id': 'family-key-error', 'data-done': 'true' });
    const pending = ui.requests.at(-1), payload = structuredClone(pending.body);
    ui.switchStudent('test-unrelated-link');
    if (failure === 'server') pending.reply({ error: '【テスト】親の保存をやり直してください' });
    else pending.fail();
    await flush();
    assert.deepEqual(toggleIds(ui), ['family-key-error']);
    assert.doesNotMatch(buttons(ui)[0], /\bdisabled\b/);
    assert.match(ui.html(), /data-action="taskretry"/);
    assert.doesNotMatch(buttons(ui, 'taskretry')[0], /\bdisabled\b/);
    ui.click('taskretry');
    assert.deepEqual(ui.requests.at(-1).body, payload);
  });
}

for (const outcome of ['success', 'server-error', 'network-error']) {
  test(`a stale parent ${outcome} cannot release the busy state owned by a newer student request`, async () => {
    const ui = await familyReady([task('old-family-a')]);
    ui.click('tasktoggle', { 'data-id': 'old-family-a', 'data-done': 'true' });
    const old = ui.requests.at(-1);
    ui.navigate('#tasks');
    ui.switchStudent('test-link-b');
    const studentTask = task('current-student-b');
    ui.requests.at(-1).reply(taskState([studentTask], '【テスト】生徒B'));
    await flush();
    ui.click('tasktoggle', { 'data-id': studentTask.id, 'data-done': 'true' });
    const current = ui.requests.at(-1), count = ui.requests.length;
    assert.deepEqual(current.body, { action: 'taskDone', k: 'test-link-b', taskId: studentTask.id, done: true });
    assert.match(buttons(ui)[0], /\bdisabled\b/);
    if (outcome === 'success') old.reply({ ok: true, state: { ...taskState([task('STALE_FAMILY_PAYLOAD')]), viewer: 'family' } });
    else if (outcome === 'server-error') old.reply({ error: '【テスト】古い親のエラー' });
    else old.fail();
    await flush();
    assert.deepEqual(toggleIds(ui), [studentTask.id]);
    assert.match(buttons(ui)[0], /\bdisabled\b/, 'only the newer student request may unlock the controls');
    assert.doesNotMatch(ui.html() + ui.el('toast').textContent, /STALE_FAMILY_PAYLOAD|古い親のエラー|通信に失敗/);
    ui.click('tasktoggle', { 'data-id': studentTask.id, 'data-done': 'true' });
    assert.equal(ui.requests.length, count, 'the stale response must not permit a duplicate student POST');
    current.reply({ ok: true, state: taskState([{ ...studentTask, done: true, doneAt: '2026-09-23 18:00' }], '【テスト】生徒B') });
    await flush();
    ui.navigate('#tasks?filter=done');
    assert.deepEqual(toggleIds(ui), [studentTask.id]);
    assert.doesNotMatch(buttons(ui)[0], /\bdisabled\b/, 'the owner releases busy when its own response arrives');
    ui.click('tasktoggle', { 'data-id': studentTask.id, 'data-done': 'false' });
    assert.deepEqual(ui.requests.at(-1).body, { action: 'taskDone', k: 'test-link-b', taskId: studentTask.id, done: false });
  });
}

test('stale owners remove only their own pending feedback and preserve a newer notice in the same scope', async () => {
  for (const outcome of ['success', 'network-error']) {
    const ui = await familyReady([task('old-family-a')]);
    ui.click('tasktoggle', { 'data-id': 'old-family-a', 'data-done': 'true' });
    const old = ui.requests.at(-1);
    ui.navigate('#tasks');
    ui.switchStudent('test-link-b');
    ui.requests.at(-1).reply(taskState([task('current-b')]));
    await flush();
    ui.click('tasktoggle', { 'data-id': 'current-b', 'data-done': 'true' });
    const current = ui.requests.at(-1);
    if (outcome === 'success') old.reply({ ok: true, state: { ...taskState([task('old-family-a', { done: true })]), viewer: 'family' } });
    else old.fail();
    await flush();
    current.reply({ ok: true, state: taskState([task('current-b', { done: true })]) });
    await flush();
    ui.navigate('#family/tasks');
    assert.doesNotMatch(ui.html(), /完了状態を保存しています/, `${outcome}: the abandoned family's pending notice must not persist`);
  }
  const ui = await familyReady([task('same-family')]);
  ui.click('tasktoggle', { 'data-id': 'same-family', 'data-done': 'true' });
  const old = ui.requests.at(-1);
  ui.navigate('#tasks');
  ui.switchStudent('test-link-b');
  ui.requests.at(-1).reply(taskState([]));
  await flush();
  ui.navigate('#family/tasks');
  ui.click('tasktoggle', { 'data-id': 'same-family', 'data-done': 'true' });
  const newer = ui.requests.at(-1);
  old.fail();
  await flush();
  ui.navigate('#family/tasks');
  assert.match(ui.html(), /完了状態を保存しています/, 'a later pending notice in the same family/child scope must be retained');
  assert.match(buttons(ui)[0], /\bdisabled\b/);
  newer.reply({ error: '【テスト】後発の保存エラー' });
  await flush();
  assert.match(ui.html(), /後発の保存エラー/);
  assert.match(ui.html(), /data-action="taskretry"/);
});

test('an old family-token response cannot poison the current child cache after session-token rotation', async () => {
  const ui = await familyReady([task('current-a')]);
  ui.click('tasktoggle', { 'data-id': 'current-a', 'data-done': 'true' });
  const old = ui.requests.at(-1);
  ui.session.set('sw_ft_v1', 'test-replacement-family-token');
  old.reply({ ok: true, state: { ...taskState([task('OLD_TOKEN_PRIVATE_PAYLOAD')], '【テスト】古いセッション'), viewer: 'family' } });
  await flush();
  assert.deepEqual(toggleIds(ui), ['current-a']);
  assert.doesNotMatch(ui.html(), /OLD_TOKEN_PRIVATE_PAYLOAD|古いセッション/);
  assert.doesNotMatch(buttons(ui)[0], /\bdisabled\b/);
  ui.change('fa-mychild', 'child-b');
  const next = ui.requests.findLast(request => request.body.action === 'familyStudentState' && request.body.studentId === 'child-b');
  assert.equal(next.body.ftoken, 'test-replacement-family-token');
  next.reply({ ...taskState([task('current-b')], '【テスト】子B'), viewer: 'family' });
  await flush();
  ui.change('fa-mychild', 'child-a');
  assert.deepEqual(toggleIds(ui), ['current-a'], 'returning to A must read the unpoisoned per-child cache');
  assert.doesNotMatch(ui.html(), /OLD_TOKEN_PRIVATE_PAYLOAD/);
  ui.click('tasktoggle', { 'data-id': 'current-a', 'data-done': 'true' });
  assert.equal(ui.requests.at(-1).body.ftoken, 'test-replacement-family-token');
});

test('logout hides homework and a late family write response cannot restore private rows or the session', async () => {
  const ui = await familyReady([task('before-logout')]);
  ui.click('tasktoggle', { 'data-id': 'before-logout', 'data-done': 'true' });
  const old = ui.requests.at(-1);
  ui.navigate('#family/settings');
  ui.click('fa-logout');
  const logout = ui.requests.at(-1);
  assert.equal(logout.body.action, 'familyLogout');
  logout.reply({ ok: true });
  await flush();
  assert.equal(ui.session.has('sw_ft_v1'), false);
  old.reply({ ok: true, state: { ...taskState([task('AFTER_LOGOUT_PRIVATE_PAYLOAD')], '【テスト】ログアウト前'), viewer: 'family' } });
  await flush();
  ui.navigate('#family/tasks');
  assert.equal(ui.session.has('sw_ft_v1'), false);
  assert.equal(toggleIds(ui).length, 0);
  assert.doesNotMatch(ui.html(), /AFTER_LOGOUT_PRIVATE_PAYLOAD|before-logout/);
  assert.ok(ui.el('fa-pass'), 'the protected page remains behind family login');
});

test('student and parent teacher-previews disable homework changes and never issue a write', async () => {
  const student = await ready([task('preview')], '#tasks', { search: '?preview=student:test-a', local: new Map([['sw_admt', 'test-teacher-token']]) });
  const parent = await familyReady([task('preview')], { preview: true });
  for (const ui of [student, parent]) {
    const count = ui.requests.length;
    assert.match(buttons(ui)[0], /\bdisabled\b/);
    ui.click('tasktoggle', { 'data-id': 'preview', 'data-done': 'true' });
    if (buttons(ui, 'taskadd').length) {
      assert.match(buttons(ui, 'taskadd')[0], /\bdisabled\b/);
      ui.click('taskadd');
    }
    await flush();
    assert.equal(ui.requests.length, count);
    assert.ok(ui.requests.every(request => request.body.action === 'preview'));
  }
});

test('student and family homework have no self-add form', async () => { for (const ui of [await ready([]), await familyReady([])]) assert.doesNotMatch(ui.html(), /data-action="taskadd"|自分で追加する/); });

test('home shows only incomplete homework after daily lessons and removes completed items', async () => {
  const ui = await ready([task('open'), task('done', {done:true}), task('removed', {withdrawn:true}), task('bag', {type:'持ち物'}), task('memo', {type:'メモ'})], '#home');
  assert.deepEqual(toggleIds(ui), ['open', 'done']);
  assert.ok(ui.html().indexOf('schedule-day-heading') < ui.html().indexOf('aria-label="未完了の宿題"'));
  ui.click('tasktoggle', {'data-id':'open','data-done':'true'});
  assert.equal(ui.requests.length, 1);
  assert.match(ui.html(), /宿題のできた報告/);
  ui.click('homework-confirm');
  ui.requests.at(-1).reply({ok:true,state:taskState([task('open',{done:true})])});
  await flush();
  assert.deepEqual(toggleIds(ui), ['open']);
  assert.match(ui.html(), /先生の確認待ち/);
  assert.match(ui.html(), /未完了の宿題はありません/);
});
