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
//
// Errors are always `{ error: { code, message } }`. The code is for the client to
// branch on and the message is written to be shown to a student as-is — the
// browser should never have to compose an error from an HTTP status.
//
// /api/data is the endpoint that already existed and it is unchanged: still
// anonymous, still no account id, still a five-point average band rather than an
// exact average. Accounts did not make it identifiable and must not.

import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import mongoose from 'mongoose'
import { Account, Profile, Submission, publicAccount, publicProfile } from './models.js'
import { hashPassword, needsRehash, verifyPassword } from './passwords.js'
import { accountIdFromToken, bearerFrom, signToken } from './tokens.js'
import {
  PASSWORD_MAX,
  cleanProfile,
  cleanSubmission,
  passwordProblem,
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
