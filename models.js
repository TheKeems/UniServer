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

export const Account = mongoose.model('Account', accountSchema)
export const Profile = mongoose.model('Profile', profileSchema)
export const Submission = mongoose.model('Submission', submissionSchema)

/** The account shape a client is allowed to see. */
export function publicAccount(account) {
  return {
    id: String(account._id),
    username: account.username,
    createdAt: account.createdAt,
  }
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
