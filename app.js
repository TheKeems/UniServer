// The Express app, with no listening and no process.exit — so the tests can
// build one against an in-memory MongoDB and drive it over a real socket.
//
// `index.js` is the thin part that boots this on Render.

import express from 'express'
import cors from 'cors'
import { isConnected } from './db.js'
import { routes } from './routes.js'

export function createApp() {
  const app = express()

  // Render terminates TLS at its proxy, so the client's address arrives in
  // X-Forwarded-For. Without this the rate limiters see one address for the whole
  // internet — and express-rate-limit refuses to start if it detects a proxy it
  // was not told about. `1` is the number of proxies in front of this, not
  // `true`: trusting every hop lets a caller spoof the header and skip the limits.
  app.set('trust proxy', 1)
  app.disable('x-powered-by')

  /**
   * CORS.
   *
   * Wide open by default, because the site is served from GitHub Pages and from a
   * dev server on localhost. Set ALLOWED_ORIGINS in production to narrow it. The
   * credentials here travel in an Authorization header rather than a cookie, so
   * this is defence in depth rather than the thing standing between an attacker
   * and an account.
   */
  const allowed = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)

  app.use(
    cors({
      origin: allowed.length ? allowed : '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 86_400,
    }),
  )

  // 64kB is far more than any request here needs — the largest is a profile with
  // a few hundred program ids — and far less than enough to be worth sending as
  // an attack.
  app.use(express.json({ limit: '64kb' }))

  /**
   * Something to look at.
   *
   * The service used to answer 404 on every GET including `/`, which makes "is it
   * awake?" impossible to answer without writing data.
   */
  app.get('/', (_req, res) => {
    res.json({ service: 'uniserver', ok: true, database: isConnected() ? 'connected' : 'connecting' })
  })

  // What Render's health check should point at.
  app.get('/api/health', (_req, res) => {
    const ready = isConnected()
    res.status(ready ? 200 : 503).json({ ok: ready, database: ready ? 'connected' : 'unavailable' })
  })

  /**
   * Every route below needs the database.
   *
   * A clear 503 beats a request that hangs until the client's 45-second timeout,
   * which is what a mongoose call does while it is still connecting.
   */
  app.use('/api', (req, res, next) => {
    if (!isConnected()) {
      return res.status(503).json({
        error: {
          code: 'database_unavailable',
          message: 'The server is still waking up. Try again in a moment.',
        },
      })
    }
    next()
  })

  app.use('/api', routes)

  app.use((req, res) => {
    res
      .status(404)
      .json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}.` } })
  })

  /**
   * The last handler.
   *
   * Logs the real error server-side and tells the client nothing about it. A stack
   * trace or a mongoose validation message in a response body is how database
   * shapes and file paths end up in a bug-report screenshot.
   */
  app.use((error, req, res, _next) => {
    if (error?.type === 'entity.too.large') {
      return res
        .status(413)
        .json({ error: { code: 'too_large', message: 'That was too much data to send at once.' } })
    }
    if (error instanceof SyntaxError && 'body' in error) {
      return res
        .status(400)
        .json({ error: { code: 'bad_json', message: 'That request body was not valid JSON.' } })
    }
    console.error(`[error] ${req.method} ${req.path}`, error)
    res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong on our end.' } })
  })

  return app
}
