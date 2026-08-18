// Unit tests for the body checking.
//
// Every input here comes from the open internet — the endpoints take no API key —
// so the interesting cases are the hostile ones: fields nobody asked for, arrays
// that would fill the database, and the `null` that has to survive because it is
// a real answer rather than a missing one.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cleanProfile, cleanSubmission, passwordProblem, usernameProblem } from './validate.js'

describe('usernameProblem', () => {
  it('accepts a plain handle', () => {
    assert.equal(usernameProblem('northstar_7'), null)
    assert.equal(usernameProblem('  a-b  '), null)
  })

  it('rejects the shapes the client also rejects', () => {
    // Same numbers as usernameError in src/lib/auth.ts. This copy is the one that
    // decides; the browser's is a courtesy.
    assert.ok(usernameProblem('ab'))
    assert.ok(usernameProblem('a'.repeat(21)))
    assert.ok(usernameProblem('has space'))
    assert.ok(usernameProblem('_leading'))
    assert.ok(usernameProblem(''))
    assert.ok(usernameProblem(undefined))
    assert.ok(usernameProblem(42))
    assert.ok(usernameProblem({ toString: () => 'northstar' }))
  })
})

describe('passwordProblem', () => {
  it('accepts anything long enough', () => {
    assert.equal(passwordProblem('correct horse battery'), null)
  })

  it('rejects short, common, and password-is-username', () => {
    assert.ok(passwordProblem('short'))
    assert.ok(passwordProblem('PASSWORD123'))
    assert.ok(passwordProblem('Northstar7', 'northstar7'))
    assert.ok(passwordProblem('x'.repeat(201)))
    assert.ok(passwordProblem(null))
  })
})

describe('cleanProfile', () => {
  it('keeps what the dashboard sends', () => {
    const clean = cleanProfile({
      answers: { field: 'engineering', province: 'ON', average: 88, ambition: 'reach' },
      shortlist: ['waterloo::se', 'ubc::nursing'],
      courses: ['MHF4U'],
      notes: { 'waterloo::se': 'ask Mr Patel' },
      tags: { 'waterloo::se': ['reach', 'co-op'] },
      savedAt: '2026-08-18T00:00:00.000Z',
    })

    assert.equal(clean.answers.average, 88)
    assert.equal(clean.answers.ambition, 'reach')
    assert.deepEqual(clean.shortlist, ['waterloo::se', 'ubc::nursing'])
    assert.deepEqual(clean.notes, [{ programId: 'waterloo::se', text: 'ask Mr Patel' }])
    assert.deepEqual(clean.tags, [{ programId: 'waterloo::se', tags: ['reach', 'co-op'] }])
    assert.ok(clean.savedAt instanceof Date)
  })

  it('drops fields nobody asked for', () => {
    // A client cannot add a column by inventing one.
    const clean = cleanProfile({ shortlist: ['a'], isAdmin: true, passwordHash: 'nope' })
    assert.deepEqual(Object.keys(clean).sort(), [
      'answers', 'courses', 'notes', 'savedAt', 'shortlist', 'tags',
    ])
  })

  it('keeps a null answers, because skipping the survey is a real answer', () => {
    assert.equal(cleanProfile({ answers: null }).answers, null)
    assert.equal(cleanProfile({}).answers, null)
  })

  it('treats a nonsense average as skipped rather than as zero', () => {
    // An average of 0 would silently match nothing downstream, which is the worst
    // way to handle a blank.
    for (const average of ['88', NaN, Infinity, -5, 101, null, undefined]) {
      assert.equal(cleanProfile({ answers: { average } }).answers.average, null, String(average))
    }
    assert.equal(cleanProfile({ answers: { average: 0 } }).answers.average, 0)
  })

  it('falls back to balanced for an unknown ambition', () => {
    assert.equal(cleanProfile({ answers: { ambition: 'wildly' } }).answers.ambition, 'balanced')
  })

  it('caps the lists so one account cannot fill the database', () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `program-${i}`)
    const clean = cleanProfile({ shortlist: huge, courses: huge })
    assert.equal(clean.shortlist.length, 500)
    assert.equal(clean.courses.length, 100)
  })

  it('skips bad entries instead of rejecting the whole profile', () => {
    // A shortlist should not fail to save because one id in it is malformed.
    const clean = cleanProfile({ shortlist: ['good', 42, null, '', '  ', 'x'.repeat(500), 'also-good'] })
    assert.deepEqual(clean.shortlist, ['good', 'also-good'])
  })

  it('de-duplicates a repeated id', () => {
    assert.deepEqual(cleanProfile({ shortlist: ['a', 'a', 'b'] }).shortlist, ['a', 'b'])
  })

  it('truncates a long note rather than dropping it', () => {
    const clean = cleanProfile({ notes: { a: 'x'.repeat(5000) } })
    assert.equal(clean.notes[0].text.length, 2000)
  })

  it('drops a note that is only whitespace', () => {
    assert.deepEqual(cleanProfile({ notes: { a: '   ' } }).notes, [])
  })

  it('drops a tag entry with no usable tags', () => {
    assert.deepEqual(cleanProfile({ tags: { a: ['', '  '] } }).tags, [])
  })

  it('survives arrays where objects belong, and vice versa', () => {
    const clean = cleanProfile({ shortlist: 'not an array', notes: ['not an object'], answers: 'no' })
    assert.deepEqual(clean.shortlist, [])
    assert.deepEqual(clean.notes, [])
    assert.equal(clean.answers, null)
  })

  it('survives no body at all', () => {
    assert.equal(cleanProfile(undefined).answers, null)
    assert.deepEqual(cleanProfile(null).shortlist, [])
  })

  it('rejects an unparseable savedAt instead of storing Invalid Date', () => {
    assert.equal(cleanProfile({ savedAt: 'last Tuesday' }).savedAt, null)
    assert.equal(cleanProfile({ savedAt: 12345 }).savedAt, null)
  })
})

describe('cleanSubmission', () => {
  it('keeps the band and never invents an average', () => {
    const clean = cleanSubmission({
      field: 'engineering',
      province: 'ON',
      averageBand: '85-89',
      ambition: 'balanced',
      matchCount: 12,
      submittedAt: '2026-08-18T00:00:00.000Z',
    })
    assert.equal(clean.averageBand, '85-89')
    assert.equal(clean.matchCount, 12)
    assert.ok(!('average' in clean))
  })

  it('drops an exact average if a client ever sends one', () => {
    // The telemetry rows must stay unlinkable to a person, and an exact average is
    // the field that would change that.
    const clean = cleanSubmission({ average: 88, username: 'northstar', token: 'tok' })
    assert.ok(!('average' in clean))
    assert.ok(!('username' in clean))
    assert.ok(!('token' in clean))
  })

  it('defaults a missing band to not-given', () => {
    assert.equal(cleanSubmission({}).averageBand, 'not-given')
  })

  it('clamps a silly match count', () => {
    assert.equal(cleanSubmission({ matchCount: -5 }).matchCount, 0)
    assert.equal(cleanSubmission({ matchCount: 1e9 }).matchCount, 10_000)
    assert.equal(cleanSubmission({ matchCount: 'lots' }).matchCount, 0)
  })
})
