/**
 * AES-256-GCM encryption/decryption for sensitive site_settings values.
 *
 * - Encrypted values are stored as  "enc:<iv>:<authTag>:<ciphertext>"  (all hex).
 * - If the ENCRYPTION_KEY env var is missing the server refuses to start.
 * - `isSecretKey()` tells whether a given setting_key should be encrypted.
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 128-bit IV
const AUTH_TAG_LENGTH = 16;
const PREFIX = 'enc:';

// ─── Key from env ─────────────────────────────────────────────
const _hexKey = process.env.ENCRYPTION_KEY;
if (!_hexKey || _hexKey.length !== 64) {
  console.error(
    '\x1b[31m[FATAL] ENCRYPTION_KEY must be set as a 64-char hex string (256 bits) in .env.local\x1b[0m'
  );
  process.exit(1);
}
const KEY = Buffer.from(_hexKey, 'hex'); // 32 bytes

// ─── Which keys are considered secrets ────────────────────────
const SECRET_SETTING_KEYS = new Set([
  'stripe_secret_key',
  'stripe_webhook_secret',
  'email_smtp_pass',
  'fb_page_access_token',
]);

/** Return true if this setting_key should be stored encrypted. */
export function isSecretKey(key: string): boolean {
  return SECRET_SETTING_KEYS.has(key);
}

// ─── Encrypt ──────────────────────────────────────────────────
/** Encrypt plaintext → "enc:<iv>:<tag>:<ciphertext>" (hex). */
export function encrypt(plaintext: string): string {
  if (!plaintext) return plaintext; // don't encrypt empty strings
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

// ─── Decrypt ──────────────────────────────────────────────────
/** Decrypt an "enc:..." string back to plaintext. If the value is not encrypted, return as-is. */
export function decrypt(value: string): string {
  if (!value || !value.startsWith(PREFIX)) return value; // already plaintext (legacy)
  try {
    const parts = value.slice(PREFIX.length).split(':');
    if (parts.length !== 3) return value;
    const [ivHex, tagHex, cipherHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(tagHex, 'hex');
    const ciphertext = Buffer.from(cipherHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    // If decryption fails (wrong key, corrupted data), return raw to avoid crash
    console.error('[crypto] Decryption failed for a secret value — returning raw.');
    return value;
  }
}

/**
 * Given a settings record (key → value), decrypt any secret values in-place
 * and return the same object.
 */
export function decryptSettings(settings: Record<string, string>): Record<string, string> {
  for (const key of Object.keys(settings)) {
    if (isSecretKey(key)) {
      settings[key] = decrypt(settings[key]);
    }
  }
  return settings;
}
