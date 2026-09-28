const test=require('node:test'),assert=require('node:assert/strict');
const {createUI,flush,card,line}=require('./helpers/operations-ui-harness.cjs');
async function ready(){const ui=createUI('admin',{hash:'#s=test-a'});ui.requests[0].reply({data:card({nlEnabled:true,plan:{lines:[line({status:'approved'})],usage:{'line-1':{done:2,planned:1}},defaultRows:[]}})});await flush();return ui;}
test('student overview opens shared offer modal with selected student',async()=>{const ui=await ready();ui.click('sdayadd');assert.equal(ui.el('board-editor').modal,true);assert.equal(ui.el('f-student').value,'test-a');assert.equal(ui.el('f-min').value,'90');});
test('student overview opens shared AI modal',async()=>{const ui=await ready();ui.click('sdayai');assert.equal(ui.el('ai-schedule').modal,true);assert.equal(ui.el('ai-student').value,'test-a');});
test('student overview shows plan progress at bottom',async()=>{const ui=await ready();assert.match(ui.html(),/授業計画・実施状況/);assert.match(ui.html(),/登録回数/);assert.match(ui.html(),/<td>3回<\/td><td>2回<\/td>/);});
