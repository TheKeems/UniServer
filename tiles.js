// The map tile proxy.
//
// The dashboard's map used to be a hand-drawn SVG scatter with no basemap,
// because drawing a coastline the dataset does not contain would break the one
// rule the whole site runs on. A real basemap is not that: it is somebody else's
// surveyed data, correctly attributed, with our marks on top.
//
// WHY PROXY AT ALL, rather than pointing Leaflet straight at a tile provider:
//
//  1. THE KEY. Every provider worth using wants one, and a key in a static
//     GitHub Pages bundle is a public key. Here it lives in Render's environment
//     and never reaches a browser.
//  2. THE PROMISE. src/lib/api.ts opens with a list of everything that leaves a
//     student's device and states there is no third party. Tiles requested
//     straight from the browser would put a student's IP and their exact map
//     movements in a log we do not control, and would have made that list wrong.
//     Through here, the provider sees this service and nothing else.
//
// WHAT THIS IS NOT ALLOWED TO BECOME: an open forwarder. The client supplies
// three integers and nothing else — never a host, never a path, never a query.
// The URL is assembled from a template this service holds. That is the whole
// security model and it is why `TILE_URL_TEMPLATE` is an operator setting rather
// than a request parameter.

const MAX_ZOOM = 19

/** How long a browser may keep a tile. They effectively never change. */
const CACHE_SECONDS = 60 * 60 * 24 * 7

/** A provider that has not answered in this long is not going to. */
const TIMEOUT_MS = 8_000

/**
 * The configured template, e.g.
 *   https://tile.example.com/styles/basic/{z}/{x}/{y}.png?key=abc123
 *
 * Unset is a supported state, not a broken one: the client falls back to the
 * SVG map it already had, so the map keeps working with no provider account at
 * all. That fallback is also what covers a sleeping Render instance, so it has
 * to work regardless — see MapView.tsx.
 */
export function tileTemplate() {
  const value = process.env.TILE_URL_TEMPLATE
  return typeof value === 'string' && value.includes('{z}') ? value.trim() : null
}

/** Attribution the client must display. Providers require it; so does decency. */
export function tileAttribution() {
  return process.env.TILE_ATTRIBUTION ?? '© OpenStreetMap contributors'
}

/**
 * Turn three path segments into a URL, or explain why not.
 *
 * Every rejection here is a request that would otherwise have gone out to the
 * provider on our key. `Number.isInteger` after an explicit `/^\d+$/` test is
 * belt and braces on purpose: `Number(' 1 ')` is 1, `Number('1e2')` is 100, and
 * `Number('0x10')` is 16 — none of which are things a Leaflet tile URL contains,
 * and all of which would let one logical tile be requested under many spellings
 * and blow through a provider quota.
 */
export function tileUrl(z, x, y) {
  const template = tileTemplate()
  if (!template) return { problem: 'not_configured' }

  for (const part of [z, x, y]) {
    if (typeof part !== 'string' || !/^\d{1,7}$/.test(part)) return { problem: 'bad_coordinates' }
  }

  const zoom = Number(z)
  const col = Number(x)
  const row = Number(y)

  if (!Number.isInteger(zoom) || zoom < 0 || zoom > MAX_ZOOM) return { problem: 'bad_coordinates' }

  // At zoom z the grid is 2^z wide. Anything outside it is not a tile that
  // exists, and forwarding it is a request we pay for to receive a 404.
  const span = 2 ** zoom
  if (!Number.isInteger(col) || col < 0 || col >= span) return { problem: 'bad_coordinates' }
  if (!Number.isInteger(row) || row < 0 || row >= span) return { problem: 'bad_coordinates' }

  // String substitution of digits into a template the operator wrote. There is
  // no user-controlled text in the result: `zoom`, `col` and `row` are numbers
  // by this point, so no amount of cleverness in the path can add a host, a
  // query parameter or a traversal.
  return {
    url: template
      .replaceAll('{z}', String(zoom))
      .replaceAll('{x}', String(col))
      .replaceAll('{y}', String(row)),
  }
}

/**
 * Fetch one tile and stream it back.
 *
 * Deliberately forwards nothing from the incoming request — no headers, no
 * cookies, no user agent — so the provider learns about this service and not
 * about the student. The response is likewise reduced to a content type and a
 * cache header; a provider's own set-cookie or tracking headers do not travel on.
 */
export async function proxyTile(url, res) {
  const deadline = AbortSignal.timeout(TIMEOUT_MS)

  let upstream
  try {
    upstream = await fetch(url, {
      signal: deadline,
      redirect: 'follow',
      headers: {
        // Identify ourselves honestly. Several providers reject a request with
        // no user agent, and an operator reading their logs deserves to know
        // who this is.
        'User-Agent': 'Acceptiversity-UniServer/1.0 (+https://github.com/TheKeems/UniServer)',
        Accept: 'image/*',
      },
    })
  } catch {
    return res
      .status(502)
      .json({ error: { code: 'tile_unavailable', message: 'The map provider did not respond.' } })
  }

  if (!upstream.ok) {
    // Let go of the body rather than leaving it to the garbage collector: an
    // abandoned stream holds its socket and its buffered bytes open, and a
    // provider having a bad minute is exactly when those add up.
    upstream.body?.cancel?.().catch(() => {})
    // 404 on a tile is ordinary — ocean, or past the edge of a style's coverage.
    // It is passed through as a 404 rather than dressed up as a server error so
    // Leaflet renders its blank tile instead of retrying.
    return res.status(upstream.status === 404 ? 404 : 502).json({
      error: {
        code: upstream.status === 404 ? 'tile_missing' : 'tile_unavailable',
        message: 'That map tile is not available.',
      },
    })
  }

  const type = upstream.headers.get('content-type') ?? ''
  // Only images come back out. A provider returning an HTML error page — which
  // is what a bad key usually gets you — must not be handed to a browser as
  // though this service had produced it.
  if (!type.startsWith('image/')) {
    upstream.body?.cancel?.().catch(() => {})
    return res
      .status(502)
      .json({ error: { code: 'tile_unavailable', message: 'The map provider returned something unexpected.' } })
  }

  // READ THE BODY FIRST, then commit to the headers.
  //
  // The other order looks harmless and is not: if the read fails — a connection
  // dropped mid-tile — the caller's catch sends a JSON error, but the response
  // is already committed to `Content-Type: image/png` and to a week of
  // `immutable` caching. The browser would then hold a cached "tile" that is
  // actually an error document, and re-serve it for seven days without asking.
  let body
  try {
    body = Buffer.from(await upstream.arrayBuffer())
  } catch {
    return res
      .status(502)
      .json({ error: { code: 'tile_unavailable', message: 'That map tile did not arrive intact.' } })
  }

  res.setHeader('Content-Type', type)
  res.setHeader('Cache-Control', `public, max-age=${CACHE_SECONDS}, immutable`)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  return res.send(body)
}
