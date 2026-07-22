import { describe, expect, it } from 'vitest'

describe('deterministic unit network boundary', () => {
  it('rejects every unstubbed browser transport', async () => {
    await expect(fetch('https://example.com/should-not-run')).rejects.toThrow(
      'Unexpected network request in unit test',
    )
    expect(() => new XMLHttpRequest()).toThrow(
      'Unexpected XMLHttpRequest connection in unit test',
    )
    expect(() => new WebSocket('wss://example.com/should-not-run')).toThrow(
      'Unexpected WebSocket connection in unit test',
    )
    expect(() => new EventSource('https://example.com/should-not-run')).toThrow(
      'Unexpected EventSource connection in unit test',
    )
  })
})
