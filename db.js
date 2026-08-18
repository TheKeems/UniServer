// The MongoDB connection.
//
// Mongoose buffers commands while it connects, which sounds helpful and is not:
// on a cold Render instance a request would sit in that buffer until the client
// gave up, so the buffer is turned off and the API answers 503 instead (see the
// guard in index.js). A clear "still waking up" is a better thing to show a
// student than a spinner that never resolves.

import mongoose from 'mongoose'

const RETRY_MS = 5_000

export function isConnected() {
  // 1 = connected. 2 = connecting, which is not the same thing and must not
  // count: that is exactly the window where commands would be buffered.
  return mongoose.connection.readyState === 1
}

export async function connectToMongo() {
  const uri = process.env.MONGODB_URI
  if (!uri) {
    throw new Error('MONGODB_URI is not set. See server/README.md.')
  }

  mongoose.connection.on('connected', () => console.log('[mongo] connected'))
  mongoose.connection.on('disconnected', () => console.warn('[mongo] disconnected'))
  mongoose.connection.on('error', (error) => console.error('[mongo]', error.message))

  return attempt(uri)
}

async function attempt(uri) {
  try {
    await mongoose.connect(uri, {
      // Off, so a command against a disconnected client fails now rather than
      // waiting out a timeout with the request still open.
      bufferCommands: false,
      serverSelectionTimeoutMS: 10_000,
      // Atlas' free tier allows few connections and Render may run more than one
      // instance; a small pool leaves room for both.
      maxPoolSize: 5,
      minPoolSize: 0,
    })
    // Builds the unique index on usernameKey if it is not there yet. Without it,
    // two simultaneous signups for one username both succeed and the account
    // becomes unusable — findOne would return whichever the index happened to
    // reach first.
    await mongoose.connection.syncIndexes().catch((error) => {
      console.error('[mongo] index sync failed:', error.message)
    })
  } catch (error) {
    console.error(`[mongo] connection failed (${error.message}) — retrying in ${RETRY_MS / 1000}s`)
    setTimeout(() => attempt(uri).catch(() => {}), RETRY_MS).unref?.()
    throw error
  }
}
