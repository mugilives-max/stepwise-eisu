'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), C=require('../assets/calendar.js');
test('staggered overlaps reuse two lanes without treating touching ends as overlaps',()=>{
 const items=['17:00','17:30','18:30','19:00'].map(start=>({start,end:C.endTime(start,90),lesson:true}));
 const groups=C.overlapGroups(items);assert.equal(groups.length,1);assert.deepEqual(groups[0].items.map(x=>x.lane),[0,1,0,1]);assert.equal(groups[0].end-groups[0].start,210);
 assert.equal(C.overlapGroups([{start:'14:30',end:'16:00'},{start:'16:00',end:'17:30'}]).length,2);
});
test('overlap lanes are opt-in and restrictions remain in chronological order',()=>{
 const info=C.buildInfo({lessons:['17:00','17:30'].map(start=>({date:'2026-09-09',start,min:90,subject:'英語',st:'mine'})),teacherOff:[{date:'2026-09-09',start:'20:00',end:'21:00'}]});
 const options={year:2026,month:8,today:'2026-09-01',showToff:true};
 assert.doesNotMatch(C.render(info,options),/class="cal-overlap"/);
 const html=C.render(info,{...options,overlapLanes:true});assert.match(html,/class="cal-overlap"/);assert.ok(html.indexOf('17:00')<html.indexOf('20:00'));
});
