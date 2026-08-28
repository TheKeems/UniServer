// Unit tests for the map tile proxy.
//
// This is the one place in the service where a request from the open internet
// causes an outbound request on our key, so the interesting cases are all the
// ones where a client tries to influence WHERE that request goes. The rule the
// module exists to hold is that it accepts three integers and nothing else.

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tileAttribution, tileTemplate, tileUrl } from './tiles.js'

const TEMPLATE = 'https://tiles.example.com/v1/{z}/{x}/{y}.png?key=secret'

afterEach(() => {
  delete process.env.TILE_URL_TEMPLATE
  delete process.env.TILE_ATTRIBUTION
})

describe('tileTemplate', () => {
  it('is null when nothing is configured, which is a supported state', () => {
    // No provider means the client keeps the SVG map it already had. That has to
    // be an ordinary answer, not an error, or the map breaks for anyone who has
    // not signed up for a tile account.
    assert.equal(tileTemplate(), null)
  })

  it('refuses a template with no {z}, which would fetch the same tile forever', () => {
    process.env.TILE_URL_TEMPLATE = 'https://tiles.example.com/fixed.png'
    assert.equal(tileTemplate(), null)
  })

  it('accepts a real template', () => {
    process.env.TILE_URL_TEMPLATE = TEMPLATE
    assert.equal(tileTemplate(), TEMPLATE)
  })
})

describe('tileAttribution', () => {
  it('always returns something, because providers require it', () => {
    assert.ok(tileAttribution().length > 0)
  })

  it('can be set per provider', () => {
    process.env.TILE_ATTRIBUTION = '© Example Maps'
    assert.equal(tileAttribution(), '© Example Maps')
  })
})

describe('tileUrl', () => {
  it('says so when no provider is configured', () => {
    assert.equal(tileUrl('10', '100', '200').problem, 'not_configured')
  })

  it('substitutes the three coordinates into the operator’s template', () => {
    process.env.TILE_URL_TEMPLATE = TEMPLATE
    const { url, problem } = tileUrl('10', '100', '200')
    assert.equal(problem, undefined)
    assert.equal(url, 'https://tiles.example.com/v1/10/100/200.png?key=secret')
  })

  // Everything below is a request that would otherwise have gone out on our key.
  it('refuses anything that is not a plain run of digits', () => {
    process.env.TILE_URL_TEMPLATE = TEMPLATE
    for (const bad of [
      ' 1 ', // Number(' 1 ') is 1 — one tile, many spellings, one quota
      '1e2', // Number('1e2') is 100
      '0x10', // Number('0x10') is 16
      '+1',
      '-1',
      '1.0',
      'abc',
      '',
      '../../etc/passwd',
      '10/../../secret',
      '%2e%2e',
    ]) {
      assert.equal(tileUrl('10', bad, '200').problem, 'bad_coordinates', `x=${bad}`)
      assert.equal(tileUrl(bad, '100', '200').problem, 'bad_coordinates', `z=${bad}`)
    }
  })

  it('refuses a non-string coordinate', () => {
    process.env.TILE_URL_TEMPLATE = TEMPLATE
    assert.equal(tileUrl(10, 100, 200).problem, 'bad_coordinates')
    assert.equal(tileUrl(null, '1', '1').problem, 'bad_coordinates')
    assert.equal(tileUrl(undefined, '1', '1').problem, 'bad_coordinates')
  })

  it('refuses a zoom outside what any style serves', () => {
    process.env.TILE_URL_TEMPLATE = TEMPLATE
    assert.equal(tileUrl('20', '1', '1').problem, 'bad_coordinates')
    assert.equal(tileUrl('9999999', '1', '1').problem, 'bad_coordinates')
    assert.equal(tileUrl('19', '1', '1').problem, undefined)
    assert.equal(tileUrl('0', '0', '0').problem, undefined)
  })

  it('refuses a tile outside the grid that zoom actually has', () => {
    process.env.TILE_URL_TEMPLATE = TEMPLATE
    // At zoom 1 the world is 2x2. Tile (2,0) does not exist, and forwarding it
    // is a request we pay for in order to receive a 404.
    assert.equal(tileUrl('1', '2', '0').problem, 'bad_coordinates')
    assert.equal(tileUrl('1', '0', '2').problem, 'bad_coordinates')
    assert.equal(tileUrl('1', '1', '1').problem, undefined)
    assert.equal(tileUrl('0', '1', '0').problem, 'bad_coordinates')
  })

  it('cannot be made to point at another host', () => {
    process.env.TILE_URL_TEMPLATE = TEMPLATE
    // The whole security model: the client supplies digits, the operator
    // supplies the URL. There is no input that changes the host.
    for (const attempt of ['//evil.example', 'https://evil.example', '@evil.example', '?x=']) {
      assert.equal(tileUrl('10', attempt, '1').problem, 'bad_coordinates', attempt)
    }
    const { url } = tileUrl('10', '100', '200')
    assert.equal(new URL(url).host, 'tiles.example.com')
  })

  it('leaves a template with repeated placeholders consistent', () => {
    // replaceAll, not replace: a provider whose path repeats {z} would otherwise
    // get one substituted and one literal.
    process.env.TILE_URL_TEMPLATE = 'https://t.example.com/{z}/{z}/{x}/{y}.png'
    assert.equal(tileUrl('7', '3', '4').url, 'https://t.example.com/7/7/3/4.png')
  })
})
