// Request-body checking, kept out of the route handlers.
//
// Everything here runs on input from the open internet: the endpoints take no
// API key, so "the client wouldn't send that" is not an argument. Bodies are
// rebuilt field by field rather than passed through — a client cannot add a
// field to a document by inventing one, and cannot make a document enormous by
// sending a million-entry array.
//
// The username and password rules are the same numbers as `usernameError` and
// `passwordError` in src/lib/auth.ts. They are duplicated because one copy runs
// in a browser and one runs here, and the browser's copy is a courtesy the
// server cannot trust. If you change one, change both — the client's copy exists
// to give a fast, friendly message, and this copy is the one that decides.

export const USERNAME_MIN = 3
export const USERNAME_MAX = 20
export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 200

const USERNAME_SHAPE = /^[a-z0-9][a-z0-9_-]*$/i

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwertyuiop', 'qwerty123', 'iloveyou', 'letmein', 'welcome1', 'abc12345',
  'football', 'princess', 'sunshine', 'baseball', 'trustno1', 'admin123',
])

/** Caps on the profile, so one account cannot fill the database. */
const LIMITS = {
  shortlist: 500,
  courses: 100,
  notes: 500,
  tags: 500,
  tagsPerProgram: 20,
  programId: 200,
  noteText: 2000,
  tagText: 40,
  courseCode: 20,
}

export function usernameProblem(raw) {
  if (typeof raw !== 'string') return 'Username is required.'
  const name = raw.trim()
  if (name.length < USERNAME_MIN) return `Username must be at least ${USERNAME_MIN} characters.`
  if (name.length > USERNAME_MAX) return `Username must be at most ${USERNAME_MAX} characters.`
  if (!USERNAME_SHAPE.test(name)) {
    return 'Username may only contain letters, numbers, hyphens and underscores, and must start with a letter or number.'
  }
  return null
}

export function passwordProblem(raw, username) {
  if (typeof raw !== 'string' || !raw) return 'Password is required.'
  if (raw.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`
  if (raw.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters.`
  if (typeof username === 'string' && raw.toLowerCase() === username.trim().toLowerCase()) {
    return 'Password cannot be the same as the username.'
  }
  if (COMMON_PASSWORDS.has(raw.toLowerCase())) {
    return 'That password is one of the most commonly used ones. Choose another.'
  }
  return null
}

/**
 * Rebuild a profile from a request body, dropping anything unrecognised.
 *
 * Never throws and never rejects a whole profile over one bad entry: a student's
 * shortlist should not fail to save because one program id in it is malformed.
 * Bad entries are skipped, the rest is stored.
 */
export function cleanProfile(body) {
  const source = body && typeof body === 'object' ? body : {}

  return {
    answers: cleanAnswers(source.answers),
    shortlist: cleanIdList(source.shortlist, LIMITS.shortlist, LIMITS.programId),
    courses: cleanIdList(source.courses, LIMITS.courses, LIMITS.courseCode),
    notes: cleanNotes(source.notes),
    tags: cleanTags(source.tags),
    savedAt: cleanDate(source.savedAt),
  }
}

function cleanAnswers(answers) {
  // null is a real answer — it is what "I skipped the survey" looks like — so it
  // has to survive the round trip rather than becoming an empty object.
  if (!answers || typeof answers !== 'object') return null

  const average = answers.average
  const gradYear = answers.gradYear
  return {
    field: cleanString(answers.field, 40),
    province: cleanString(answers.province, 4),
    average:
      typeof average === 'number' && Number.isFinite(average) && average >= 0 && average <= 100
        ? average
        : null,
    ambition: ['safe', 'balanced', 'reach'].includes(answers.ambition) ? answers.ambition : 'balanced',
    // The three questions added on 2026-08-27. Every one has to appear here, or
    // the answer is accepted, dropped, and never seen again — this function
    // REBUILDS the stored answers rather than merging into them.
    homeCity: cleanString(answers.homeCity, 60),
    coop: ['yes', 'no'].includes(answers.coop) ? answers.coop : '',
    // Bounded to something a human could plausibly graduate in, and truncated
    // rather than rounded so 2027.9 is 2027 and not a year further away.
    gradYear:
      typeof gradYear === 'number' &&
      Number.isFinite(gradYear) &&
      gradYear >= 1900 &&
      gradYear <= 2200
        ? Math.trunc(gradYear)
        : null,
  }
}

/* ----------------------------------------------------- university content --- */

/** Caps on editable copy, so one save cannot fill the database. */
const CONTENT_LIMITS = {
  universityId: 60,
  description: 4000,
  blurb: 240,
  links: 12,
  linkLabel: 80,
  linkUrl: 500,
}

/**
 * The id in the URL of a content route.
 *
 * Restricted to the shape the dataset actually uses — `waterloo`, `tmu`,
 * `toronto-scarborough` — rather than accepting anything and trusting Mongo to
 * cope. A permissive id here is how a `$`-prefixed or dotted key reaches a
 * query, and it also stops the admin panel quietly creating documents for typos
 * that then sit in the collection matching no university at all.
 */
export function universityIdProblem(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return 'A university id is required.'
  const id = raw.trim()
  if (id.length > CONTENT_LIMITS.universityId) {
    return `University id must be at most ${CONTENT_LIMITS.universityId} characters.`
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    return 'University id may only contain lowercase letters, numbers and hyphens.'
  }
  return null
}

/**
 * Only http and https, and only absolute.
 *
 * `javascript:` is the reason this exists. These links are rendered as anchors
 * on a page students read, and an admin panel is not a trusted input path just
 * because it is behind a password — the entire point of storing a URL is that
 * a person typed it. `new URL` also rejects the relative and scheme-relative
 * forms, which would otherwise resolve against our own origin.
 */
export function urlProblem(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return 'A link needs a URL.'
  const value = raw.trim()
  if (value.length > CONTENT_LIMITS.linkUrl) {
    return `A link URL must be at most ${CONTENT_LIMITS.linkUrl} characters.`
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return 'That link is not a valid URL. Include https://.'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Links must start with http:// or https://.'
  }
  return null
}

/**
 * Rebuild editable university copy from a request body.
 *
 * Unlike `cleanProfile`, this one CAN reject: it returns `{ problem }` for a bad
 * link rather than dropping it. A profile is a student's own data and losing one
 * malformed entry beats losing the whole save. This is published copy, and an
 * admin who pastes a broken URL needs to be told — not to have it vanish and
 * spend an afternoon wondering why the link never appeared on the site.
 */
export function cleanUniversityContent(body) {
  const source = body && typeof body === 'object' ? body : {}

  const rawLinks = Array.isArray(source.links) ? source.links.slice(0, CONTENT_LIMITS.links) : []
  const links = []
  for (const entry of rawLinks) {
    if (!entry || typeof entry !== 'object') continue
    const label = cleanString(entry.label, CONTENT_LIMITS.linkLabel)
    const url = typeof entry.url === 'string' ? entry.url.trim() : ''
    // A wholly empty row is an unfilled form field, not a mistake worth an error.
    if (!label && !url) continue
    const problem = urlProblem(url)
    if (problem) return { problem }
    if (!label) return { problem: 'Every link needs a label.' }
    links.push({ label, url })
  }

  return {
    content: {
      description: cleanString(source.description, CONTENT_LIMITS.description),
      blurb: cleanString(source.blurb, CONTENT_LIMITS.blurb),
      links,
    },
  }
}

function cleanIdList(value, maxCount, maxLength) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (!trimmed || trimmed.length > maxLength) continue
    seen.add(trimmed)
    if (seen.size >= maxCount) break
  }
  return [...seen]
}

