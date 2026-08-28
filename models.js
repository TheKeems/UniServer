// The MongoDB collections.
//
// WHAT IS DELIBERATELY NOT IN HERE: email, real name, age, school, phone. The
// site's audience is mostly minors and the rule it has held from the start is
// that it does not collect anything identifying — the original survey asked for
// a name and an age and that is exactly what got removed. A username the student
// invented is a label; it is not an identity.
//
// `strict: true` (mongoose's default, restated here because it matters) is doing
// real work: these documents are built from public request bodies, and anything
// the client sends that is not named below is dropped rather than stored. A
// `password` field sneaking into a document is impossible for that reason as well
// as by the routes being careful.

import mongoose from 'mongoose'

const { Schema } = mongoose

/* ----------------------------------------------------------------- account --- */

const accountSchema = new Schema(
  {
    /** As typed, for display. */
    username: { type: String, required: true, trim: true, minlength: 3, maxlength: 20 },
    /**
     * Lowercased username, and the unique index.
     *
     * Uniqueness has to ignore case or "Northstar" and "northstar" become two
     * accounts that no human would believe are different, and sign-in becomes a
     * guessing game about capitalisation.
     */
    usernameKey: { type: String, required: true, unique: true, index: true },
    /**
     * scrypt output from passwords.js — never a plaintext password.
     *
     * `select: false` so it is left out of every query that does not explicitly
     * ask for it. A route that accidentally sends an account document to a client
     * therefore cannot leak the hash.
     */
    passwordHash: { type: String, required: true, select: false },
    /**
     * Whether this account may edit site content.
     *
     * THERE IS NO ROUTE THAT SETS THIS, and that is deliberate rather than
     * unfinished. It is granted by hand, in the database:
     *
     *   db.accounts.updateOne({ usernameKey: 'you' }, { $set: { isAdmin: true } })
     *
     * An endpoint that grants admin is an endpoint that can be tricked into
     * granting admin, and this service has exactly one privilege level worth
     * protecting. The number of admins is small and changes rarely, so a shell
     * command is the right amount of friction.
     *
     * `strict: true` below is what stops a client sending `isAdmin: true` in a
     * signup body: the field is dropped before the document is built, not
     * stored and later ignored. The routes also rebuild every body field by
     * field (see validate.js), so this is the second of two locks.
     */
    isAdmin: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { strict: true, versionKey: false },
)

/* ----------------------------------------------------------------- profile --- */

// One document per account, holding what the dashboard already keeps in
// localStorage. The shapes mirror `SavedProfile` in src/lib/profile.ts, with two
// exceptions: notes and tags are arrays here rather than objects keyed by program
// id, because Mongo forbids '.' and a leading '$' in keys and a program id is
// client-supplied. The client converts on the way in and out.

const answersSchema = new Schema(
  {
    field: { type: String, default: '', maxlength: 40 },
    province: { type: String, default: '', maxlength: 4 },
    /**
     * The student's overall average, or null when they skipped the question.
     *
     * This is the most sensitive number the service holds, and it used to never
     * leave the device at all. It is here because a profile that syncs is what
     * an account is for. It is not tied to a name, an email or a school — only
     * to a username the student made up — and the anonymous telemetry in
     * /api/data still sends a five-point band rather than this.
     */
    average: { type: Number, min: 0, max: 100, default: null },
    ambition: { type: String, enum: ['safe', 'balanced', 'reach'], default: 'balanced' },
    /**
     * The three questions added on 2026-08-27, and the reason this schema is the
     * fourth place a new answer has to be listed.
     *
     * The client rebuilds its local profile from a per-field whitelist on every
     * pull (`applyRemoteProfile` in src/lib/sync.ts), and `cleanAnswers` in
     * validate.js rebuilds the document field by field on every push. A question
     * missing from either list is not "unsynced" — it is silently erased from
     * the device on the next sign-in elsewhere. Adding a question means editing
     * SurveyAnswers, sync.ts, api.ts and this file, together.
     *
     * A CITY, NEVER AN ADDRESS. `homeCity` exists to work out how far a campus
     * is, and a city is the coarsest thing that still answers that. It does not
     * belong to the same category as the fields listed at the top of this file
     * for exactly that reason — it locates a student to within a few hundred
     * thousand people.
     *
     * `gradYear` is a year, and it stays out of the anonymous telemetry: the
     * `submissions` collection must remain unjoinable to a person, and a year of
     * graduation alongside a field and a province starts to narrow that.
     */
    homeCity: { type: String, default: '', maxlength: 60 },
    coop: { type: String, enum: ['', 'yes', 'no'], default: '' },
    gradYear: { type: Number, min: 1900, max: 2200, default: null },
  },
  { _id: false, strict: true, versionKey: false },
)

const noteSchema = new Schema(
  {
    programId: { type: String, required: true, maxlength: 200 },
    text: { type: String, required: true, maxlength: 2000 },
  },
  { _id: false, strict: true, versionKey: false },
)

const tagSchema = new Schema(
  {
    programId: { type: String, required: true, maxlength: 200 },
    tags: { type: [String], default: [] },
  },
  { _id: false, strict: true, versionKey: false },
)

const profileSchema = new Schema(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'Account', required: true, unique: true, index: true },
    /** null is a real answer: it means the survey was skipped. */
    answers: { type: answersSchema, default: null },
    shortlist: { type: [String], default: [] },
    courses: { type: [String], default: [] },
    notes: { type: [noteSchema], default: [] },
    tags: { type: [tagSchema], default: [] },
    /**
     * When the client last wrote this, by the client's own clock.
     *
     * Kept alongside `updatedAt` because they answer different questions:
     * updatedAt is when the server stored it, savedAt is when the student
     * changed it. Two devices out of step need the second one.
     */
    savedAt: { type: Date, default: null },
    updatedAt: { type: Date, default: Date.now },
  },
  { strict: true, versionKey: false },
)

