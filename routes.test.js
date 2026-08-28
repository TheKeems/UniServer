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

    // `isAdmin` used to stand in here for "a field that does not exist". It
    // exists now, which makes this assertion stronger rather than weaker: the
    // client sent `true`, the schema default is `false`, and false is what got
    // stored. Privilege is granted by hand in the database and no route sets it
    // — see the note on the field in models.js.
    assert.equal(raw.isAdmin, false)
    // Still nothing identifying, ever. An email is not a field this service has.
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

/* --------------------------------------------------------------- the map --- */

describe('/api/map', () => {
  it('reports no provider when none is configured, rather than failing', async (t) => {
    if (!available) return t.skip()
    // The client uses this to decide whether to draw a real map at all. "No" has
    // to be an ordinary answer: the SVG fallback is what a student sees, and it
    // also covers a provider outage, so it must work either way.
    const { status, body } = await call('/api/map/config')
    assert.equal(status, 200)
    assert.equal(body.available, false)
    assert.ok(body.attribution)
  })

  it('answers 503 for a tile when no provider is configured', async (t) => {
    if (!available) return t.skip()
    const { status, body } = await call('/api/map/tiles/10/100/200')
    assert.equal(status, 503)
    assert.equal(body.error.code, 'tiles_not_configured')
  })

  it('refuses a nonsense tile coordinate before anything is fetched', async (t) => {
    if (!available) return t.skip()
    process.env.TILE_URL_TEMPLATE = 'https://tiles.invalid/{z}/{x}/{y}.png'
    try {
      for (const path of [
        '/api/map/tiles/99/1/1',
        '/api/map/tiles/1/9/1',
        '/api/map/tiles/abc/1/1',
        '/api/map/tiles/1/0x10/1',
      ]) {
        const { status, body } = await call(path)
        assert.equal(status, 400, path)
        assert.equal(body.error.code, 'bad_tile', path)
      }
    } finally {
      delete process.env.TILE_URL_TEMPLATE
    }
  })

  it('serves the map even while the database is unreachable', async (t) => {
    if (!available) return t.skip()
    // Mounted above the "everything below needs the database" gate on purpose:
    // a sleeping Atlas should cost you your shortlist, not the basemap.
    const { status } = await call('/api/map/config')
    assert.equal(status, 200)
  })
})

/* ----------------------------------------------------------- universities --- */

/** Promote an account the only way the service allows: straight in the database. */
async function makeAdmin(username) {
  const { Account } = await import('./models.js')
  await Account.updateOne({ usernameKey: username.toLowerCase() }, { $set: { isAdmin: true } })
}

