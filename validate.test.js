// Unit tests for the body checking.
//
// Every input here comes from the open internet — the endpoints take no API key —
// so the interesting cases are the hostile ones: fields nobody asked for, arrays
// that would fill the database, and the `null` that has to survive because it is
// a real answer rather than a missing one.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanProfile,
  cleanSubmission,
  cleanUniversityContent,
  passwordProblem,
  universityIdProblem,
  urlProblem,
  usernameProblem,
} from './validate.js'

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

/* -------------------------------------------------- the new survey answers --- */

describe('cleanAnswers, for the questions added on 2026-08-27', () => {
  const answers = (over) => cleanProfile({ answers: { field: 'engineering', ...over } }).answers

  it('keeps a home city', () => {
    assert.equal(answers({ homeCity: 'Mississauga' }).homeCity, 'Mississauga')
  })

  it('defaults a missing home city to empty, which means "rather not say"', () => {
    assert.equal(answers({}).homeCity, '')
  })

  it('truncates a home city rather than rejecting the whole profile', () => {
    assert.equal(answers({ homeCity: 'x'.repeat(500) }).homeCity.length, 60)
  })

  it('accepts only the two real co-op answers', () => {
    assert.equal(answers({ coop: 'yes' }).coop, 'yes')
    assert.equal(answers({ coop: 'no' }).coop, 'no')
  })

  it('turns anything else into no preference, never into a filter', () => {
    // '' means "show me both". Anything that fell through to a truthy value here
    // would silently halve a student's shortlist.
    assert.equal(answers({ coop: 'maybe' }).coop, '')
    assert.equal(answers({ coop: true }).coop, '')
    assert.equal(answers({}).coop, '')
  })

  it('keeps a plausible graduating year', () => {
    assert.equal(answers({ gradYear: 2027 }).gradYear, 2027)
  })

  it('makes an implausible or missing year null, never 0', () => {
    assert.equal(answers({ gradYear: 1200 }).gradYear, null)
    assert.equal(answers({ gradYear: 9999 }).gradYear, null)
    assert.equal(answers({ gradYear: 'next year' }).gradYear, null)
    assert.equal(answers({ gradYear: NaN }).gradYear, null)
    assert.equal(answers({}).gradYear, null)
  })

  it('truncates rather than rounds, so a year never moves further away', () => {
    assert.equal(answers({ gradYear: 2027.9 }).gradYear, 2027)
  })

  // The guard against the four-place change going wrong. If a key is missing
  // here it is accepted by the API, dropped on the way into Mongo, and erased
  // from the student's device on their next sign-in elsewhere.
  it('emits every key the client expects back', () => {
    assert.deepEqual(Object.keys(answers({})).sort(), [
      'ambition',
      'average',
      'coop',
      'field',
      'gradYear',
      'homeCity',
      'province',
    ])
  })
})

/* --------------------------------------------------- university content --- */

describe('universityIdProblem', () => {
  it('accepts the ids the dataset actually uses', () => {
    for (const id of ['waterloo', 'tmu', 'toronto-scarborough', 'ubc-okanagan', 'rmc']) {
      assert.equal(universityIdProblem(id), null, id)
    }
  })

  it('refuses anything that could reach a query as an operator', () => {
    // The id goes into a Mongo filter. A '$' or a '.' in it is the classic way
    // that stops being a string and starts being an instruction.
    for (const id of ['$ne', 'a.b', '{"$gt":""}', '../etc', 'Waterloo', 'has space']) {
      assert.ok(universityIdProblem(id), id)
    }
  })

  it('refuses an empty or missing id', () => {
    assert.ok(universityIdProblem(''))
    assert.ok(universityIdProblem('   '))
    assert.ok(universityIdProblem(undefined))
    assert.ok(universityIdProblem(null))
  })
})

describe('urlProblem', () => {
  it('accepts an ordinary link', () => {
    assert.equal(urlProblem('https://uwaterloo.ca/admissions'), null)
    assert.equal(urlProblem('http://example.org'), null)
  })

  it('refuses a scheme that would execute rather than navigate', () => {
    // These links become anchors on a page students read. An admin panel is not
    // a trusted input path just because it is behind a password.
    assert.ok(urlProblem('javascript:alert(1)'))
    assert.ok(urlProblem('JavaScript:alert(1)'))
    assert.ok(urlProblem('data:text/html,<script>alert(1)</script>'))
    assert.ok(urlProblem('vbscript:msgbox(1)'))
    assert.ok(urlProblem('file:///etc/passwd'))
  })

  it('refuses a relative link, which would resolve against our own origin', () => {
    assert.ok(urlProblem('/admissions'))
    assert.ok(urlProblem('uwaterloo.ca'))
  })
})

describe('cleanUniversityContent', () => {
  it('keeps the copy an admin typed', () => {
    const { content, problem } = cleanUniversityContent({
      description: 'A big school in Waterloo.',
      blurb: 'Co-op capital.',
      links: [{ label: 'Admissions', url: 'https://uwaterloo.ca/admissions' }],
    })
    assert.equal(problem, undefined)
    assert.equal(content.description, 'A big school in Waterloo.')
    assert.equal(content.blurb, 'Co-op capital.')
    assert.deepEqual(content.links, [{ label: 'Admissions', url: 'https://uwaterloo.ca/admissions' }])
  })

  it('drops fields nobody asked for', () => {
    const { content } = cleanUniversityContent({
      description: 'ok',
      universityId: 'somewhere-else',
      updatedBy: 'not-me',
      isAdmin: true,
    })
    assert.deepEqual(Object.keys(content).sort(), ['blurb', 'description', 'links'])
  })

  // Unlike a profile, this REJECTS rather than silently dropping. An admin who
  // pastes a broken URL needs to be told, not to wonder why the link never
  // appeared on the site.
  it('reports a bad link instead of quietly discarding it', () => {
    const { problem } = cleanUniversityContent({
      links: [{ label: 'Apply', url: 'javascript:alert(1)' }],
    })
    assert.ok(problem)
  })

  it('reports a link with no label', () => {
    const { problem } = cleanUniversityContent({ links: [{ url: 'https://example.org' }] })
    assert.ok(problem)
  })

  it('ignores a wholly empty link row, which is just an unfilled form field', () => {
    const { content, problem } = cleanUniversityContent({
      links: [{ label: '', url: '' }, { label: 'Real', url: 'https://example.org' }],
    })
    assert.equal(problem, undefined)
    assert.equal(content.links.length, 1)
  })

  it('caps the number of links and the length of the prose', () => {
    const { content } = cleanUniversityContent({
      description: 'x'.repeat(9000),
      blurb: 'y'.repeat(900),
      links: Array.from({ length: 50 }, (_, i) => ({ label: `l${i}`, url: 'https://example.org' })),
    })
    assert.equal(content.description.length, 4000)
    assert.equal(content.blurb.length, 240)
    assert.equal(content.links.length, 12)
  })

  it('survives a body that is not an object at all', () => {
    assert.equal(cleanUniversityContent(null).content.description, '')
    assert.equal(cleanUniversityContent('nope').content.description, '')
    assert.deepEqual(cleanUniversityContent(undefined).content.links, [])
  })
})
