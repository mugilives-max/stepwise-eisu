const test=require('node:test'),assert=require('node:assert/strict');
const {createSchedulingHarness}=require('./helpers/scheduling-harness.cjs');
const {createUI,flush}=require('./helpers/operations-ui-harness.cjs');
test('student state retains own blocked history and day detail is read only',async()=>{
 const h=createSchedulingHarness(), c=h.context(), today=c.todayStr_(), past=c.addDays_(today,-7), old=c.addDays_(today,-367);
 const sheet=h.spreadsheet.getSheetByName('blocked');
 for(const row of [{id:'past',studentId:'test-a',date:past,start:'17:00',end:'20:00',note:'部活動'},{id:'other',studentId:'test-b',date:past},{id:'old',studentId:'test-a',date:old}])sheet.appendRow(sheet.values[0].map(k=>row[k]||''));
 c.memoClear_();const state=JSON.parse(JSON.stringify(c.studentState_('synthetic-link-a')));
 assert.ok(state.blocked.some(x=>x.id==='past'));assert.ok(!state.blocked.some(x=>x.id==='other'||x.id==='old'));
 const cal=require('../assets/calendar.js'), parts=past.split('-');
 const html=cal.render(cal.buildInfo({blocked:state.blocked}),{year:+parts[0],month:+parts[1]-1,today:today});
 assert.ok(html.includes('data-date="'+past+'"'));assert.match(html,/授業不可17-20/);
});
