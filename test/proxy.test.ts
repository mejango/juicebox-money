import { NextRequest } from 'next/server'
import { describe, expect, it } from 'vitest'
import { proxy } from '@/proxy'

const request = (path: string) =>
  new NextRequest(`https://juicebox.money${path}`)

describe('proxy', () => {
  it('leaves a project route to the app', () => {
    expect(proxy(request('/eth:1'))).toBeUndefined()
    expect(proxy(request('/eth%3A1'))).toBeUndefined()
  })

  it('hands a path holding a literal % to the legacy site instead of failing', () => {
    // `/%25` decodes to `%`, which is not a route and must not throw.
    const response = proxy(request('/%25'))
    expect(response?.status).toBe(307)
    expect(response?.headers.get('location')).toBe(
      'https://old.juicebox.money/%25',
    )
  })
})
