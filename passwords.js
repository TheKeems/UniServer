// Password hashing. The one file in this service that must not be got wrong.
//
// THE RULE: a password arrives over TLS in a request body, is hashed here, and
// the hash is what MongoDB stores. The plaintext is never written to the
// database, never written to a log, and never sent back to a client. If you are
// adding a field to the Account model and it is called anything like `password`,
// stop and read this comment again.
//
// scrypt, from node's own crypto module, rather than bcrypt. Two reasons: it
// needs no dependency at all (nothing to audit, nothing to fail a native build
// on Render's free tier), and it is memory-hard, so a stolen database is
// expensive to attack with a GPU in a way that plain PBKDF2 is not.
//
// The parameters live inside each stored string, so raising the cost later does
// not lock out accounts created today: `verify` reads the cost the hash was
// made with, and `needsRehash` tells a caller when to quietly upgrade one.

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)

// N=16384, r=8, p=1 costs 128 * N * r = 16MB of memory per hash, which fits
// inside node's default 32MB scrypt ceiling and inside a 512MB Render instance
// even with a few signups landing at once. Raise N (in powers of two) before
// touching anything else here.
const COST = { N: 16_384, r: 8, p: 1 }
const KEY_BYTES = 64
const SALT_BYTES = 16

/** Upper bound on what we will even attempt to hash — see routes.js. */
export const PASSWORD_MAX = 200

/**
 * Hash a password into a self-describing string:
 *
 *   scrypt$16384$8$1$<base64 salt>$<base64 key>
 *
 * Everything needed to verify it later is in the string, which is why the
 * Account model stores one field rather than five.
 */
export async function hashPassword(password) {
  assertHashable(password)
  const salt = randomBytes(SALT_BYTES)
  const key = await scrypt(password, salt, KEY_BYTES, COST)
  return [
    'scrypt',
    COST.N,
    COST.r,
    COST.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$')
}

/**
 * Check a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed stored value: a corrupted
 * row should fail one login, not 500 the endpoint for everyone.
 */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false
  if (password.length === 0 || password.length > PASSWORD_MAX) return false

  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const [, rawN, rawR, rawP, rawSalt, rawKey] = parts
  const N = Number(rawN)
  const r = Number(rawR)
  const p = Number(rawP)
  // A hostile or corrupted row could otherwise ask node to allocate an absurd
  // amount of memory on every login attempt.
  if (!isSaneCost(N, r, p)) return false

  let expected
  let actual
  try {
    expected = Buffer.from(rawKey, 'base64')
    actual = await scrypt(password, Buffer.from(rawSalt, 'base64'), expected.length, {
      N,
      r,
      p,
      // 128 * N * r, with headroom, or node refuses anything above its default.
      maxmem: 256 * N * r,
    })
  } catch {
    return false
  }

  // Constant-time: comparing with === leaks how many leading bytes matched,
  // which is enough to attack a hash offline one byte at a time.
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** True when a stored hash was made with a weaker cost than we now use. */
export function needsRehash(stored) {
  if (typeof stored !== 'string') return true
  const [scheme, N, r, p] = stored.split('$')
  return scheme !== 'scrypt' || Number(N) < COST.N || Number(r) < COST.r || Number(p) < COST.p
}

function isSaneCost(N, r, p) {
  return (
    Number.isInteger(N) &&
    Number.isInteger(r) &&
    Number.isInteger(p) &&
    N >= 1024 &&
    N <= 1_048_576 &&
    // A power of two, which scrypt requires of N.
    (N & (N - 1)) === 0 &&
    r >= 1 &&
    r <= 32 &&
    p >= 1 &&
    p <= 16
  )
}

function assertHashable(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('hashPassword needs a non-empty string')
  }
  // Unbounded input into a memory-hard function is a free way to stall the
  // event loop; the route rejects long passwords before this, and this is the
  // backstop for a future caller that forgets to.
  if (password.length > PASSWORD_MAX) {
    throw new Error(`hashPassword refuses input longer than ${PASSWORD_MAX} characters`)
  }
}
