import { publicReadHeaders } from '@/lib/api-cache'
import { BUILD_SECTIONS } from '@/lib/build-guide'
import { guideMarkdown } from '@/lib/guide-markdown'

const siteOrigin = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3001'

/** The Build guide as Markdown for agents, from the same sections /build renders. */
const BUILD_MD = guideMarkdown({
  title: 'Build on Juicebox',
  intro: 'Launch a project, build an app, or write contracts.',
  pageUrl: `${siteOrigin}/build`,
  sections: BUILD_SECTIONS,
})

export const revalidate = 3600

export function GET() {
  return new Response(BUILD_MD, {
    headers: { ...publicReadHeaders, 'content-type': 'text/markdown; charset=utf-8' },
  })
}
