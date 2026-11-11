import { publicReadHeaders } from '@/lib/api-cache'
import { guideMarkdown } from '@/lib/guide-markdown'
import { LEARN_SECTIONS } from '@/lib/learn-guide'

const siteOrigin = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3001'

/** The Learn guide as Markdown for agents, from the same sections /learn renders. */
const LEARN_MD = guideMarkdown({
  title: 'Learn Juicebox',
  intro: 'Where your money goes, what project tokens let you do, and who can change the rules.',
  pageUrl: `${siteOrigin}/learn`,
  sections: LEARN_SECTIONS,
})

export const revalidate = 3600

export function GET() {
  return new Response(LEARN_MD, {
    headers: { ...publicReadHeaders, 'content-type': 'text/markdown; charset=utf-8' },
  })
}