describe('/api/universities', () => {
  it('is readable by anyone, because every student needs it', async (t) => {
    if (!available) return t.skip()
    const { status, body } = await call('/api/universities')
    assert.equal(status, 200)
    assert.ok(Array.isArray(body.universities))
  })

  it('tells a signed-in account whether it is an admin', async (t) => {
    if (!available) return t.skip()
    const { account, token, username } = await signedUp()
    assert.equal(account.isAdmin, false)

    await makeAdmin(username)
    const { body } = await call('/api/auth/me', { token })
    assert.equal(body.account.isAdmin, true)
  })

  // Two independent locks: the body is rebuilt field by field, and the schema is
  // strict. Worth testing because it is the whole privilege model.
  it('cannot be granted by asking for it at signup', async (t) => {
    if (!available) return t.skip()
    const username = someone()
    const { body } = await call('/api/auth/signup', {
      method: 'POST',
      body: { username, password: 'a good long password', isAdmin: true },
    })
    assert.equal(body.account.isAdmin, false)

    const me = await call('/api/auth/me', { token: body.token })
    assert.equal(me.body.account.isAdmin, false)
  })

  it('refuses a write with no token at all', async (t) => {
    if (!available) return t.skip()
    const { status } = await call('/api/universities/waterloo', {
      method: 'PUT',
      body: { description: 'nope' },
    })
    assert.equal(status, 401)
  })

  // A 404 rather than a 403, deliberately: a 403 confirms the route is real and
  // that admin accounts exist to be found.
  it('hides the route from an ordinary signed-in account', async (t) => {
    if (!available) return t.skip()
    const { token } = await signedUp()
    const { status, body } = await call('/api/universities/waterloo', {
      method: 'PUT',
      token,
      body: { description: 'nope' },
    })
    assert.equal(status, 404)
    assert.equal(body.error.code, 'not_found')

    const after = await call('/api/universities')
    assert.ok(!after.body.universities.some((u) => u.description === 'nope'))
  })

  it('lets an admin write, and everyone read it back', async (t) => {
    if (!available) return t.skip()
    const { token, username } = await signedUp()
    await makeAdmin(username)

    const put = await call('/api/universities/waterloo', {
      method: 'PUT',
      token,
      body: {
        description: 'A big school in Waterloo.',
        blurb: 'Co-op capital.',
        links: [{ label: 'Admissions', url: 'https://uwaterloo.ca/admissions' }],
      },
    })
    assert.equal(put.status, 200)
    assert.equal(put.body.university.description, 'A big school in Waterloo.')
    // Accountability, not attribution: never shown to a student.
    assert.equal(put.body.university.updatedBy, username)

    const { body } = await call('/api/universities')
    const waterloo = body.universities.find((u) => u.universityId === 'waterloo')
    assert.equal(waterloo.blurb, 'Co-op capital.')
    assert.equal(waterloo.links[0].url, 'https://uwaterloo.ca/admissions')
  })

  it('replaces rather than merges, like the profile route', async (t) => {
    if (!available) return t.skip()
    const { token, username } = await signedUp()
    await makeAdmin(username)

    await call('/api/universities/queens', {
      method: 'PUT',
      token,
      body: { description: 'first', blurb: 'a blurb' },
    })
    await call('/api/universities/queens', { method: 'PUT', token, body: { description: 'second' } })

    const { body } = await call('/api/universities')
    const queens = body.universities.find((u) => u.universityId === 'queens')
    assert.equal(queens.description, 'second')
    assert.equal(queens.blurb, '')
  })

  it('refuses an id that could reach the query as an operator', async (t) => {
    if (!available) return t.skip()
    const { token, username } = await signedUp()
    await makeAdmin(username)

    for (const id of ['Waterloo', 'a.b', '$ne']) {
      const { status, body } = await call(`/api/universities/${encodeURIComponent(id)}`, {
        method: 'PUT',
        token,
        body: { description: 'x' },
      })
      assert.equal(status, 400, id)
      assert.equal(body.error.code, 'invalid_university', id)
    }
  })

  it('refuses a link that would execute rather than navigate', async (t) => {
    if (!available) return t.skip()
    const { token, username } = await signedUp()
    await makeAdmin(username)

    const { status, body } = await call('/api/universities/western', {
      method: 'PUT',
      token,
      body: { links: [{ label: 'Apply', url: 'javascript:alert(1)' }] },
    })
    assert.equal(status, 400)
    assert.equal(body.error.code, 'invalid_content')
  })

  it('lets an admin delete a record back to "nobody has written this yet"', async (t) => {
    if (!available) return t.skip()
    const { token, username } = await signedUp()
    await makeAdmin(username)

    await call('/api/universities/guelph', { method: 'PUT', token, body: { description: 'x' } })
    const del = await call('/api/universities/guelph', { method: 'DELETE', token })
    assert.equal(del.status, 204)

    const { body } = await call('/api/universities')
    assert.ok(!body.universities.some((u) => u.universityId === 'guelph'))
  })

  it('will not let an ordinary account delete', async (t) => {
    if (!available) return t.skip()
    const { token: adminToken, username } = await signedUp()
    await makeAdmin(username)
    await call('/api/universities/trent', {
      method: 'PUT',
      token: adminToken,
      body: { description: 'keep' },
    })

    const { token } = await signedUp()
    const { status } = await call('/api/universities/trent', { method: 'DELETE', token })
    assert.equal(status, 404)

    const { body } = await call('/api/universities')
    assert.ok(body.universities.some((u) => u.universityId === 'trent'))
  })
})

/* -------------------------------------------- the three new survey answers --- */

