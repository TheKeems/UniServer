// Entry point for the Render service.
//
//   MONGODB_URI   required   Atlas connection string
//   JWT_SECRET    required   32+ random characters
//   ALLOWED_ORIGINS         comma-separated; omit to allow any origin
//   PORT                    Render sets this
//
// The app itself is in app.js so the tests can build one without a listening
// socket or a process.exit. This file is only the boot.
//
// It starts even when Mongo is unreachable, deliberately: Render's health check
// hits the port, and a service that refuses to boot because Atlas is briefly down
// is a service that stays down afterwards. Requests that need the database answer
// 503 until it connects.

import { createApp } from './app.js'
import { connectToMongo } from './db.js'
import { canSign } from './tokens.js'

// Fail loudly and immediately on a missing secret rather than at the first signup:
// a service that boots and then 500s every auth request is much harder to
// diagnose than one that will not start.
if (!canSign()) {
  console.error('[fatal] JWT_SECRET is missing or too short. See server/README.md.')
  process.exit(1)
}

const port = process.env.PORT ?? 3000
const server = createApp().listen(port, () => console.log(`[uniserver] listening on ${port}`))

connectToMongo().catch((error) => {
  // Not fatal — db.js keeps retrying, and the 503 in app.js covers the gap.
  console.error('[mongo] initial connection failed:', error.message)
})

// Render sends SIGTERM when it spins the service down. Closing cleanly means
// in-flight writes finish instead of being cut off mid-request.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[uniserver] ${signal} — shutting down`)
    server.close(() => process.exit(0))
  })
}
