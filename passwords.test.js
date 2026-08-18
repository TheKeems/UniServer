// Unit tests for the one file in this service that must not be got wrong.
//
//   node --test        (from server/)
//
// No database and no HTTP: these are pure functions, and the properties being
// checked here — a password never appears in its own hash, two identical
// passwords hash differently, a corrupted row fails closed — are the ones that
// would be expensive to discover in production.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword, needsRehash, verifyPassword } from './passwords.js'

describe('hashPassword', () => {
  it('produces a self-describing scrypt string', async () => {
    const hash = await hashPassword('a good long password')
    const parts = hash.split('$')
    assert.equal(parts.length, 6)
    assert.equal(parts[0], 'scrypt')
    // Everything needed to verify later is in the string, which is why the model
    // stores one field rather than five.
    assert.equal(Number(parts[1]), 16_384)
    assert.equal(Number(parts[2]), 8)
    assert.equal(Number(parts[3]), 1)
    assert.ok(parts[4].length > 0, 'salt')
    assert.ok(parts[5].length > 0, 'derived key')
  })

  it('never contains the password', async () => {
    const hash = await hashPassword('hunter2 but longer')
    assert.ok(!hash.includes('hunter2'))
  })

  it('salts, so two identical passwords hash differently', async () => {
    const [a, b] = await Promise.all([hashPassword('the same password'), hashPassword('the same password')])
    assert.notEqual(a, b)
    // And both still verify.
    assert.equal(await verifyPassword('the same password', a), true)
    assert.equal(await verifyPassword('the same password', b), true)
  })

  it('refuses input it should never be handed', async () => {
    await assert.rejects(() => hashPassword(''))
    await assert.rejects(() => hashPassword(undefined))
    // Unbounded input into a memory-hard function stalls the event loop.
    await assert.rejects(() => hashPassword('x'.repeat(201)))
  })
})

describe('verifyPassword', () => {
  it('accepts the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery')
    assert.equal(await verifyPassword('correct horse battery', hash), true)
    assert.equal(await verifyPassword('correct horse batteryy', hash), false)
    assert.equal(await verifyPassword('', hash), false)
  })

  it('is case sensitive', async () => {
    const hash = await hashPassword('Correct Horse Battery')
    assert.equal(await verifyPassword('correct horse battery', hash), false)
  })

  it('fails closed on a corrupted or foreign stored value', async () => {
    // A bad row should fail one login, not 500 the endpoint for everyone.
    for (const stored of [
      '',
      'not a hash',
      'scrypt$16384$8$1$onlyfiveparts',
      'bcrypt$16384$8$1$c2FsdA==$a2V5',
      'scrypt$notanumber$8$1$c2FsdA==$a2V5',
      null,
      undefined,
      12345,
    ]) {
      assert.equal(await verifyPassword('a good long password', stored), false, String(stored))
    }
  })

  it('refuses an absurd cost rather than allocating it', async () => {
    // Otherwise a hostile row asks node for gigabytes on every login attempt.
    const absurd = `scrypt$1073741824$8$1$${Buffer.from('salt').toString('base64')}$${Buffer.from('key').toString('base64')}`
    const started = Date.now()
    assert.equal(await verifyPassword('a good long password', absurd), false)
    assert.ok(Date.now() - started < 1000, 'should reject immediately, not attempt it')
  })

  it('rejects an over-long attempt without hashing it', async () => {
    const hash = await hashPassword('a good long password')
    assert.equal(await verifyPassword('x'.repeat(5000), hash), false)
  })

  it('verifies a hash made with a weaker but valid cost', async () => {
    // The reason the cost is stored per row: raising it must not lock anyone out.
    const { scrypt } = await import('node:crypto')
    const { promisify } = await import('node:util')
    const derive = promisify(scrypt)
    const salt = Buffer.from('sixteen byte salt')
    const key = await derive('an older password', salt, 64, { N: 1024, r: 8, p: 1 })
    const stored = `scrypt$1024$8$1$${salt.toString('base64')}$${key.toString('base64')}`

    assert.equal(await verifyPassword('an older password', stored), true)
    assert.equal(needsRehash(stored), true, 'and it should be flagged for upgrade')
  })
})

describe('needsRehash', () => {
  it('leaves a current hash alone', async () => {
    assert.equal(needsRehash(await hashPassword('a good long password')), false)
  })

  it('flags anything weaker, foreign or missing', () => {
    assert.equal(needsRehash('scrypt$1024$8$1$c2FsdA==$a2V5'), true)
    assert.equal(needsRehash('bcrypt$16384$8$1$c2FsdA==$a2V5'), true)
    assert.equal(needsRehash(undefined), true)
  })
})
