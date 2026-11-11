import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const PREFIX = 'enc:v1:';

export function generateSalt() {
  return randomBytes(16);
}

export function deriveKey(secret, salt) {
  return scryptSync(String(secret), salt, 32, { N: 2 ** 14, r: 8, p: 1 });
}

/**
 * AES-256-GCM cipher suite. Every blob carries its own random IV and an
 * authentication tag, so tampering is detected on decrypt.
 */
export function createCipherSuite({ secret, salt }) {
  if (!secret) throw new Error('createCipherSuite: a secret is required');
  const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt), 'base64');
  const key = deriveKey(secret, saltBuffer);

  return {
    encrypt(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const plaintext = Buffer.from(JSON.stringify(value ?? null), 'utf8');
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      return PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64');
    },
    decrypt(blob) {
      if (!this.isEncrypted(blob)) throw new Error('decrypt: value is not an encrypted blob');
      const buffer = Buffer.from(blob.slice(PREFIX.length), 'base64');
      const iv = buffer.subarray(0, 12);
      const tag = buffer.subarray(12, 28);
      const data = buffer.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
      return JSON.parse(decrypted.toString('utf8'));
    },
    isEncrypted(value) {
      return typeof value === 'string' && value.startsWith(PREFIX);
    },
  };
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