/* -------------------------------------------------------------- submission --- */

// The existing anonymous survey telemetry, unchanged in shape: field, province,
// a coarse average band, ambition, and how many programs matched. No account id
// and no username, so these rows stay unlinkable to a person even though the
// service now knows who some people are.

const submissionSchema = new Schema(
  {
    field: { type: String, default: '' },
    province: { type: String, default: '' },
    averageBand: { type: String, default: 'not-given' },
    ambition: { type: String, default: 'balanced' },
    matchCount: { type: Number, default: 0 },
    submittedAt: { type: Date, default: null },
    receivedAt: { type: Date, default: Date.now },
  },
  { strict: true, versionKey: false },
)

/* ------------------------------------------------------ university content --- */

// Editable copy about a university: a description, a one-line blurb, some links.
//
// WHAT THIS IS NOT. It is not the dataset. Names, cities, provinces, program
// counts and every reported average stay in the spreadsheet -> `npm run
// data:build` -> static JSON pipeline in the site repo, because that pipeline is
// where the moderation happens and where the provenance rules live. Nothing here
// can contradict a number, because nothing here holds a number.
//
// It is also additive, never authoritative: the site renders identically when
// this collection is empty or the service is asleep. `loadUniversityContent` in
// the client resolves to `{}` on failure rather than rejecting, so a cold Render
// instance costs a paragraph of prose, not a page.
//
// `universityId` matches the ids the dataset already uses — `waterloo`, `tmu`,
// `laurier` — so the join is on a key both sides already agree about.

const linkSchema = new Schema(
  {
    label: { type: String, required: true, maxlength: 80 },
    url: { type: String, required: true, maxlength: 500 },
  },
  { _id: false, strict: true, versionKey: false },
)

const universityContentSchema = new Schema(
  {
    universityId: { type: String, required: true, unique: true, index: true, maxlength: 60 },
    description: { type: String, default: '', maxlength: 4000 },
    /** One line, for a card or a map popup. */
    blurb: { type: String, default: '', maxlength: 240 },
    links: { type: [linkSchema], default: [] },
    updatedAt: { type: Date, default: Date.now },
    /**
     * The username that last saved this.
     *
     * Accountability, not attribution: it is never shown to a student, only in
     * the admin panel. With a handful of admins editing shared copy, "who
     * changed this and when" is the first question anybody asks.
     */
    updatedBy: { type: String, default: '', maxlength: 20 },
  },
  { strict: true, versionKey: false },
)

export const Account = mongoose.model('Account', accountSchema)
export const Profile = mongoose.model('Profile', profileSchema)
export const Submission = mongoose.model('Submission', submissionSchema)
export const UniversityContent = mongoose.model('UniversityContent', universityContentSchema)

/** The account shape a client is allowed to see. */
export function publicAccount(account) {
  return {
    id: String(account._id),
    username: account.username,
    createdAt: account.createdAt,
    // Sent so the client knows whether to render the admin route at all. This
    // is a CONVENIENCE, not a permission: every write route checks the database
    // for itself (see requireAdmin in routes.js). A client that lies to itself
    // about this gets an admin screen it cannot save from.
    isAdmin: Boolean(account.isAdmin),
  }
}

/**
 * The university-content shape ANYONE is allowed to see.
 *
 * Deliberately does not carry `updatedBy`. GET /api/universities is
 * unauthenticated — every student loading a program page gets this — and
 * `updatedBy` is an admin's username. Publishing it would hand out a list of
 * exactly which accounts to try to break into, which also undoes the reason
 * requireAdmin answers 404 rather than 403.
 *
 * `updatedAt` stays: "this was last checked in March" is useful to a reader,
 * and a date names nobody.
 */
export function publicUniversityContent(doc) {
  if (!doc) return null
  return {
    universityId: doc.universityId,
    description: doc.description ?? '',
    blurb: doc.blurb ?? '',
    links: (doc.links ?? []).map((l) => ({ label: l.label, url: l.url })),
    updatedAt: doc.updatedAt ?? null,
  }
}

/**
 * The same record, for an admin who is allowed to know who wrote it.
 *
 * Only ever returned from a route behind `requireAdmin`. With a handful of
 * admins editing shared copy, "who changed this and when" is the first question
 * anybody asks — but it is a question for them, not for the whole internet.
 */
export function adminUniversityContent(doc) {
  const base = publicUniversityContent(doc)
  return base && { ...base, updatedBy: doc.updatedBy ?? '' }
}

/** The profile shape a client is allowed to see, with notes/tags back as objects. */
export function publicProfile(profile) {
  if (!profile) return null
  return {
    answers: profile.answers ?? null,
    shortlist: profile.shortlist ?? [],
    courses: profile.courses ?? [],
    notes: Object.fromEntries((profile.notes ?? []).map((n) => [n.programId, n.text])),
    tags: Object.fromEntries((profile.tags ?? []).map((t) => [t.programId, t.tags])),
    savedAt: profile.savedAt ?? profile.updatedAt ?? null,
  }
}
