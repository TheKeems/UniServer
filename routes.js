// The API.
//
//   POST   /api/auth/signup     { username, password }          -> { token, account, profile }
//   POST   /api/auth/login      { username, password }          -> { token, account, profile }
//   GET    /api/auth/me         Bearer                          -> { account }
//   POST   /api/auth/password   Bearer { currentPassword, newPassword } -> 204
//   GET    /api/profile         Bearer                          -> { profile }
//   PUT    /api/profile         Bearer { answers, shortlist, ... } -> { profile }
//   DELETE /api/account         Bearer                          -> 204
//   POST   /api/data            (anonymous survey telemetry)    -> { ok: true }
//   GET    /api/universities                                    -> { universities: [...] }
//   PUT    /api/universities/:id  Bearer + admin                -> { university }
//
// Errors are always `{ error: { code, message } }`. The code is for the client to
// branch on and the message is written to be shown to a student as-is — the
// browser should never have to compose an error from an HTTP status.
//
// /api/data is the endpoint that already existed and it is unchanged: still
// anonymous, still no account id, still a five-point average band rather than an
// exact average. Accounts did not make it identifiable and must not.
//
// The map tile routes are NOT here. They live in app.js, mounted above the
// "everything below needs the database" gate, because a basemap has nothing to
// do with Mongo and a sleeping Atlas should not take the map down with it.

import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import mongoose from 'mongoose'
import {
  Account,
  Profile,
  Submission,
  UniversityContent,
  publicAccount,
  publicProfile,
  publicUniversityContent,
  adminUniversityContent,
} from './models.js'
import { hashPassword, needsRehash, verifyPassword } from './passwords.js'
import { accountIdFromToken, bearerFrom, signToken } from './tokens.js'
import {
  PASSWORD_MAX,
  cleanProfile,
  cleanSubmission,
  cleanUniversityContent,
  passwordProblem,
  universityIdProblem,
  usernameProblem,
} from './validate.js'

export const routes = Router()

/* -------------------------------------------------------------- plumbing --- */

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } })
}

/**
 * Rate limits.
 *
 * There is no API key on any of this, so the only thing standing between the
 * login route and someone working through a password list is this. Signup is
 * capped harder than login because one person needs it roughly once, ever.
 *
 * Keyed on IP, which on Render means the value express reads from
 * X-Forwarded-For — see the `trust proxy` line in index.js, without which every
 * request appears to come from the same proxy address and one keen user rate
 * limits the whole site.
 */
const signupLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many accounts made from here recently. Try again later.' } },
})

const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many sign-in attempts. Wait a few minutes and try again.' } },
})

// Generous: the dashboard pushes on a debounce, and a student ticking twenty
// courses in a minute is normal use, not abuse.
const writeLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many changes at once. Give it a minute.' } },
})

/**
 * Require a valid bearer token, and hang the account id on the request.
 *
 * Deliberately does not load the account: most routes only need the id, and the
 * ones that need the document say so. A token for a deleted account therefore
 * 401s at the point something actually looks for it.
 */
function requireAccount(req, res, next) {
  const id = accountIdFromToken(bearerFrom(req.get('authorization')))
  if (!id || !mongoose.isValidObjectId(id)) {
    return fail(res, 401, 'unauthorized', 'Please sign in again.')
  }
  req.accountId = id
  next()
}

/**
 * Require an account that is actually an admin.
 *
 * READS THE DATABASE EVERY TIME, on purpose, and this is the difference between
 * a permission and a decoration. `isAdmin` also travels in the account payload
 * so the client knows whether to render the admin screen — but that value came
 * from the client's own localStorage and a token is a bearer credential, not a
 * capability list. The token says WHO you are; the database says what you may
 * do. Nothing here trusts the former for the latter.
 *
 * Deliberately the same 404 a non-existent route gets, rather than a 403. A 403
 * confirms that /api/universities/:id is a real endpoint worth attacking and
 * that admin accounts exist to be found; a 404 says nothing. The client shows
 * the same page it shows for any unknown route.
 */
function requireAdmin(req, res, next) {
  Account.findById(req.accountId)
    .then((account) => {
      if (!account?.isAdmin) {
        // Byte-identical to app.js's genuine 404, which is the whole point of
        // answering 404 here. Inside a router mounted at /api, `req.path` has
        // the prefix stripped — this used to read "/universities/x" where a
        // real miss reads "/api/universities/x", so the refusal announced
        // itself. `originalUrl` restores the prefix; the split drops the query
        // string, which app.js's `req.path` does not include either.
        const path = req.originalUrl.split('?')[0]
        return fail(res, 404, 'not_found', `No route for ${req.method} ${path}.`)
      }
      req.account = account
      next()
    })
    .catch(next)
}

/**
 * Is this request from an admin, without demanding that it be?
 *
 * For the one route whose SHAPE depends on who is asking rather than whether
 * they may ask at all: everyone may read the university copy, and an admin
 * additionally gets `updatedBy`. `requireAdmin` cannot express that, because it
 * refuses the request instead of narrowing the answer.
 *
 * Reads the database like requireAdmin does, for the same reason: the token
 * says who you are, the database says what you may see.
 */