function cleanNotes(value) {
  // The client sends { programId: text }; the model stores an array because Mongo
  // will not accept a '.' or a leading '$' in a key and program ids come from
  // outside.
  //
  // Arrays are refused explicitly: `Object.entries(['text'])` gives [['0','text']],
  // so an array would quietly become a note against a program called "0".
  if (!isPlainRecord(value)) return []
  return Object.entries(value)
    .filter(([id, text]) => id && typeof text === 'string' && text.trim())
    .slice(0, LIMITS.notes)
    .map(([id, text]) => ({
      programId: String(id).slice(0, LIMITS.programId),
      text: text.slice(0, LIMITS.noteText),
    }))
}

function cleanTags(value) {
  if (!isPlainRecord(value)) return []
  return Object.entries(value)
    .filter(([id, tags]) => id && Array.isArray(tags) && tags.length)
    .slice(0, LIMITS.tags)
    .map(([id, tags]) => ({
      programId: String(id).slice(0, LIMITS.programId),
      tags: tags
        .filter((t) => typeof t === 'string' && t.trim())
        .slice(0, LIMITS.tagsPerProgram)
        .map((t) => t.trim().slice(0, LIMITS.tagText)),
    }))
    .filter((entry) => entry.tags.length)
}

/** The anonymous telemetry body — a band, never an exact average. */
export function cleanSubmission(body) {
  const source = body && typeof body === 'object' ? body : {}
  return {
    field: cleanString(source.field, 40),
    province: cleanString(source.province, 4),
    averageBand: cleanString(source.averageBand, 12) || 'not-given',
    ambition: ['safe', 'balanced', 'reach'].includes(source.ambition) ? source.ambition : 'balanced',
    matchCount:
      typeof source.matchCount === 'number' && Number.isFinite(source.matchCount)
        ? Math.max(0, Math.min(10_000, Math.trunc(source.matchCount)))
        : 0,
    submittedAt: cleanDate(source.submittedAt),
  }
}

/** An object used as a map — not an array, and not null. */
function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cleanString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function cleanDate(value) {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  // A client clock can be wrong, but it cannot be unparseable.
  return Number.isNaN(date.getTime()) ? null : date
}
