import { pbkdf2Sync } from 'node:crypto';
import { Buffer } from 'node:buffer';

// Workers' hosted runtime rejects native PBKDF2 above 100,000 iterations even
// when Node and local workerd accept it. Preserve the existing 600,000-round
// hash by delegating computation to the existing, authenticated GAS service.
// No passwords/hashes go into the effects queue, logs or persistent cache.
export function parentCrypto(fallback, nativeDerive = pbkdf2Sync) {
  return {
    derive(pass, salt, iterations) {
      try {
        return nativeDerive(Buffer.from(pass), Buffer.from(salt), iterations, 32, 'sha256').toString('hex');
      } catch (error) {
        if (error?.name !== 'NotSupportedError' || !/^Pbkdf2 failed: iteration counts above \d+ are not supported \(requested \d+\)\.?$/.test(String(error.message))) throw error;
        return fallback.derive(pass, salt, iterations);
      }
    },
  };
}

export function parentCryptoSession(env, { nativeDerive = pbkdf2Sync, fetcher = fetch } = {}) {
  const memo = new Map();
  let pending = null;
  return {
    crypto: parentCrypto({ derive(pass, salt, iterations) {
      if (iterations !== 600000 || pass.length > 512 || salt.length > 256) throw Error('Unsupported password derivation');
      const input = { passBytes: Buffer.from(pass).toString('base64'), saltBytes: Buffer.from(salt).toString('base64'), iterations };
      const id = JSON.stringify(input);
      if (memo.has(id)) return memo.get(id);
      pending = { id, input };
      // GAS catches this exception. runWrite discards this speculative run,
      // obtains the hash, then reloads D1 and repeats all authorization checks.
      throw Error('Password computation pending');
    } }, nativeDerive),
    get pending() { return pending !== null; },
    async resolve() {
      if (!pending) return;
      const request = pending; pending = null;
      if (typeof env.SYNC_KEY !== 'string' || env.SYNC_KEY.length < 24 || !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(env.GAS_URL || '')) throw Error('Password computation service unavailable');
      let data;
      try {
        const response = await fetcher(env.GAS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'parentCrypto', key: env.SYNC_KEY, ...request.input }), signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw Error('Service unavailable');
        data = await response.json();
      } catch { throw Error('Password computation service unavailable'); }
      if (data?.ok !== true || !/^[a-f0-9]{64}$/.test(data.derived || '')) throw Error('Password computation service unavailable');
      memo.set(request.id, data.derived);
    },
  };
}