async function isAdminRequest(req) {
  const id = accountIdFromToken(bearerFrom(req.get('authorization')))
  if (!id || !mongoose.isValidObjectId(id)) return false
  const account = await Account.findById(id)
  return Boolean(account?.isAdmin)
}

/** Wrap an async handler so a rejected promise becomes a 500, not a hang. */
function handler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
}

/* ------------------------------------------------------------------ auth --- */

routes.post(
  '/auth/signup',
  signupLimit,
  handler(async (req, res) => {
    const { username, password } = req.body ?? {}

    const nameProblem = usernameProblem(username)
    if (nameProblem) return fail(res, 400, 'invalid_username', nameProblem)
    const passProblem = passwordProblem(password, username)
    if (passProblem) return fail(res, 400, 'invalid_password', passProblem)

    const clean = username.trim()
    const usernameKey = clean.toLowerCase()

    if (await Account.exists({ usernameKey })) {
      return fail(res, 409, 'username_taken', 'That username is already taken.')
    }

    let account
    try {
      account = await Account.create({
        username: clean,
        usernameKey,
        // The plaintext goes no further than this call. Nothing below this line
        // has access to it, and nothing writes it anywhere.
        passwordHash: await hashPassword(password),
      })
    } catch (cause) {
      // The unique index is the real guard: two signups for the same name can
      // pass the exists() check above at the same moment, and only one of them
      // can win.
      if (cause?.code === 11000) {
        return fail(res, 409, 'username_taken', 'That username is already taken.')
      }
      throw cause
    }

    // A profile is created empty rather than on first write, so `GET /api/profile`
    // has something to answer with and the client never has to special-case a
    // brand-new account.
    const profile = await Profile.create({ accountId: account._id })

    res.status(201).json({
      token: signToken(account._id),
      account: publicAccount(account),
      profile: publicProfile(profile),
    })
  }),
)

routes.post(
  '/auth/login',
  loginLimit,
  handler(async (req, res) => {
    const { username, password } = req.body ?? {}

    // Length is checked but the *rules* are not: tightening the username or
    // password rules later must never lock an existing account out of its own
    // data. Only signup enforces the shape.
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return fail(res, 400, 'invalid_credentials', 'Enter your username and password.')
    }
    if (password.length > PASSWORD_MAX) {
      return fail(res, 400, 'invalid_credentials', 'That username and password don’t match.')
    }

    const account = await Account.findOne({ usernameKey: username.trim().toLowerCase() }).select(
      '+passwordHash',
    )

    // One message for "no such account" and "wrong password". Splitting them
    // hands out a list of which usernames exist, and the student who mistyped is
    // no better off for knowing which half they got wrong.
    const ok = account ? await verifyPassword(password, account.passwordHash) : false
    if (!ok) {
      return fail(res, 401, 'invalid_credentials', 'That username and password don’t match.')
    }

    // Quietly upgrade a hash made with an older cost, now that we have the
    // plaintext in hand and know it is correct. The student never sees this.
    if (needsRehash(account.passwordHash)) {
      account.passwordHash = await hashPassword(password)
    }
    account.lastSeenAt = new Date()
    await account.save()

    const profile =
      (await Profile.findOne({ accountId: account._id })) ??
      (await Profile.create({ accountId: account._id }))

    res.json({
      token: signToken(account._id),
      account: publicAccount(account),
      profile: publicProfile(profile),
    })
  }),
)

/**
 * Who a stored token belongs to.
 *
 * The client calls this on load to find out whether the token in localStorage is
 * still good. It is the cheapest route in the service on purpose.
 */
routes.get(
  '/auth/me',
  requireAccount,
  handler(async (req, res) => {
    const account = await Account.findById(req.accountId)
    if (!account) return fail(res, 401, 'unauthorized', 'Please sign in again.')
    res.json({ account: publicAccount(account) })
  }),
)

routes.post(
  '/auth/password',
  loginLimit,
  requireAccount,
  handler(async (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {}

    const account = await Account.findById(req.accountId).select('+passwordHash')
    if (!account) return fail(res, 401, 'unauthorized', 'Please sign in again.')

    if (typeof currentPassword !== 'string' || !(await verifyPassword(currentPassword, account.passwordHash))) {
      return fail(res, 403, 'wrong_password', 'That’s not your current password.')
    }

    const problem = passwordProblem(newPassword, account.username)
    if (problem) return fail(res, 400, 'invalid_password', problem)
    if (newPassword === currentPassword) {
      return fail(res, 400, 'invalid_password', 'That’s the password you already have.')
    }

    account.passwordHash = await hashPassword(newPassword)
    await account.save()

    // No new token. Tokens here are stateless, so changing a password cannot
    // invalidate one that is already out there — issuing a fresh one would only
    // suggest otherwise. Documented in tokens.js; the TTL is the real limit.
    res.status(204).end()
  }),
)

/* --------------------------------------------------------------- profile --- */

routes.get(
  '/profile',
  requireAccount,
  handler(async (req, res) => {
    const profile = await Profile.findOne({ accountId: req.accountId })
    res.json({ profile: publicProfile(profile) })
  }),
)

