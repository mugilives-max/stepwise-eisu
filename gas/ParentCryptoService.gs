// Worker-only password computation. Never reads/writes an account or logs inputs.
// Existing hashes, PBKDF2 work factor, authentication and lockouts stay unchanged.
function parentCryptoOp_(req) {
  var key = syncKey_();
  if (!key || key.length < 24 || !req || typeof req.key !== 'string' || req.key.length > 256 || !parentEqual_(req.key, key)) return { error: '鍵が正しくありません', badAuth: true };
  if (!workerOwnsLedger_() || req.iterations !== 600000) return { error: 'この計算は利用できません' };
  function decode(value, max) {
    if (typeof value !== 'string' || !value.length || value.length > Math.ceil(max / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid input');
    var bytes = Utilities.base64Decode(value);
    if (!bytes.length || bytes.length > max || Utilities.base64Encode(bytes) !== value) throw new Error('Invalid input');
    return new Uint8Array(bytes.map(function(v) { return (v + 256) % 256; }));
  }
  try {
    var pass = decode(req.passBytes, 512), salt = decode(req.saltBytes, 256);
    return { ok: true, derived: StepwiseParentCrypto.derive(pass, salt, 600000) };
  } catch (e) {
    return { error: 'パスワードの計算を完了できませんでした' };
  }
}
