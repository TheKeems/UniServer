// The whole service, locally, with no MongoDB to install.
//
//   npm run dev:memory        (needs the mongodb-memory-server dev dependency)
//
// Boots the real app — same routes, same hashing, same validation — against an
// in-memory mongod. Nothing is persisted: every restart is a clean database,
// which is exactly what you want when testing sign-up flows over and over.
//
// Point the frontend at it from the project root:
//
//   VITE_API_BASE_URL=http://localhost:3001 npm run dev
//
// Note the rate limits are real here too. Ten signups an hour per address is easy
// to hit while testing, and the answer is to restart this process — the limiter
// keeps its counters in memory.

import { MongoMemoryServer } from 'mongodb-memory-server'

const PORT = process.env.PORT ?? 3001

const mongod = await MongoMemoryServer.create()
process.env.MONGODB_URI = mongod.getUri()
// Only for local development. Render gets a real one from its environment.
process.env.JWT_SECRET ??= 'local-development-secret-not-for-anything-real'

const { connectToMongo } = await import('./db.js')
const { createApp } = await import('./app.js')

await connectToMongo()

const server = createApp().listen(PORT, () => {
  console.log(`[dev-memory] http://localhost:${PORT} — in-memory mongo, nothing persisted`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(async () => {
      await mongod.stop()
      process.exit(0)
    })
  })
}
