// Session tokens.
//
// A signed JWT carrying nothing but the account id and an expiry. No username,
// no survey answers: a token ends up in localStorage on a shared computer, and
// anything in its payload is readable by anyone who can open devtools, because
// the signature protects it from being *changed*, not from being *read*.
//
// Stateless on purpose — there is no sessions collection to keep in step, and a
// sleeping Render instance holds no state to lose. The cost of that choice is
// that a token cannot be revoked before it expires, which is why the expiry is
// weeks rather than months, and why changing a password does not hand out a new
// one silently (see routes.js).

import jwt from 'jsonwebtoken'

const ALGORITHM = 'HS256'
const TTL = '30d'

/**
 * The signing secret.
 *
 * Read lazily rather than at import time so a missing variable surfaces as a
 * clear startup error from index.js instead of a module that half-loaded.
 */
function secret() {
  const value = process.env.JWT_SECRET
  if (!value || value.length < 32) {
    throw new Error(
      'JWT_SECRET must be set to at least 32 random characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
    )
  }
  return value
}

/** True when the environment is configured well enough to sign tokens. */
export function canSign() {
  try {
    secret()
    return true
  } catch {
    return false
  }
}

export function signToken(accountId) {
  return jwt.sign({ sub: String(accountId) }, secret(), { algorithm: ALGORITHM, expiresIn: TTL })
}

/**
 * The account id a token vouches for, or null.
 *
 * Null covers every failure — expired, tampered with, signed with an old secret,
 * or not a token at all. Callers turn that into one 401; the client does not get
 * to learn which of those it was.
 */
export function accountIdFromToken(token) {
  if (typeof token !== 'string' || !token) return null
  try {
    // algorithms is pinned. Without it, a token claiming alg: "none" is a
    // well-known way to walk straight past this check.
    const payload = jwt.verify(token, secret(), { algorithms: [ALGORITHM] })
    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

/** Pull a bearer token out of an Authorization header. */
export function bearerFrom(header) {
  if (typeof header !== 'string') return null
  const match = /^Bearer (.+)$/i.exec(header.trim())
  return match ? match[1] : null
}
