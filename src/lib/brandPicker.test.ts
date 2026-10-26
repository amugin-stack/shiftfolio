import { describe, expect, it } from 'vitest'
import { activeBrandId, filterBrands } from './brandPicker'

describe('activeBrandId', () => {
  it('extracts the id from a /calendar/[id] path', () => {
    expect(activeBrandId('/calendar/abc')).toBe('abc')
  })

  it('extracts the id from a nested calendar route', () => {
    expect(activeBrandId('/calendar/abc/anything')).toBe('abc')
  })

  it('ignores a trailing query string or hash', () => {
    expect(activeBrandId('/calendar/abc?month=2026-06')).toBe('abc')
    expect(activeBrandId('/calendar/abc#top')).toBe('abc')
  })

  it('returns null for the /calendar landing route', () => {
    expect(activeBrandId('/calendar')).toBeNull()
    expect(activeBrandId('/calendar/')).toBeNull()
  })

  it('returns null for unrelated routes', () => {
    expect(activeBrandId('/admin/dashboard')).toBeNull()
    expect(activeBrandId('/my-shifts')).toBeNull()
  })

  it('returns null for a missing pathname', () => {
    expect(activeBrandId(null)).toBeNull()
    expect(activeBrandId(undefined)).toBeNull()
    expect(activeBrandId('')).toBeNull()
  })
})

describe('filterBrands', () => {
  const brands = [
    { id: '1', name: 'Acme' },
    { id: '2', name: 'Globex' },
    { id: '3', name: 'Initech' },
    { id: '4', name: 'acme labs' },
  ]

  it('returns every brand for an empty or whitespace query', () => {
    expect(filterBrands(brands, '')).toHaveLength(4)
    expect(filterBrands(brands, '   ')).toHaveLength(4)
  })

  it('matches case-insensitively on a name substring', () => {
    const result = filterBrands(brands, 'acme')
    expect(result.map(b => b.id)).toEqual(['1', '4'])
  })

  it('trims surrounding whitespace before matching', () => {
    expect(filterBrands(brands, '  globex  ').map(b => b.id)).toEqual(['2'])
  })

  it('matches an interior substring', () => {
    expect(filterBrands(brands, 'tech').map(b => b.id)).toEqual(['3'])
  })

  it('returns an empty array when nothing matches', () => {
    expect(filterBrands(brands, 'zzz')).toEqual([])
  })
})
