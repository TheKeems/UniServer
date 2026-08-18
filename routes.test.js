// End-to-end tests for the API, over a real socket against a real MongoDB.
//
//   npm test        (needs the mongodb-memory-server dev dependency)
//
// An in-memory mongod rather than mocks, because the things most likely to break
// here are the parts a mock would paper over: the unique index on usernameKey, the
// `select: false` on the password hash, and upsert behaviour on the profile route.
//
// Skips itself with a clear message when mongodb-memory-server is not installed,
// so `npm test` still runs the unit suites on a machine that has not downloaded a
// mongod binary.

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'

let mongod
let server
let base
let available = true

before(async () => {
  let MongoMemoryServer
  try {
    ;({ MongoMemoryServer } = await import('mongodb-memory-server'))
  } catch {
    available = false
    console.log('  (skipping API tests: npm i -D mongodb-memory-server to run them)')
    return
  }

  mongod = await MongoMemoryServer.create()
  process.env.MONGODB_URI = mongod.getUri()
  process.env.JWT_SECRET = 'test-secret-that-is-comfortably-long-enough'

  const { connectToMongo } = await import('./db.js')
  const { createApp } = await import('./app.js')
  await connectToMongo()

  // Port 0 = whatever is free, so the suite never collides with a dev server.
  server = createApp().listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect()
  if (mongod) await mongod.stop()
})

/* ---------------------------------------------------------------- helpers --- */

let counter = 0

/**
 * One request.
 *
 * Every call gets its own X-Forwarded-For by default. The signup limiter allows
 * ten per hour per address, and this suite makes far more than ten accounts — so
 * without a distinct address per call the tests would spend most of their time
 * being correctly rate limited. Passing an explicit `ip` puts calls in the same
 * bucket, which is how the limiter itself is tested.
 *
 * That this works at all is the `trust proxy` line in app.js doing its job: on
 * Render the real client address arrives in exactly this header.
 */