/**
 * Replace the stored profile.
 *
 * PUT, not PATCH: the client holds the whole profile in localStorage and is the
 * thing being backed up, so a partial merge would be a way to end up with a
 * shortlist that is neither the client's nor the server's. Last write wins, and
 * `savedAt` records whose clock said what.
 */
routes.put(
  '/profile',
  writeLimit,
  requireAccount,
  handler(async (req, res) => {
    if (!(await Account.exists({ _id: req.accountId }))) {
      return fail(res, 401, 'unauthorized', 'Please sign in again.')
    }

    const clean = cleanProfile(req.body)
    const profile = await Profile.findOneAndUpdate(
      { accountId: req.accountId },
      { $set: { ...clean, updatedAt: new Date() } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    )

    res.json({ profile: publicProfile(profile) })
  }),
)

/* --------------------------------------------------------------- account --- */

routes.delete(
  '/account',
  requireAccount,
  handler(async (req, res) => {
    // The profile goes first. If the second call fails, the worst case is an
    // account with an empty profile; deleting the account first would leave a
    // profile document with no owner and no way to reach it.
    await Profile.deleteOne({ accountId: req.accountId })
    await Account.deleteOne({ _id: req.accountId })
    res.status(204).end()
  }),
)

/* ------------------------------------------------------------- telemetry --- */

/**
 * The original endpoint, behaviour unchanged.
 *
 * Anonymous: no account id, no username, no token read even when one is sent. A
 * signed-in student's submission is indistinguishable from a guest's, which is
 * the entire point of it being separate from the profile routes.
 */
routes.post(
  '/data',
  writeLimit,
  handler(async (req, res) => {
    await Submission.create(cleanSubmission(req.body))
    res.status(201).json({ ok: true })
  }),
)

/* ---------------------------------------------------------- universities --- */

/**
 * Editable copy about each university.
 *
 * PUBLIC AND UNAUTHENTICATED, because every student reading the site needs it
 * and none of it is private — it is the prose an admin typed to be published.
 * The whole collection comes back in one call: there are 39 universities and a
 * few paragraphs each, which is smaller than one program page, and it means the
 * client caches it once instead of making a request per school.
 *
 * An empty collection is a normal answer. The site renders identically without
 * any of this; see the note at the top of the model.
 */
routes.get(
  '/universities',
  handler(async (req, res) => {
    const docs = await UniversityContent.find({}).lean()
    // Same rows for everyone; one extra field for an admin. `updatedBy` is an
    // admin's username, so publishing it to every student would hand out the
    // list of accounts worth attacking — and undo the point of requireAdmin
    // answering 404 rather than 403. The admin panel needs it, so it asks with
    // a token and gets it.
    const shape = (await isAdminRequest(req)) ? adminUniversityContent : publicUniversityContent
    res.json({ universities: docs.map(shape) })
  }),
)

/**
 * Create or replace one university's copy.
 *
 * PUT and upsert: the admin panel holds the whole record in a form and saves all
 * of it, and a university with nothing written about it yet has no document to
 * PATCH. Same reasoning as the profile route.
 *
 * `updatedBy` records the username rather than the account id, because the
 * question an admin asks is "who wrote this" and an ObjectId does not answer it.
 */
routes.put(
  '/universities/:id',
  writeLimit,
  requireAccount,
  requireAdmin,
  handler(async (req, res) => {
    // Trimmed, because `universityIdProblem` validates the TRIMMED value.
    // Using the raw parameter after that let " waterloo" pass the check and
    // then be stored verbatim — a document keyed to an id no university has,
    // sitting in the collection looking like copy that failed to appear.
    const id = String(req.params.id ?? '').trim()
    const idProblem = universityIdProblem(id)
    if (idProblem) return fail(res, 400, 'invalid_university', idProblem)

    const { content, problem } = cleanUniversityContent(req.body)
    if (problem) return fail(res, 400, 'invalid_content', problem)

    const doc = await UniversityContent.findOneAndUpdate(
      { universityId: id },
      {
        $set: {
          ...content,
          universityId: id,
          updatedAt: new Date(),
          updatedBy: req.account.username,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    )

    // The admin shape. This route is behind requireAdmin, and whoever just
    // saved is entitled to see who saved it. The public GET above is not.
    res.json({ university: adminUniversityContent(doc) })
  }),
)

/**
 * Remove one university's copy entirely.
 *
 * Distinct from saving an empty description, and the difference is visible in
 * the admin panel: an empty document still says "last edited by X", which reads
 * as "somebody deliberately blanked this" rather than "nobody has written it
 * yet". Deleting restores the second state.
 */
routes.delete(
  '/universities/:id',
  writeLimit,
  requireAccount,
  requireAdmin,
  handler(async (req, res) => {
    const id = String(req.params.id ?? '').trim()
    const idProblem = universityIdProblem(id)
    if (idProblem) return fail(res, 400, 'invalid_university', idProblem)
    await UniversityContent.deleteOne({ universityId: id })
    res.status(204).end()
  }),
)
