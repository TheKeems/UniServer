// Same as dev-memory.mjs, plus: any account you name on the command line is
// promoted to admin as soon as it exists.
//
//   node dev-admin.mjs testadmin
//
// Admin is granted by hand in the database and there is no route that sets it —
// which is correct, and which makes the admin panel impossible to open on a
// throwaway in-memory database. This exists so that "log in and look at it"
// takes a second rather than requiring a real MongoDB.
//
// LOCAL ONLY. It boots an in-memory mongod, so there is nothing here that could
// touch a real deployment: the database it promotes an account in disappears
// when the process stops.

import { MongoMemoryServer } from 'mongodb-memory-server'

const PORT = process.env.PORT ?? 3001
const PROMOTE = process.argv.slice(2)

const mongod = await MongoMemoryServer.create()
process.env.MONGODB_URI = mongod.getUri()
process.env.JWT_SECRET ??= 'local-development-secret-not-for-anything-real'

const { connectToMongo } = await import('./db.js')
const { createApp } = await import('./app.js')
const { Account } = await import('./models.js')

await connectToMongo()

const server = createApp().listen(PORT, () => {
  console.log(`[dev-admin] http://localhost:${PORT} — in-memory mongo, nothing persisted`)
  if (PROMOTE.length) console.log(`[dev-admin] will promote on sight: ${PROMOTE.join(', ')}`)
})

// Poll rather than hook the signup route: the point is to leave the real routes
// completely untouched, so what you are testing is the actual service.
if (PROMOTE.length) {
  const keys = PROMOTE.map((n) => n.toLowerCase())
  const seen = new Set()
  setInterval(async () => {
    for (const key of keys) {
      if (seen.has(key)) continue
      const result = await Account.updateOne({ usernameKey: key }, { $set: { isAdmin: true } })
      if (result.matchedCount) {
        seen.add(key)
        console.log(`[dev-admin] promoted ${key} to admin`)
      }
    }
  }, 1000).unref()
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(async () => {
      await mongod.stop()
      process.exit(0)
    })
  })
}