async function call(path, { method = 'GET', body, token, ip } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'X-Forwarded-For': ip ?? `10.0.${Math.floor((counter += 1) / 250) % 250}.${counter % 250}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  }
}

/** A fresh username per test, so no test depends on another's leftovers. */
const someone = () => `student_${(counter += 1)}`

async function signedUp(username = someone(), password = 'a good long password') {
  const { body } = await call('/api/auth/signup', { method: 'POST', body: { username, password } })
  return { ...body, username, password }
}

/* ----------------------------------------------------------------- health --- */

describe('service', () => {
  it('answers something at the root instead of 404', async (t) => {
    if (!available) return t.skip()
    const { status, body } = await call('/')
    assert.equal(status, 200)
    assert.equal(body.ok, true)
  })

  it('reports the database as connected', async (t) => {
    if (!available) return t.skip()
    const { status, body } = await call('/api/health')
    assert.equal(status, 200)
    assert.equal(body.database, 'connected')
  })

  it('gives a JSON 404 rather than an HTML error page', async (t) => {
    if (!available) return t.skip()
    const { status, body } = await call('/api/nope')
    assert.equal(status, 404)
    assert.equal(body.error.code, 'not_found')
  })

  it('answers CORS preflight for a browser', async (t) => {
    if (!available) return t.skip()
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,authorization',
      },
    })
    assert.ok(response.status === 204 || response.status === 200)
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
  })

  it('rejects a body that is not JSON without a stack trace', async (t) => {
    if (!available) return t.skip()
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    })
    const body = await response.json()
    assert.equal(response.status, 400)
    assert.equal(body.error.code, 'bad_json')
    // No internals: a stack trace or a file path in a response body is how server
    // layout ends up in a bug-report screenshot.
    const serialised = JSON.stringify(body)
    for (const leak of ['SyntaxError', '.js:', 'node_modules', 'at Object', 'JSON.parse']) {
      assert.ok(!serialised.includes(leak), `must not leak "${leak}"`)
    }
  })
})

/* ----------------------------------------------------------------- signup --- */

describe('POST /api/auth/signup', () => {
  it('creates an account, a token and an empty profile', async (t) => {
    if (!available) return t.skip()
    const username = someone()
    const { status, body } = await call('/api/auth/signup', {
      method: 'POST',
      body: { username, password: 'a good long password' },
    })

    assert.equal(status, 201)
    assert.equal(body.account.username, username)
    assert.ok(body.token)
    assert.deepEqual(body.profile.shortlist, [])
    assert.equal(body.profile.answers, null)
  })

  it('never returns the password or its hash', async (t) => {
    if (!available) return t.skip()
    const { status, body } = await call('/api/auth/signup', {
      method: 'POST',
      body: { username: someone(), password: 'a good long password' },
    })
    assert.equal(status, 201)
    const serialised = JSON.stringify(body)
    assert.ok(!serialised.includes('a good long password'))
    assert.ok(!serialised.includes('passwordHash'))
    assert.ok(!serialised.includes('scrypt'))
  })

  it('stores a scrypt hash and no plaintext anywhere in the document', async (t) => {
    if (!available) return t.skip()
    const username = someone()
    await call('/api/auth/signup', {
      method: 'POST',
      body: { username, password: 'a good long password' },
    })

    // Straight to the collection, past mongoose's select: false.
    const raw = await mongoose.connection
      .collection('accounts')
      .findOne({ usernameKey: username.toLowerCase() })

    assert.ok(raw.passwordHash.startsWith('scrypt$'))
    assert.ok(!JSON.stringify(raw).includes('a good long password'))
    // And none of the fields the project refuses to collect.
    for (const forbidden of ['email', 'name', 'age', 'school', 'password']) {
      assert.ok(!(forbidden in raw), `must not store ${forbidden}`)
    }
  })

  it('refuses a duplicate username, ignoring case', async (t) => {
    if (!available) return t.skip()
    const username = someone()
    await call('/api/auth/signup', { method: 'POST', body: { username, password: 'a good long password' } })

    const { status, body } = await call('/api/auth/signup', {
      method: 'POST',
      body: { username: username.toUpperCase(), password: 'another long password' },
    })

    assert.equal(status, 409)
    assert.equal(body.error.code, 'username_taken')
  })

  it('holds the line when two signups for one name race', async (t) => {
    if (!available) return t.skip()
    // The exists() check cannot catch this; the unique index has to.
    const username = someone()
    const both = await Promise.all([
      call('/api/auth/signup', { method: 'POST', body: { username, password: 'a good long password' } }),
      call('/api/auth/signup', { method: 'POST', body: { username, password: 'a good long password' } }),
    ])

    const created = both.filter((r) => r.status === 201)
    const refused = both.filter((r) => r.status === 409)
    assert.equal(created.length, 1)
    assert.equal(refused.length, 1)
  })

  it('enforces the username and password rules server-side', async (t) => {
    if (!available) return t.skip()
    const bad = [
      { username: 'ab', password: 'a good long password', code: 'invalid_username' },
      { username: 'has space', password: 'a good long password', code: 'invalid_username' },
      { username: someone(), password: 'short', code: 'invalid_password' },
      { username: someone(), password: 'password123', code: 'invalid_password' },
      { username: someone(), password: 'x'.repeat(201), code: 'invalid_password' },
    ]
    for (const { username, password, code } of bad) {
      const { status, body } = await call('/api/auth/signup', { method: 'POST', body: { username, password } })
      assert.equal(status, 400, `${username}/${password}`)
      assert.equal(body.error.code, code)
    }
  })

  it('ignores extra fields a client tries to smuggle in', async (t) => {
    if (!available) return t.skip()
    const username = someone()
    await call('/api/auth/signup', {
      method: 'POST',
      body: { username, password: 'a good long password', isAdmin: true, email: 'a@b.c' },
    })

    const raw = await mongoose.connection
      .collection('accounts')
      .findOne({ usernameKey: username.toLowerCase() })
    assert.ok(!('isAdmin' in raw))
    assert.ok(!('email' in raw))
  })
})

/* ---------------------------------------------------------- rate limiting --- */

describe('rate limiting', () => {
  it('stops one address making accounts endlessly', async (t) => {
    if (!available) return t.skip()
    // The suite gives every other call its own forwarded address, so this is the
    // one place the limiter is exercised on purpose. Without it, the signup route
    // is an open invitation to fill the database.
    const ip = '203.0.113.7'
    const statuses = []
    for (let i = 0; i < 12; i += 1) {
      const { status } = await call('/api/auth/signup', {
        ip,
        method: 'POST',
        body: { username: someone(), password: 'a good long password' },
      })
      statuses.push(status)
    }

    assert.equal(statuses.filter((s) => s === 201).length, 10, 'ten allowed')
    assert.ok(statuses.slice(-2).every((s) => s === 429), 'then refused')
  })

  it('limits sign-in attempts too', async (t) => {
    if (!available) return t.skip()
    const ip = '203.0.113.8'
    const { username } = await signedUp()
    let limited = false
    for (let i = 0; i < 22; i += 1) {
      const { status } = await call('/api/auth/login', {
        ip,
        method: 'POST',
        body: { username, password: 'wrong but long enough' },
      })
      if (status === 429) {
        limited = true
        break
      }
    }
    assert.ok(limited, 'a password list should not be free to work through')
  })
})

/* ------------------------------------------------------------------ login --- */

describe('POST /api/auth/login', () => {
  it('signs in with the right password', async (t) => {
    if (!available) return t.skip()
    const { username, password } = await signedUp()

    const { status, body } = await call('/api/auth/login', { method: 'POST', body: { username, password } })

    assert.equal(status, 200)
    assert.ok(body.token)
    assert.equal(body.account.username, username)
  })

  it('accepts any capitalisation of the username', async (t) => {
    if (!available) return t.skip()
    const { username, password } = await signedUp()
    const { status } = await call('/api/auth/login', {
      method: 'POST',
      body: { username: username.toUpperCase(), password },
    })
    assert.equal(status, 200)
  })

  it('rejects a wrong password', async (t) => {
    if (!available) return t.skip()
    const { username } = await signedUp()
    const { status, body } = await call('/api/auth/login', {
      method: 'POST',
      body: { username, password: 'wrong but long enough' },
    })
    assert.equal(status, 401)
    assert.equal(body.error.code, 'invalid_credentials')
  })

  it('says exactly the same thing for an unknown username', async (t) => {
    if (!available) return t.skip()
    // Otherwise the endpoint hands out a list of which usernames exist.
    const { username } = await signedUp()
    const missing = await call('/api/auth/login', {
      method: 'POST',
      body: { username: 'nobody_here_at_all', password: 'a good long password' },
    })
    const wrong = await call('/api/auth/login', {
      method: 'POST',
      body: { username, password: 'wrong but long enough' },
    })

    assert.equal(missing.status, wrong.status)
    assert.deepEqual(missing.body, wrong.body)
  })

  it('does not enforce the signup rules on an existing account', async (t) => {
    if (!available) return t.skip()
    // Tightening the rules later must never lock someone out of their own data:
    // a short legacy username still has to be able to log in, and gets a
    // credentials error rather than a validation one.
    const { status, body } = await call('/api/auth/login', {
      method: 'POST',
      body: { username: 'ab', password: 'a good long password' },
    })
    assert.equal(status, 401)
    assert.equal(body.error.code, 'invalid_credentials')
  })

  it('returns the profile with the token', async (t) => {
    if (!available) return t.skip()
    const { token, username, password } = await signedUp()
    await call('/api/profile', {
      method: 'PUT',
      token,
      body: { shortlist: ['waterloo::se'], answers: { field: 'engineering', average: 88, ambition: 'reach' } },
    })

    const { body } = await call('/api/auth/login', { method: 'POST', body: { username, password } })

    assert.deepEqual(body.profile.shortlist, ['waterloo::se'])
    assert.equal(body.profile.answers.average, 88)
  })
})

/* -------------------------------------------------------------------- me --- */

describe('GET /api/auth/me', () => {
  it('names the account a token belongs to', async (t) => {
    if (!available) return t.skip()
    const { token, username } = await signedUp()
    const { status, body } = await call('/api/auth/me', { token })
    assert.equal(status, 200)
    assert.equal(body.account.username, username)
  })

  it('401s without a token, with rubbish, and with a tampered one', async (t) => {
    if (!available) return t.skip()
    const { token } = await signedUp()
    const tampered = `${token.slice(0, -4)}AAAA`

    for (const bad of [undefined, 'nonsense', tampered]) {
      const { status, body } = await call('/api/auth/me', { token: bad })
      assert.equal(status, 401, String(bad))
      assert.equal(body.error.code, 'unauthorized')
    }
  })

  it('401s for a token whose account has been deleted', async (t) => {
    if (!available) return t.skip()
    const { token } = await signedUp()
    await call('/api/account', { method: 'DELETE', token })

    const { status } = await call('/api/auth/me', { token })
    assert.equal(status, 401)
  })
})

/* -------------------------------------------------------------- password --- */

describe('POST /api/auth/password', () => {
  it('changes the password and invalidates the old one', async (t) => {
    if (!available) return t.skip()
    const { token, username, password } = await signedUp()

    const changed = await call('/api/auth/password', {
      method: 'POST',
      token,
      body: { currentPassword: password, newPassword: 'a completely different one' },
    })
    assert.equal(changed.status, 204)

    const withOld = await call('/api/auth/login', { method: 'POST', body: { username, password } })
    assert.equal(withOld.status, 401)

    const withNew = await call('/api/auth/login', {
      method: 'POST',
      body: { username, password: 'a completely different one' },
    })
    assert.equal(withNew.status, 200)
  })

  it('re-salts, so the stored hash changes even for the same password', async (t) => {
    if (!available) return t.skip()
    const { token, username, password } = await signedUp()
    const before = await mongoose.connection
      .collection('accounts')
      .findOne({ usernameKey: username.toLowerCase() })

    await call('/api/auth/password', {
      method: 'POST',
      token,
      body: { currentPassword: password, newPassword: 'a completely different one' },
    })

    const after = await mongoose.connection
      .collection('accounts')
      .findOne({ usernameKey: username.toLowerCase() })
    assert.notEqual(before.passwordHash, after.passwordHash)
  })

  it('needs the current password', async (t) => {
    if (!available) return t.skip()
    const { token } = await signedUp()
    const { status, body } = await call('/api/auth/password', {
      method: 'POST',
      token,
      body: { currentPassword: 'not it at all', newPassword: 'a completely different one' },
    })
    assert.equal(status, 403)
    assert.equal(body.error.code, 'wrong_password')
  })

  it('applies the password rules to the new one', async (t) => {
    if (!available) return t.skip()
    const { token, password } = await signedUp()
    for (const newPassword of ['short', 'password123', password]) {
      const { status, body } = await call('/api/auth/password', {
        method: 'POST',
        token,
        body: { currentPassword: password, newPassword },
      })
      assert.equal(status, 400, newPassword)
      assert.equal(body.error.code, 'invalid_password')
    }
  })

  it('needs a token', async (t) => {
    if (!available) return t.skip()
    const { status } = await call('/api/auth/password', {
      method: 'POST',
      body: { currentPassword: 'a good long password', newPassword: 'another long one' },
    })
    assert.equal(status, 401)
  })
})

/* --------------------------------------------------------------- profile --- */

describe('/api/profile', () => {
  it('round-trips everything the dashboard holds', async (t) => {
    if (!available) return t.skip()
    const { token } = await signedUp()
    const profile = {
      answers: { field: 'engineering', province: 'ON', average: 88, ambition: 'reach' },
      shortlist: ['waterloo::se', 'ubc::nursing'],
      courses: ['MHF4U', 'SCH4U'],
      notes: { 'waterloo::se': 'ask Mr Patel' },
      tags: { 'waterloo::se': ['reach', 'co-op'] },
      savedAt: '2026-08-18T10:00:00.000Z',
    }

    const put = await call('/api/profile', { method: 'PUT', token, body: profile })
    assert.equal(put.status, 200)

    const got = await call('/api/profile', { token })
    assert.equal(got.body.profile.answers.average, 88)
    assert.equal(got.body.profile.answers.ambition, 'reach')
    assert.deepEqual(got.body.profile.shortlist, profile.shortlist)
    assert.deepEqual(got.body.profile.courses, profile.courses)
    // notes and tags are arrays in Mongo and objects on the wire, because a
    // program id cannot be a Mongo key.
    assert.deepEqual(got.body.profile.notes, profile.notes)
    assert.deepEqual(got.body.profile.tags, profile.tags)
  })

  it('replaces rather than merges', async (t) => {
    if (!available) return t.skip()
    // PUT semantics: the device holds the working copy, so a merge would produce a
    // shortlist that is neither copy.
    const { token } = await signedUp()
    await call('/api/profile', { method: 'PUT', token, body: { shortlist: ['a', 'b'], courses: ['MHF4U'] } })
    await call('/api/profile', { method: 'PUT', token, body: { shortlist: ['c'] } })

    const { body } = await call('/api/profile', { token })
    assert.deepEqual(body.profile.shortlist, ['c'])
    assert.deepEqual(body.profile.courses, [])
  })

  it('keeps a skipped survey as null rather than an empty object', async (t) => {
    if (!available) return t.skip()
    const { token } = await signedUp()
    await call('/api/profile', { method: 'PUT', token, body: { answers: null, shortlist: ['a'] } })
    const { body } = await call('/api/profile', { token })
    assert.equal(body.profile.answers, null)
  })

  it('caps a hostile payload instead of storing it', async (t) => {
    if (!available) return t.skip()
    const { token } = await signedUp()
    const { status } = await call('/api/profile', {
      method: 'PUT',
      token,
      body: { shortlist: Array.from({ length: 2000 }, (_, i) => `p-${i}`) },
    })
    assert.equal(status, 200)

    const { body } = await call('/api/profile', { token })
    assert.equal(body.profile.shortlist.length, 500)
  })

  it('refuses a body far too large to be a profile', async (t) => {
    if (!available) return t.skip()
    const { token } = await signedUp()
    const { status } = await call('/api/profile', {
      method: 'PUT',
      token,
      body: { notes: { a: 'x'.repeat(200_000) } },
    })
    assert.equal(status, 413)
  })

  it('is private to its account', async (t) => {
    if (!available) return t.skip()
    const mine = await signedUp()
    const theirs = await signedUp()
    await call('/api/profile', { method: 'PUT', token: mine.token, body: { shortlist: ['mine'] } })

    const { body } = await call('/api/profile', { token: theirs.token })
    assert.deepEqual(body.profile.shortlist, [], 'must not see another account’s list')
  })

  it('needs a token for both reading and writing', async (t) => {
    if (!available) return t.skip()
    assert.equal((await call('/api/profile')).status, 401)
    assert.equal((await call('/api/profile', { method: 'PUT', body: { shortlist: [] } })).status, 401)
  })
})

/* --------------------------------------------------------------- account --- */

describe('DELETE /api/account', () => {
  it('removes the account and its profile', async (t) => {
    if (!available) return t.skip()
    const { token, username, password } = await signedUp()
    await call('/api/profile', { method: 'PUT', token, body: { shortlist: ['a'] } })

    const { status } = await call('/api/account', { method: 'DELETE', token })
    assert.equal(status, 204)

    assert.equal(
      await mongoose.connection.collection('accounts').countDocuments({ usernameKey: username.toLowerCase() }),
      0,
    )
    assert.equal((await call('/api/auth/login', { method: 'POST', body: { username, password } })).status, 401)
  })

  it('leaves other accounts alone', async (t) => {
    if (!available) return t.skip()
    const doomed = await signedUp()
    const kept = await signedUp()
    await call('/api/profile', { method: 'PUT', token: kept.token, body: { shortlist: ['keep'] } })

    await call('/api/account', { method: 'DELETE', token: doomed.token })

    const { body } = await call('/api/profile', { token: kept.token })
    assert.deepEqual(body.profile.shortlist, ['keep'])
  })

  it('frees the username for reuse', async (t) => {
    if (!available) return t.skip()
    const { token, username } = await signedUp()
    await call('/api/account', { method: 'DELETE', token })

    const { status } = await call('/api/auth/signup', {
      method: 'POST',
      body: { username, password: 'a good long password' },
    })
    assert.equal(status, 201)
  })

  it('needs a token', async (t) => {
    if (!available) return t.skip()
    assert.equal((await call('/api/account', { method: 'DELETE' })).status, 401)
  })
})

/* ------------------------------------------------------------- telemetry --- */

describe('POST /api/data', () => {
  it('still accepts an anonymous submission', async (t) => {
    if (!available) return t.skip()
    const { status, body } = await call('/api/data', {
      method: 'POST',
      body: {
        field: 'engineering',
        province: 'ON',
        averageBand: '85-89',
        ambition: 'balanced',
        matchCount: 12,
        submittedAt: new Date().toISOString(),
      },
    })
    assert.equal(status, 201)
    assert.equal(body.ok, true)
  })

  it('needs no token, and records none', async (t) => {
    if (!available) return t.skip()
    // The rows have to stay unlinkable to a person even though the service now
    // knows who some people are.
    const { token } = await signedUp()
    await call('/api/data', {
      method: 'POST',
      token,
      body: { field: 'health', province: 'BC', averageBand: '90-94', ambition: 'reach', matchCount: 3 },
    })

    const row = await mongoose.connection
      .collection('submissions')
      .findOne({}, { sort: { _id: -1 } })

    for (const forbidden of ['accountId', 'username', 'token', 'average']) {
      assert.ok(!(forbidden in row), `must not store ${forbidden}`)
    }
    assert.equal(row.averageBand, '90-94')
  })

  it('drops an exact average a client tries to add', async (t) => {
    if (!available) return t.skip()
    await call('/api/data', {
      method: 'POST',
      body: { field: 'health', averageBand: '90-94', average: 91, username: 'northstar' },
    })

    const row = await mongoose.connection.collection('submissions').findOne({}, { sort: { _id: -1 } })
    assert.ok(!('average' in row))
    assert.ok(!('username' in row))
  })
})
