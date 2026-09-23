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
test('teacher home displays the same holiday names and accessible date label',async()=>{
 const ui=createUI('admin',{hash:'#home',now:'2026-09-23T12:00:00+09:00'});
 ui.requests[0].reply({data:{today:'2026-09-23',slots:[],lessonsToday:[],lessonsWeek:[],pending:[],unpaid:[],students:[],meetings:[]}});await flush();
 assert.match(ui.html(),/id="home-day-2026-09-23"[^]*?aria-label="[^"]*秋分の日[^]*?<span class="calholiday">秋分の日/);
});