describe('the survey answers added on 2026-08-27', () => {
  it('round-trips home city, co-op and graduating year', async (t) => {
    if (!available) return t.skip()
    // The failure this guards against: an answer accepted by the API, dropped on
    // the way into Mongo, and erased from the device on the next sign-in
    // somewhere else. Silent in every log.
    const { token } = await signedUp()
    await call('/api/profile', {
      method: 'PUT',
      token,
      body: {
        answers: {
          field: 'engineering',
          province: 'ON',
          average: 88,
          ambition: 'balanced',
          homeCity: 'Mississauga',
          coop: 'yes',
          gradYear: 2027,
        },
      },
    })

    const { body } = await call('/api/profile', { token })
    assert.equal(body.profile.answers.homeCity, 'Mississauga')
    assert.equal(body.profile.answers.coop, 'yes')
    assert.equal(body.profile.answers.gradYear, 2027)
  })

  it('keeps a skipped answer as its no-preference value', async (t) => {
    if (!available) return t.skip()
    const { token } = await signedUp()
    await call('/api/profile', { method: 'PUT', token, body: { answers: { field: '' } } })
    const { body } = await call('/api/profile', { token })
    assert.equal(body.profile.answers.homeCity, '')
    assert.equal(body.profile.answers.coop, '')
    assert.equal(body.profile.answers.gradYear, null)
  })
})

/* ------------------------------------- what the public listing gives away --- */

describe('GET /api/universities does not publish who the admins are', () => {
  it('omits updatedBy for an anonymous reader', async (t) => {
    if (!available) return t.skip()
    const { token, username } = await signedUp()
    await makeAdmin(username)
    await call('/api/universities/brock', { method: 'PUT', token, body: { description: 'x' } })

    const { body } = await call('/api/universities')
    const brock = body.universities.find((u) => u.universityId === 'brock')
    // updatedBy is an admin's username. Publishing it to every student hands
    // out the list of accounts worth attacking, and undoes the reason
    // requireAdmin answers 404 rather than 403.
    assert.ok(brock)
    assert.equal(brock.updatedBy, undefined)
    // updatedAt stays: "last checked in March" is useful and names nobody.
    assert.ok(brock.updatedAt)
  })

  it('omits it for a signed-in ordinary account too', async (t) => {
    if (!available) return t.skip()
    const { token: adminToken, username } = await signedUp()
    await makeAdmin(username)
    await call('/api/universities/windsor', { method: 'PUT', token: adminToken, body: { description: 'x' } })

    const { token } = await signedUp()
    const { body } = await call('/api/universities', { token })
    const windsor = body.universities.find((u) => u.universityId === 'windsor')
    assert.equal(windsor.updatedBy, undefined)
  })

  it('includes it for an admin, which is what the panel needs', async (t) => {
    if (!available) return t.skip()
    const { token, username } = await signedUp()
    await makeAdmin(username)
    await call('/api/universities/lakehead', { method: 'PUT', token, body: { description: 'x' } })

    const { body } = await call('/api/universities', { token })
    const lakehead = body.universities.find((u) => u.universityId === 'lakehead')
    assert.equal(lakehead.updatedBy, username)
  })
})

describe('the university id is what gets stored', () => {
  it('trims before storing, so a padded id cannot make an orphan document', async (t) => {
    if (!available) return t.skip()
    // universityIdProblem validates the TRIMMED value. Storing the raw one let
    // " nipissing" pass the check and then sit in the collection under an id no
    // university has — copy that looks like it failed to appear.
    const { token, username } = await signedUp()
    await makeAdmin(username)

    const { status } = await call('/api/universities/%20nipissing', {
      method: 'PUT',
      token,
      body: { description: 'padded' },
    })
    assert.equal(status, 200)

    const { body } = await call('/api/universities')
    assert.ok(body.universities.some((u) => u.universityId === 'nipissing'))
    assert.ok(!body.universities.some((u) => u.universityId !== u.universityId.trim()))
  })
})

describe('the admin refusal is indistinguishable from a real miss', () => {
  it('matches the app-level 404 body exactly', async (t) => {
    if (!available) return t.skip()
    // A 404 that is one character different from a genuine 404 announces that
    // the route exists and that admin accounts are worth hunting for.
    const { token } = await signedUp()
    const refused = await call('/api/universities/carleton', {
      method: 'PUT',
      token,
      body: { description: 'x' },
    })
    const genuine = await call('/api/nothing-here/carleton', {
      method: 'PUT',
      token,
      body: { description: 'x' },
    })

    assert.equal(refused.status, 404)
    assert.equal(genuine.status, 404)
    assert.equal(refused.body.error.code, genuine.body.error.code)
    assert.equal(
      refused.body.error.message,
      'No route for PUT /api/universities/carleton.',
    )
    assert.equal(genuine.body.error.message, 'No route for PUT /api/nothing-here/carleton.')
  })
})
