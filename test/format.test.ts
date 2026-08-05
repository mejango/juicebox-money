import { describe, expect, it } from 'vitest'
import { billionthsToPct, fmtPct, projectLogoUrl } from '@/lib/format'

describe('percent formatting', () => {
  it('keeps ordinary percentages compact', () => {
    expect(fmtPct(38)).toBe('38%')
    expect(billionthsToPct(75_000_000)).toBe('7.5%')
  })

  it('never presents a non-zero issuance cut as zero', () => {
    expect(billionthsToPct(9_496)).toBe('0.0009496%')
  })
})

describe('project logo URLs', () => {
  it('passes supported inline images through without rewriting them as IPFS', () => {
    const svg =
      'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E'
    expect(projectLogoUrl(svg)).toBe(svg)
    expect(projectLogoUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    )
  })

  it('keeps IPFS support and rejects script-bearing or non-image schemes', () => {
    expect(projectLogoUrl('ipfs://QmLogo')).toBe(
      'https://gateway.pinata.cloud/ipfs/QmLogo',
    )
    expect(projectLogoUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
    expect(
      projectLogoUrl(
        'data:image/svg+xml,%3Csvg%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E%3C%2Fsvg%3E',
      ),
    ).toBeNull()
    expect(projectLogoUrl('javascript:alert(1)')).toBeNull()
    expect(projectLogoUrl('blob:https://example.com/id')).toBeNull()
  })
})
