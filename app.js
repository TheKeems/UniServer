// The Express app, with no listening and no process.exit — so the tests can
// build one against an in-memory MongoDB and drive it over a real socket.
//
// `index.js` is the thin part that boots this on Render.

import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { isConnected } from './db.js'
import { routes } from './routes.js'
import { proxyTile, tileAttribution, tileTemplate, tileUrl } from './tiles.js'

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

  /* ------------------------------------------------------------- the map --- */
  // Mounted ABOVE the database gate below, because a basemap has nothing to do
  // with Mongo. A sleeping Atlas should cost you your shortlist, not the map.

  /**
   * What the client needs to decide whether to draw a real map at all.
   *
   * `available: false` is a supported answer, not an error: with no provider
   * configured the client keeps the hand-drawn SVG map it has always had. That
   * fallback also covers a provider outage, so it has to work either way — and
   * asking once here is cheaper than discovering it through failed tiles.
   */
  app.get('/api/map/config', (_req, res) => {
    res.json({ available: Boolean(tileTemplate()), attribution: tileAttribution() })
  })

  /**
   * One tile.
   *
   * Rate limited well above what a person panning a map generates and well below
   * what would empty a provider quota. Tiles are cached hard by the browser, so
   * a real session makes far fewer requests than it looks like it should.
   */
  const tileLimit = rateLimit({
    windowMs: 60 * 1000,
    limit: 600,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'rate_limited', message: 'Too many map tiles at once.' } },
  })

  app.get('/api/map/tiles/:z/:x/:y', tileLimit, (req, res) => {
    const { url, problem } = tileUrl(req.params.z, req.params.x, req.params.y)
    if (problem === 'not_configured') {
      return res.status(503).json({
        error: { code: 'tiles_not_configured', message: 'No map provider is configured.' },
      })
    }
    if (problem) {
      return res
        .status(400)
        .json({ error: { code: 'bad_tile', message: 'That is not a valid tile coordinate.' } })
    }
    return proxyTile(url, res).catch(() =>
      res
        .status(502)
        .json({ error: { code: 'tile_unavailable', message: 'The map provider did not respond.' } }),
    )
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
