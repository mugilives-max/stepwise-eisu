// スタッフの「今日」（docs/UX_STRUCTURE.md 3）。開いてすぐ「対応すること」と今日・明日の授業が分かるように、ほかの領域の読み取りを1回にまとめる。
// 中身はそれぞれの領域の操作をそのまま呼ぶ（見える範囲の決まり＝講師は担当の分だけ、もそちらに任せる）。
import { requireStaff, rolesOf } from './staff.mjs';
import { todayJst, addDays, scheduleRoutes } from './schedule.mjs';
import { recordRoutes } from './records.mjs';
import { gradesRoutes } from './grades.mjs';
import { billingRoutes } from './billing.mjs';
import { failedEffectsCount } from './effects-admin.mjs';

export const homeRoutes = {
  'home/today': async (c, b) => {
    const me = await requireStaff(c, b, 'manager', 'teacher'), manager = rolesOf(me).includes('manager');
    const today = todayJst(c.now), tomorrow = addDays(today, 1);
    const [range, pending, reported, grades, fees, plans] = await Promise.all([
      scheduleRoutes['schedule/staff/range'](c, { ...b, from: today, to: tomorrow }),
      recordRoutes['records/pending'](c, b),
      recordRoutes['homework/reported'](c, b),
      gradesRoutes['grades/overview'](c, b),
      manager ? billingRoutes['billing/fees/list'](c, b) : null,
      manager ? c.db.prepare("select count(*) n from planLines where status = 'proposed'").first() : null,
    ]);
    const failedEffects = manager ? await failedEffectsCount(c.db, c.now) : 0;
    const todo = [];
    const add = (key, label, count, link, note = '') => { if (count) todo.push({ key, label, count, link, note }); };
    if (manager) add('requests', '生徒・保護者からの連絡', range.openRequests.length, '#schedule', '変更・お休み・キャンセル');
    add('records', '記録待ちの授業', pending.lessons.length, '#records', pending.lessons.some(l => l.draft) ? '下書きを含む' : '');
    add('handover', '読んでいない引き継ぎメモ', pending.unreadHandover, '#records');
    add('homework', '宿題の確認待ち', reported.homework.length, '#records', '生徒・保護者が「できた」と知らせた');
    if (manager) add('sheets', '届いた成績票', grades.files.length, '#grades', '点数を取り込む');
    add('tests', '結果待ちのテスト', grades.pendingTests.length, '#grades');
    if (manager && fees) add('fees', 'キャンセル料の判断', fees.fees.filter(f => f.decision === 'pending' || f.reliefStatus === 'pending').length, '#billing');
    if (manager && plans) add('plans', '承認待ちの計画', plans.n, '#plans', '保護者の承認を待っている');
    if (manager) add('effects', '送れなかったお知らせ', failedEffects, '#effects', 'メール・カレンダー。送り直せます');
    const pendingIds = new Set(pending.lessons.map(l => l.id));
    const name = Object.fromEntries(range.students.map(s => [s.id, s.name])), staff = Object.fromEntries(range.staff.map(s => [s.id, s.name]));
    const lessons = range.lessons.filter(l => ['held', 'proposed', 'decided', 'done'].includes(l.status)).sort((x, y) => (x.date + x.start).localeCompare(y.date + y.start))
      .map(l => ({ id: l.id, date: l.date, start: l.start, minutes: l.minutes, subject: l.subject, kind: l.kind, status: l.status, deliveryMode: l.deliveryMode, meetUrl: l.meetUrl, version: l.version,
        studentId: l.studentId, studentName: name[l.studentId] || '', staffName: staff[l.staffId] || '', needsRecord: pendingIds.has(l.id) }));
    return { today, tomorrow, nowMs: c.now, todo, lessons, live: range.live };
  },
};
