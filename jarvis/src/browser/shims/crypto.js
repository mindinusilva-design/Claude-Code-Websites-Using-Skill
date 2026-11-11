// Browser stand-in for node:crypto. Only randomness is needed in the page;
// at-rest encryption is done with Web Crypto in src/browser/store.js.
class Bytes extends Uint8Array {
  toString(encoding = 'hex') {
    if (encoding === 'hex') return [...this].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (encoding === 'base64') return btoa(String.fromCharCode(...this));
    return new TextDecoder().decode(this);
  }
}
export function randomBytes(n) {
  const bytes = new Bytes(n);
  crypto.getRandomValues(bytes);
  return bytes;
}
export function randomUUID() { return crypto.randomUUID(); }
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}
const unavailable = (name) => () => { throw new Error(`${name} is not available in the standalone page`); };
export const createHash = unavailable('createHash');
export const createCipheriv = unavailable('createCipheriv');
export const createDecipheriv = unavailable('createDecipheriv');
export const scryptSync = unavailable('scryptSync');
export default { randomBytes, randomUUID, timingSafeEqual, createHash, createCipheriv, createDecipheriv, scryptSync };
