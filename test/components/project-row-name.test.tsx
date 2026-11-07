import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProjectRowName, repeatedNames } from '@/components/ProjectRowName'

describe('ranked row names', () => {
  it('finds only names the list repeats', () => {
    expect([...repeatedNames([{ name: 'A' }, { name: 'B' }, { name: 'A' }])]).toEqual(['A'])
  })

  it('shows the project ID only on a repeated name', () => {
    const row = (repeated: boolean) =>
      renderToStaticMarkup(createElement(ProjectRowName, { name: 'BTC/USD', projectId: 34, repeated }))
    expect(row(true)).toMatch(/#(<!-- -->)?34/)
    expect(row(false)).not.toContain('34')
  })
})
