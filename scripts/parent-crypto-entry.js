// Byte arrays are supplied by GAS Utilities.newBlob so TextEncoder is not required.
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
export function derive(passwordBytes, saltBytes, iterations) {
  return bytesToHex(pbkdf2(sha256, passwordBytes, saltBytes, { c: iterations, dkLen: 32 }));
}
