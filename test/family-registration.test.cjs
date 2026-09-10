const test = require('node:test');
const assert = require('node:assert/strict');
const {createFamilyHarness} = require('./helpers/family-harness.cjs');
const EMAIL='signup@example.invalid', PASS=' 123456789012 ';
function fixture() {
  const h=createFamilyHarness();
  const c=h.admin('familyCreate',{label:'【テスト】登録',studentIds:['test-a']});
  assert.ok(c.ok);assert.ok(h.family('familyRegister',{inviteCode:c.inviteCode,email:EMAIL,pass:'ignored password'}).ok);
  return {h,c,challenge:h.latestChallenge(),account:()=>h.rows('familyAccounts').find(a=>a.id===c.family.id)};
}
test('email verification precedes password storage and one-use completion; links and password spaces preserved',()=>{
  const {h,c,challenge,account}=fixture(),links=JSON.stringify(h.rows('familyLinks'));
  assert.equal(account().passHash,'');assert.equal(account().verifiedAt,'');
  assert.ok(h.family('familyCompleteRegistration',{challenge,pass:PASS}).error);
  assert.equal(h.family('familyVerify',{challenge}).passwordRequired,true);
  assert.equal(account().passHash,'');assert.equal(account().status,'pending');
  assert.ok(h.family('familyLogin',{email:EMAIL,pass:PASS}).error);
  assert.ok(h.family('familyCompleteRegistration',{challenge,pass:'short'}).error);
  assert.ok(h.family('familyVerify',{challenge}).ok); // reopen the received link
  assert.ok(h.family('familyCompleteRegistration',{challenge,pass:PASS}).registered);
  assert.ok(h.family('familyLogin',{email:EMAIL,pass:PASS}).ftoken);
  assert.ok(h.family('familyLogin',{email:EMAIL,pass:PASS.trim()}).error);
  assert.ok(h.family('familyCompleteRegistration',{challenge,pass:PASS}).error);
  assert.ok(h.family('familyRegister',{inviteCode:c.inviteCode,email:'other@example.invalid'}).error);
  assert.equal(JSON.stringify(h.rows('familyLinks')),links);
});
test('email correction requires invitation and revokes old proof; cooldown leaves current address intact',()=>{
  const {h,c,challenge,account}=fixture();
  assert.ok(h.family('familyRegister',{inviteCode:c.inviteCode,email:'correct@example.invalid'}).error);
  assert.equal(account().email,EMAIL);
  h.advance(61000);
  assert.ok(h.family('familyRegister',{email:'correct@example.invalid'}).error);
  assert.ok(h.family('familyRegister',{inviteCode:c.inviteCode,email:'correct@example.invalid'}).ok);
  assert.equal(account().email,'correct@example.invalid');
  assert.ok(h.family('familyVerify',{challenge}).error);
  assert.ok(h.family('familyVerify',{challenge:h.latestChallenge()}).passwordRequired);
});
test('expired setup can restart by password-free resend without exposing account existence',()=>{
  const {h,challenge,account}=fixture();h.family('familyVerify',{challenge});h.advance(31*60000);
  assert.ok(h.family('familyCompleteRegistration',{challenge,pass:PASS}).error);
  assert.deepEqual(h.family('familyResendVerification',{email:EMAIL}),h.family('familyResendVerification',{email:'absent@example.invalid'}));
  const next=h.latestChallenge();assert.notEqual(next,challenge);
  assert.ok(h.family('familyVerify',{challenge:next}).ok);
  assert.ok(h.family('familyCompleteRegistration',{challenge:next,pass:PASS}).ok);
  assert.equal(account().status,'active');
});
test('legacy pending password can finish new flow without recreating account or students',()=>{
  const {h,c,challenge}=fixture(),ctx=h.context(),a=ctx.familyAccount_(c.family.id);
  a.passSalt=ctx.parentSecret_();a.passHash=ctx.parentPasswordHash_('Old legacy password!',a.passSalt);a.inviteHash='';ctx.familySave_(a);
  assert.ok(h.family('familyVerify',{challenge}).passwordRequired);
  assert.ok(h.family('familyCompleteRegistration',{challenge,pass:PASS}).ok);
  assert.ok(h.family('familyLogin',{email:EMAIL,pass:PASS}).ftoken);
  assert.ok(h.family('familyLogin',{email:EMAIL,pass:'Old legacy password!'}).error);
  assert.equal(h.rows('familyAccounts').length,1);
});
test('disable, re-enable and invitation reissue do not activate unfinished signup',()=>{
  const {h,c,challenge,account}=fixture();h.family('familyVerify',{challenge});
  h.admin('familySetActive',{familyId:c.family.id,active:false});h.admin('familySetActive',{familyId:c.family.id,active:true});
  assert.equal(account().status,'pending');assert.ok(h.family('familyCompleteRegistration',{challenge,pass:PASS}).error);
  const next=h.admin('familyInvite',{familyId:c.family.id});assert.ok(next.ok);h.advance(61000);
  assert.ok(h.family('familyRegister',{inviteCode:next.inviteCode,email:EMAIL}).ok);
});
test('password setup rejects wrong-purpose, altered and expired proofs',()=>{
  const {h,challenge}=fixture();assert.ok(h.family('familyVerify',{challenge}).ok);
  assert.ok(h.family('familyCompleteRegistration',{challenge:challenge+'x',pass:PASS}).error);
  h.advance(31*60000);assert.ok(h.family('familyCompleteRegistration',{challenge,pass:PASS}).error);
});

test('confirmation address comes from a valid proof without activating, consuming or changing the account',()=>{
 const {h,c,challenge,account}=fixture();const before=JSON.stringify(account()),proofs=JSON.stringify(h.rows('familyChallenges'));
 const info=h.family('familyVerificationInfo',{challenge,email:'attacker@example.invalid'});
 assert.equal(info.email,EMAIL);assert.equal(info.registration,true);assert.equal(info.verified,undefined);
 assert.equal(JSON.stringify(account()),before);assert.equal(JSON.stringify(h.rows('familyChallenges')),proofs);
 assert.ok(h.family('familyCompleteRegistration',{challenge,pass:PASS}).error);
 const bad=h.family('familyVerificationInfo',{challenge:'invalid'});assert.equal(bad.verificationUnavailable,true);assert.equal(bad.email,undefined);
 h.family('familyVerify',{challenge});h.family('familyCompleteRegistration',{challenge,pass:PASS});
 assert.equal(h.family('familyVerificationInfo',{challenge}).verificationUnavailable,true);
 h.family('familyResetRequest',{email:EMAIL});assert.equal(h.family('familyVerificationInfo',{challenge:h.latestChallenge('reset')}).verificationUnavailable,true);
});
