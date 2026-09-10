'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createFamilyHarness}=require('./helpers/family-harness.cjs');
test('membership view filters single groups and never reads billing or notification history',()=>{
 const h=createFamilyHarness();const g=h.admin('familyCreate',{label:'【テスト】兄弟',studentIds:['test-a','test-b']});assert.equal(g.ok,true);
 const c=h.context(),counts={},read=c.readRows_;c.readRows_=function(name){counts[name]=(counts[name]||0)+1;assert.notEqual(name,'familyOutbox');return read(name);};
 c.familyView_=c.familyBilling_=c.ledgerRows_=()=>{throw Error('Unexpected detailed read');};
 const r=c.familyGroups_('');assert.equal(r.families.length,1);assert.equal(r.families[0].children.length,2);assert.equal('email' in r.families[0],false);assert.equal('billing' in r.families[0],false);assert.equal('notifications' in r,false);assert.deepEqual(counts,{familyLinks:1,students:1,familyAccounts:1});
});
test('single groups are omitted from list but available for their student settings',()=>{
 const h=createFamilyHarness();h.admin('familyCreate',{label:'【テスト】単独',studentIds:['test-a']});
 assert.equal(h.admin('familyList',{view:'groups'}).families.length,0);
 const r=h.admin('familyList',{view:'groups',studentId:'test-a'});assert.equal(r.families.length,1);assert.equal(r.families[0].children[0].studentId,'test-a');
 assert.equal(h.admin('familyList',{view:'groups',studentId:'missing'}).families.length,0);
});
