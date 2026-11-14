import { describe, expect, it, vi } from 'vitest'
import type { Address, PublicClient } from 'viem'

const mocks = vi.hoisted(() => ({ permissions: vi.fn() }))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({ ...await original<typeof import('@bananapus/nana-sdk-core/v6')>(), hasPermissions: mocks.permissions }))

import { canUseAllowance } from '@/components/project/FundsTab'

const OWNER = '0x1111111111111111111111111111111111111111' as Address
const OPERATOR = '0x2222222222222222222222222222222222222222' as Address
const client = { readContract: vi.fn(async () => OWNER) } as unknown as PublicClient

describe('who may use a surplus allowance', () => {
  it('lets the owner through without a permission read', async () => {
    await expect(canUseAllowance(client, 8453, 7, OWNER.toUpperCase().replace('0X', '0x') as Address)).resolves.toBe(true)
    expect(mocks.permissions).not.toHaveBeenCalled()
  })
  it('asks for USE_ALLOWANCE (18) from the owner, for this project on this chain', async () => {
    mocks.permissions.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await expect(canUseAllowance(client, 8453, 7, OPERATOR)).resolves.toBe(true)
    expect(mocks.permissions).toHaveBeenCalledWith(client, { chainId: 8453, operator: OPERATOR, account: OWNER, projectId: 7n, permissionIds: [18] })
    await expect(canUseAllowance(client, 8453, 7, OPERATOR)).resolves.toBe(false)
  })
})
