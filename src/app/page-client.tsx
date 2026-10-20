'use client'

// The home page's own client references. Next merges the root layout's and the
// home page's client manifests, and a client module both render takes the chunk
// list of whichever merged last: AuditPromptLink (also in the footer) carried
// the home page's chunks onto every route. Importing it through this module
// gives the home page a reference of its own.
export { AuditPromptLink as HomeAuditPromptLink } from '@/components/AuditPromptLink'
