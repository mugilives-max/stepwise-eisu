// 切り替え（9段目）。docs/CUTOVER_RUNBOOK.md の当日の手順を、1つのボタンにまとめる。システム管理者だけ。
// 「切り替える」:
//   1. 今の仕組みを読むだけにする（今の台帳の config 'v2CutoverAt'。cf/worker/cutover.mjs が書き込みと自動処理を止める）
//   2. 最後の「全部を順に写し直す」
//   3. 照らし合わせ。「違う」があれば 1 を戻して止める（何も切り替えない）
//   4. live にする（保護者へのメール・カレンダーを動かす）
//   5. 今日以降の決定の授業・面談で、カレンダーの予定がないものを作る
//   6. （選んだとき）保護者ページに登録していない家族に、登録の案内を送る
// 「元に戻す」: live を戻し、今の仕組みの読むだけを外す。新しい仕組みで受けたことは手で今の仕組みに入れ直す。
import { fail, iso, audit } from './util.mjs';
import { requireStaff } from './staff.mjs';
import { isLive } from './accounts.mjs';
import { todayJst, calendarEffect } from './schedule.mjs';
import { copyAll } from './migrate-records.mjs';
import { checkRows } from './migrate-check.mjs';
import { peopleRoutes } from './people.mjs';

const fullName = s => [s.familyName, s.givenName].filter(Boolean).join(' ');
const needsEvent = id => !id || id.startsWith('swv2');
async function setLive(c, on) {
  await c.db.prepare("insert into settings (key, value, updatedAt) values ('live', ?, ?) on conflict(key) do update set value = excluded.value, updatedAt = excluded.updatedAt").bind(on ? '1' : '0', iso(c.now)).run();
}
async function freezeOld(c, on) {
  if (on) await c.env.DB.prepare("insert into config (key, value) values ('v2CutoverAt', ?) on conflict(key) do update set value = excluded.value").bind(iso(c.now)).run();
  else await c.env.DB.prepare("delete from config where key = 'v2CutoverAt'").run();
}

export const cutoverRoutes = {
  'admin/cutover/apply': async (c, b) => {
    await requireStaff(c, b, 'sysadmin');
    if (String(b.confirm || '') !== '切り替える') fail('needConfirm', '確認のため「切り替える」と入れてください');
    if (!c.env.DB) fail('unavailable', '今の台帳に接続できません', 503);
    if (await isLive(c)) fail('already', 'もう切り替えています', 409);
    // 1〜3: 読むだけにしてから写し直し、照らし合わせる。うまくいかなければ戻して止める
    await freezeOld(c, true);
    let copied, check;
    try {
      copied = await copyAll(c, { ...b, confirm: true });
      check = await checkRows(c.env.DB, c.db);
    } catch (e) { await freezeOld(c, false); throw e; }
    const problems = check.rows.filter(r => !r.same && !r.expected);
    if (problems.length) { await freezeOld(c, false); fail('checkFailed', '照らし合わせで違うところがあるため、切り替えませんでした（今の仕組みは元のまま）: ' + problems.map(p => p.item).join('・'), 409); }
    // 4: live
    await setLive(c, true);
    // 5: カレンダー（今日以降の決定の授業・面談で、予定がないもの）
    const today = todayJst(c.now);
    let events = 0;
    for (const l of (await c.db.prepare("select l.*, s.familyName, s.givenName from lessons l join students s on s.id = l.studentId where l.status = 'decided' and l.date >= ?").bind(today).all()).results) {
      if (!needsEvent(l.calendarEventId)) continue;
      const marker = await calendarEffect(c, 'create', { ...l, calendarEventId: '' }, fullName(l));
      await c.db.prepare('update lessons set calendarEventId = ? where id = ?').bind(marker, l.id).run(); events++;
    }
    for (const m of (await c.db.prepare("select m.*, f.name familyLabel from meetings m join families f on f.id = m.familyId where m.status = 'scheduled' and m.date >= ?").bind(today).all()).results) {
      if (!needsEvent(m.calendarEventId)) continue;
      const marker = await calendarEffect(c, 'create', { ...m, subject: m.title, calendarEventId: '' }, String(m.familyLabel || '').replace(/さん$/, ''));
      await c.db.prepare('update meetings set calendarEventId = ? where id = ?').bind(marker, m.id).run(); events++;
    }
    // 6: 登録の案内（選んだとき）
    let invited = 0;
    const inviteFailed = [];
    if (b.sendInvites === true) {
      const fams = (await c.db.prepare("select f.* from families f where f.status = 'invited' and f.email <> '' and f.testOnly = 0 and exists (select 1 from students s where s.familyId = f.id and s.status <> 'left')").all()).results;
      for (const f of fams) {
        try { await peopleRoutes['admin/families/invite'](c, { ...b, id: f.id }); invited++; }
        catch (e) { inviteFailed.push(f.name); }
      }
    }
    await audit(c, 'cutover', '', { events, invited, families: copied.identity.families, lessons: copied.schedule.lessons });
    return { live: true, copied: { families: copied.identity.families, students: copied.identity.students, lessons: copied.schedule.lessons, records: copied.records.records, invoices: copied.billing.invoices },
      calendarCreated: events, invited, inviteFailed, expectedDifferences: check.rows.filter(r => r.expected).map(r => r.item) };
  },
  'admin/cutover/rollback': async (c, b) => {
    await requireStaff(c, b, 'sysadmin');
    if (String(b.confirm || '') !== '元に戻す') fail('needConfirm', '確認のため「元に戻す」と入れてください');
    if (!(await isLive(c))) fail('notLive', 'まだ切り替えていません', 409);
    await setLive(c, false);
    if (c.env.DB) await freezeOld(c, false);
    await audit(c, 'cutoverRollback', '');
    return { live: false };
  },
};
