# uniserver

Accounts, profile storage and survey telemetry for Acceptiversity. Node + Express
+ Mongoose, deployed on Render at `https://uniserver-632q.onrender.com`.

## Read this first

**The live service does not have these routes yet.** As of 2026-08-18 it answers
`POST /api/data` and 404s everything else — including `GET /`. Probe it yourself:

```bash
curl -i https://uniserver-632q.onrender.com/api/health
```

A 404 means this code has not been deployed and the site's account pages will show
*"Accounts aren't available on the server yet"* (a specific message, so nobody
wastes an afternoon thinking they mistyped a password). Everything else on the site
works regardless — an account is optional there, not a gate.

**`POST /api/data` is preserved exactly as it was**: anonymous, no account id, a
five-point average band rather than an exact average. If the deployed repo already
has its own implementation of that route, keep theirs — check the collection name
matches (`submissions` here) before dropping this file in.

## What it stores

| Collection | Fields |
| --- | --- |
| `accounts` | `username`, `usernameKey` (lowercase, unique), `passwordHash`, `createdAt`, `lastSeenAt` |
| `profiles` | `accountId`, `answers` (field, province, **average**, ambition), `shortlist`, `courses`, `notes`, `tags`, `savedAt` |
| `submissions` | `field`, `province`, `averageBand`, `ambition`, `matchCount` — no account id |

No email, no real name, no age, no school, in any collection. The audience is
mostly minors and the project's rule is that it collects nothing identifying; a
username is a label the student invented. `models.js` says so at the top, and the
schemas are `strict` so a client cannot add a field by sending one.

The **exact average** is the one genuinely sensitive value here. It used to never
leave the device. It is stored now because a profile that follows you to another
device is the entire point of an account — and the site's copy was rewritten to say
so rather than keeping a reassurance that had stopped being true. It is not joined
to a name, an email or a school, and `submissions` still gets a band.

Passwords are **never stored**. `passwords.js` hashes with scrypt (N=16384, r=8,
p=1, 64-byte key, 16-byte random salt) and stores `scrypt$N$r$p$salt$key`. The cost
is inside each row, so raising it later does not lock anyone out — `needsRehash`
upgrades a row silently at the next successful login.

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `MONGODB_URI` | yes | Atlas connection string, including the database name |
| `JWT_SECRET` | yes | 32+ random characters. The service refuses to start without it |
| `ALLOWED_ORIGINS` | no | Comma-separated. Omit to allow any origin |
| `PORT` | no | Render sets this |

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Changing `JWT_SECRET` invalidates every session — everyone is asked to sign in
again, which is also how you revoke all tokens in an emergency.

## Deploying to Render

1. Push this directory to the repo Render builds.
2. Root directory `server`, build **`npm ci --omit=dev`**, start `npm start`.
   The `--omit=dev` matters: the only dev dependency is `mongodb-memory-server`,
   which downloads a ~75MB mongod binary the deploy has no use for.
3. Set the environment variables above.
4. Point the health check at `/api/health`.
5. In Atlas, allow Render's outbound addresses (or `0.0.0.0/0` on a free tier) and
   give the database user read/write on this database only.

The free tier sleeps when idle and a cold start takes most of a minute, which is
why the client allows 45 seconds and says "the server may be waking up" rather than
"failed". `db.js` keeps retrying its connection, and `/api/*` answers a clear 503
while it does, instead of hanging until the client gives up.

## Local development

No MongoDB installed? Use the in-memory one — same app, same routes, nothing
persisted between restarts:

```bash
npm install            # includes mongodb-memory-server; downloads a mongod binary once
npm run dev:memory     # http://localhost:3001
```

With a real MongoDB:

```bash
MONGODB_URI="mongodb://127.0.0.1:27017/uniserver" JWT_SECRET="$(node -e "console.log('x'.repeat(48))")" npm run dev
```

Either way, point the frontend at it from the project root:

```bash
VITE_API_BASE_URL=http://localhost:3001 npm run dev
```

The rate limits apply locally too, and ten signups an hour per address goes quickly
when you are testing sign-up. Restart the server to reset the counters — they live
in memory.

## Tests

```bash
npm test                      # everything
node --test passwords.test.js # just the hashing
```

`passwords.test.js` and `validate.test.js` are pure unit tests. `routes.test.js`
drives the real app over a real socket against an in-memory MongoDB, which is what
the `mongodb-memory-server` dev dependency is for. If it is missing — on a deploy
installed with `--omit=dev`, say — that file skips itself with a note rather than
failing the run.

Those tests cover the things worth being sure of: a signup race resolved by the
unique index, the hash never appearing in a response, one account being unable to
read another's profile, `PUT /api/profile` replacing rather than merging, `null`
answers surviving a round trip (a skipped survey is a real answer), the rate limiter
firing, and `/api/data` recording no account id even when a token is sent.

## The API

Errors are always `{ error: { code, message } }`. The `message` is written to be
shown to a student as-is; the client branches on `code`.

| Route | Auth | Body → Response |
| --- | --- | --- |
| `POST /api/auth/signup` | — | `{username, password}` → `201 {token, account, profile}` |
| `POST /api/auth/login` | — | `{username, password}` → `{token, account, profile}` |
| `GET /api/auth/me` | Bearer | → `{account}` |
| `POST /api/auth/password` | Bearer | `{currentPassword, newPassword}` → `204` |
| `GET /api/profile` | Bearer | → `{profile}` |
| `PUT /api/profile` | Bearer | whole profile → `{profile}` |
| `DELETE /api/account` | Bearer | → `204` (account + profile) |
| `POST /api/data` | — | anonymous telemetry → `201 {ok:true}` |
| `GET /api/health` | — | → `{ok, database}` |

Codes a client may see: `invalid_username`, `invalid_password`, `username_taken`,
`invalid_credentials`, `wrong_password`, `unauthorized`, `rate_limited`,
`database_unavailable`, `too_large`, `bad_json`, `not_found`, `server_error`.

`PUT /api/profile` replaces. The device holds the working copy and this is its
backup, so a server-side merge would produce a shortlist that is neither copy. Last
write wins; `savedAt` records the client's clock. Two devices editing between
sign-ins do not merge, and the account page in the app says so in one sentence.

Rate limits, per IP: signup 10/hour, login and password-change 20/15min, writes
300/15min. `app.set('trust proxy', 1)` is what makes those per-user rather than
per-proxy on Render — without it one keen user rate limits the whole site.

## Known gaps

- **No password reset.** There is no email on file to send one to, by design. The
  sign-up page says so before you commit, rather than after you forget.
- **Tokens cannot be revoked** before they expire (30 days). They are stateless, so
  changing a password does not sign out other devices — the account page states
  this rather than implying a guarantee the service does not make. Rotate
  `JWT_SECRET` to invalidate everything at once.
- **No email verification, no CAPTCHA.** The rate limiter is the only thing between
  the signup route and a script. Fine for a student project; revisit before anyone
  cares about the numbers.
- **Deleting a profile relies on the client** sending an emptied profile. The app
  does this (`clearProfile`), but there is no `DELETE /api/profile`.
