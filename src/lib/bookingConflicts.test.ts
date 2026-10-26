import { describe, expect, it } from 'vitest'
import { overlaps, buildBusyMaps } from './bookingConflicts'
import type { BusyStream } from './bookingConflicts'

// Integer-ms fixtures for clarity: windows like (100, 200), streams at (150, 250).
// A small factory builds a BusyStream with sensible defaults; override per case.
const bs = (over: Partial<BusyStream> = {}): BusyStream => ({
  id: 's1',
  hostId: 'h1',
  moderatorId: 'm1',
  startMs: 150,
  endMs: 250,
  brandName: 'Brand A',
  ...over,
})

describe('overlaps', () => {
  it('clear overlap → true', () => {
    expect(overlaps(100, 200, 150, 250)).toBe(true)
  })

  it('touching (a.end === b.start) → false in both orders', () => {
    expect(overlaps(100, 200, 200, 300)).toBe(false)
    expect(overlaps(200, 300, 100, 200)).toBe(false)
  })

  it('containment → true', () => {
    expect(overlaps(100, 300, 150, 200)).toBe(true)
    expect(overlaps(150, 200, 100, 300)).toBe(true)
  })

  it('disjoint → false', () => {
    expect(overlaps(100, 200, 300, 400)).toBe(false)
  })

  it('identical ranges → true', () => {
    expect(overlaps(100, 200, 100, 200)).toBe(true)
  })
})

describe('buildBusyMaps', () => {
  it('a stream overlapping the window with a host and a mod → both ids mapped to its brand', () => {
    const { busyHosts, busyMods } = buildBusyMaps([bs()], 100, 200, [])
    expect(busyHosts.get('h1')).toBe('Brand A')
    expect(busyMods.get('m1')).toBe('Brand A')
  })

  it('a stream NOT overlapping the window → ignored', () => {
    // Stream 300–400 is disjoint from window 100–200.
    const { busyHosts, busyMods } = buildBusyMaps([bs({ startMs: 300, endMs: 400 })], 100, 200, [])
    expect(busyHosts.has('h1')).toBe(false)
    expect(busyMods.has('m1')).toBe(false)
  })

  it('a stream whose id is in excludeIds → ignored even though it overlaps', () => {
    const { busyHosts, busyMods } = buildBusyMaps([bs({ id: 'edit-me' })], 100, 200, ['edit-me'])
    expect(busyHosts.size).toBe(0)
    expect(busyMods.size).toBe(0)
  })

  it('null hostId → host side contributes nothing (mod still mapped)', () => {
    const { busyHosts, busyMods } = buildBusyMaps([bs({ hostId: null })], 100, 200, [])
    expect(busyHosts.size).toBe(0)
    expect(busyMods.get('m1')).toBe('Brand A')
  })

  it('null moderatorId → mod side contributes nothing (host still mapped)', () => {
    const { busyHosts, busyMods } = buildBusyMaps([bs({ moderatorId: null })], 100, 200, [])
    expect(busyHosts.get('h1')).toBe('Brand A')
    expect(busyMods.size).toBe(0)
  })

  it('both ids null → contributes nothing', () => {
    const { busyHosts, busyMods } = buildBusyMaps(
      [bs({ hostId: null, moderatorId: null })],
      100,
      200,
      [],
    )
    expect(busyHosts.size).toBe(0)
    expect(busyMods.size).toBe(0)
  })

  it('first-brand-wins: two overlapping streams for the same host → first brand is kept', () => {
    const { busyHosts } = buildBusyMaps(
      [
        bs({ id: 'a', moderatorId: null, brandName: 'Brand First' }),
        bs({ id: 'b', moderatorId: null, brandName: 'Brand Second' }),
      ],
      100,
      200,
      [],
    )
    expect(busyHosts.get('h1')).toBe('Brand First')
  })

  it('any-brand: a conflict in a different brand still counts', () => {
    // No brand argument exists; a stream on any brand that overlaps is a conflict.
    const { busyHosts, busyMods } = buildBusyMaps(
      [bs({ brandName: 'Some Other Brand' })],
      100,
      200,
      [],
    )
    expect(busyHosts.get('h1')).toBe('Some Other Brand')
    expect(busyMods.get('m1')).toBe('Some Other Brand')
  })

  it('zero-length stream (endMs === startMs) → ignored', () => {
    const { busyHosts, busyMods } = buildBusyMaps([bs({ startMs: 150, endMs: 150 })], 100, 200, [])
    expect(busyHosts.size).toBe(0)
    expect(busyMods.size).toBe(0)
  })

  it('negative-length stream (endMs < startMs) → ignored', () => {
    const { busyHosts, busyMods } = buildBusyMaps([bs({ startMs: 180, endMs: 120 })], 100, 200, [])
    expect(busyHosts.size).toBe(0)
    expect(busyMods.size).toBe(0)
  })

  it('excludeIds works when passed an array', () => {
    const { busyHosts } = buildBusyMaps([bs({ id: 'x' })], 100, 200, ['x'])
    expect(busyHosts.size).toBe(0)
  })

  it('excludeIds works when passed a Set', () => {
    const { busyHosts } = buildBusyMaps([bs({ id: 'x' })], 100, 200, new Set(['x']))
    expect(busyHosts.size).toBe(0)
  })
})
