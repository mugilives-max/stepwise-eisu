// Temporarily stage in the Apps Script editor; never include in a public version.
// Uses real GAS Utilities and bundled PBKDF2, but no real property/account/ledger.
function stepwiseNativeParentCryptoCheck() {
  var originalKey = syncKey_, originalOwner = workerOwnsLedger_;
  var originalSchema = ensureSchema_, originalSync = syncPush_;
  var key = 'synthetic-parent-crypto-verification-key', results = [], touched = 0;
  function check(ok, label) { if (!ok) throw new Error('Synthetic check failed: ' + label); results.push(label); }
  function call(req) { return JSON.parse(doPost({postData:{contents:JSON.stringify(req)}}).getContent()); }
  try {
    syncKey_ = function() { return key; };
    workerOwnsLedger_ = function() { return true; };
    ensureSchema_ = syncPush_ = function() { touched++; throw new Error('Ledger forbidden'); };
    var samples = [
      [' Synthetic parent password! ', 'salt-123', '6b6ed77283df7fec3404eed882562b9ab55b4dabfced04be80093602c0f0beb3'],
      [' 日本語のパスワード🔑 ', 'ソルト', 'f223df86e1093d72eff7ef75c1e0836a6079a0af4c5b219e9af8fa6140c4bde3']
    ];
    var timings = [];
    samples.forEach(function(s, i) {
      var req = {action:'parentCrypto',key:key,iterations:600000,passBytes:Utilities.base64Encode(Utilities.newBlob(s[0]).getBytes()),saltBytes:Utilities.base64Encode(Utilities.newBlob(s[1]).getBytes())};
      var bad = Object.assign({}, req, {key:'invalid'});
      check(call(bad).badAuth === true, 'reject key ' + i);
      var start = Date.now(), out = call(req); timings.push(Date.now()-start);
      check(out.ok === true && out.derived === s[2], '600000 UTF8 vector ' + i);
      check(!!call(Object.assign({},req,{iterations:100000})).error, 'reject weaker rounds ' + i);
      check(!!call(Object.assign({},req,{passBytes:'!bad'})).error, 'reject encoding ' + i);
    });
    check(touched === 0, 'no ledger/schema/sync');
    var summary = {ok:true,passed:results.length,checks:results,timings:timings,noAccountOrPropertyAccess:true};
    console.log(JSON.stringify(summary));
    return summary;
  } finally {
    syncKey_=originalKey;workerOwnsLedger_=originalOwner;ensureSchema_=originalSchema;syncPush_=originalSync;
  }
}
