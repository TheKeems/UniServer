# uniserver

Accounts, profile storage and survey telemetry for Acceptiversity. Node + Express
+ Mongoose, deployed on Render at `https://uniserver-632q.onrender.com`.

## Read this first

**The accounts half of this is live.** As of 2026-08-28,
`https://uniserver-632q.onrender.com/api/health` answers
`{"ok":true,"database":"connected"}` and `GET /` returns the service banner — so
this codebase is deployed and both required environment variables are set. The
service refuses to start without `JWT_SECRET`, so a healthy response is proof of
that on its own.

**The university-content and map routes are not deployed yet.** `GET
/api/universities` still 404s. Probe before assuming either way:

```bash
curl -i https://uniserver-632q.onrender.com/api/health
curl -i https://uniserver-632q.onrender.com/api/universities
```

A 404 on the second one is the state the site is built for: `loadUniversityContent`
resolves to `{}`, the map falls back to its hand-drawn SVG, and nothing else
changes. An account is optional on the site, not a gate.

**`POST /api/data` is preserved exactly as it was**: anonymous, no account id, a
five-point average band rather than an exact average.

## What it stores

| Collection | Fields |
| --- | --- |
| `accounts` | `username`, `usernameKey` (lowercase, unique), `passwordHash`, `isAdmin`, `createdAt`, `lastSeenAt` |
| `profiles` | `accountId`, `answers` (field, province, **average**, ambition, homeCity, coop, gradYear), `shortlist`, `courses`, `notes`, `tags`, `savedAt` |
| `submissions` | `field`, `province`, `averageBand`, `ambition`, `matchCount` — no account id |
| `universitycontents` | `universityId`, `description`, `blurb`, `links`, `updatedAt`, `updatedBy` — prose only, never a number |

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
| `TILE_URL_TEMPLATE` | no | Map tiles, e.g. `https://…/{z}/{x}/{y}.png?key=…`. Omit and the site keeps its SVG map |
| `TILE_ATTRIBUTION` | no | Shown on the map. Defaults to OpenStreetMap credit |
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

To open the **admin panel** locally you need an admin account, and admin is granted by hand in the
database — which you do not have on a throwaway in-memory one. `dev:admin` is `dev:memory` plus
"promote these usernames the moment they exist":

```bash
npm run dev:admin -- yourname
```

Sign up as `yourname` in the site and the panel appears. Local only: the database it promotes in
is in memory and vanishes when the process stops, so this cannot touch a deployment.

To see the real map rather than the SVG fallback, give it a tile provider:

```bash
TILE_URL_TEMPLATE="https://tile.openstreetmap.org/{z}/{x}/{y}.png" npm run dev:memory
```

That URL is fine for a few minutes of local testing. **Do not point production at it** —
OpenStreetMap's tile policy does not allow a proxy in front of it. Use a provider you have an
account with (MapTiler, Stadia, Thunderforest); the key stays in the environment either way.

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
| `GET /api/universities` | — | → `{universities}` — editable copy, public |
| `PUT /api/universities/:id` | Bearer + **admin** | `{description, blurb, links}` → `{university}` |
| `DELETE /api/universities/:id` | Bearer + **admin** | → `204` |
| `GET /api/map/config` | — | → `{available, attribution}` |
| `GET /api/map/tiles/:z/:x/:y` | — | → an image |
| `GET /api/health` | — | → `{ok, database}` |

Codes a client may see: `invalid_username`, `invalid_password`, `username_taken`,
`invalid_credentials`, `wrong_password`, `unauthorized`, `rate_limited`,
`database_unavailable`, `too_large`, `bad_json`, `not_found`, `server_error`,
`invalid_university`, `invalid_content`, `tiles_not_configured`, `bad_tile`,
`tile_unavailable`, `tile_missing`.

### Admins

`isAdmin` on an account is what gates the two write routes above. **There is no
route that sets it.** An endpoint that grants admin is an endpoint that can be
tricked into granting admin, and the number of admins here is small and changes
rarely, so it is a shell command:

```
db.accounts.updateOne({ usernameKey: 'yourname' }, { $set: { isAdmin: true } })
```

`GET /api/auth/me` reports `isAdmin` so the site knows whether to show the admin
screen. That is a convenience for rendering, never a permission — `requireAdmin`
re-reads the database on every write, because a token says who you are and only
the database says what you may do.

A non-admin hitting an admin route gets **404, not 403**. A 403 confirms the route
is real and that admin accounts exist to be found.

### The map tile proxy

`GET /api/map/tiles/:z/:x/:y` fetches one tile from `TILE_URL_TEMPLATE` and streams
it back. Two reasons it exists rather than pointing Leaflet straight at a provider:
the API key stays in Render's environment instead of a public static bundle, and
the provider sees this service rather than a student's IP and every map movement
they make — which is what lets `src/lib/api.ts` keep saying there is no third party.

The client supplies **three integers and nothing else**. The URL is assembled from
a template only the operator sets, zoom is capped at 19, and `x`/`y` must fall
inside the 2^z grid that zoom actually has. `tiles.test.js` covers the attempts:
`1e2`, `0x10`, `' 1 '`, `../`, and anything shaped like a host.

With `TILE_URL_TEMPLATE` unset, `/api/map/config` reports `available: false` and the
site keeps the hand-drawn SVG map it has always had. That is a supported state, not
a broken one — and it is the same fallback that covers a provider outage or a
sleeping instance.

### University content

`universitycontents` holds **prose only**: a description, a one-line blurb, some
links. Names, cities, provinces, program counts and every reported average stay in
the spreadsheet → `npm run data:build` → static JSON pipeline in the site repo,
where the moderation and the provenance rules live. Nothing here can contradict a
number, because nothing here holds a number.

It is additive, never authoritative. The site renders identically when the
collection is empty or the service is asleep: `loadUniversityContent` resolves to
`{}` on failure rather than rejecting, so a cold start costs a paragraph of prose,
not a page.

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
