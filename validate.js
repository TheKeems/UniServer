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
  return {
    field: cleanString(answers.field, 40),
    province: cleanString(answers.province, 4),
    average:
      typeof average === 'number' && Number.isFinite(average) && average >= 0 && average <= 100
        ? average
        : null,
    ambition: ['safe', 'balanced', 'reach'].includes(answers.ambition) ? answers.ambition : 'balanced',
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
