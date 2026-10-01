const test=require('node:test'),assert=require('node:assert/strict');
const cal=require('../assets/calendar.js');
const {createUI,flush}=require('./helpers/operations-ui-harness.cjs');
test('official holidays include substitute, citizen holiday, and historical moved dates',()=>{
 for(const [date,name] of [['2026-09-21','敬老の日'],['2026-09-22','国民の休日'],['2026-09-23','秋分の日'],['2026-05-06','振替休日'],['2027-03-22','振替休日'],['2021-07-23','スポーツの日'],['2026-09-24','']])assert.equal(cal.holidayName(date),name);
});
test('shared calendar keeps holidays, lessons and blocked dates together, including past dates',()=>{
 const info=cal.buildInfo({lessons:[{date:'2026-09-23',start:'17:00',min:90,subject:'数学',st:'done'}],blocked:[{date:'2026-09-23'}]});
 const html=cal.render(info,{year:2026,month:8,today:'2026-09-24',selDate:'2026-09-23'});
 const cell=html.match(/<button class="calday holiday[^]*?data-date="2026-09-23"[^]*?<\/button>/)[0];
 assert.match(cell,/秋分の日/);assert.match(cell,/数学/);assert.match(cell,/授業不可/);assert.match(cell,/sel/);
 assert.match(cal.render({}, {year:2028,month:0}),/祝日情報はまだ掲載していません/);
});
// 管理ホームは授業一覧の共有月カレンダー(a234b42)。保護者・生徒と同じ StepwiseCalendar の日付ボタンに祝日名が入り、
// ボタンの読み上げ名(文字列)にも祝日名が含まれる。
test('teacher home displays the same holiday names and accessible date label',async()=>{
 const ui=createUI('admin',{hash:'#home',now:'2026-09-23T12:00:00+09:00'});assert.equal(ui.requests[0].body.op,'state');
 ui.requests[0].reply({admin:{today:'2026-09-23',students:[],slots:[],blocked:[],teacherOff:[],wishes:[],events:[],plans:[],log:[],lessonKinds:[]}});await flush();
 const cell=ui.html().match(/<button class="calday[^"]*"[^>]*data-date="2026-09-23">[^]*?<\/button>/)[0];
 assert.match(cell,/class="calday[^"]* holiday[ "]/);assert.match(cell,/<span class="calholiday">秋分の日<\/span>/);
 const shared=cal.render(cal.buildInfo({}),{year:2026,month:8,today:'2026-09-23'}).match(/data-date="2026-09-23">[^]*?<\/button>/)[0];
 assert.equal(cell.slice(cell.indexOf('data-date=')),shared);
 assert.match(cell.replace(/<[^>]+>/g,''),/^23秋分の日/);
});
