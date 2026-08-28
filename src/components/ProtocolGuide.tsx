import { GuideInteractions } from '@/components/GuideInteractions'
import { buildGuideHtml, learnGuideHtml } from '@/lib/juicescan-learn-build'

export function ProtocolGuide({ guide }: { guide: 'learn' | 'build' }) {
  const containerId = `tab-${guide}`
  // Trusted in-repo constant: the guide markup is assembled entirely from
  // string literals in juicescan-learn-build.ts, with every interpolated value
  // escaped there. No user input reaches this HTML. Rendering it on the server
  // is what makes the guides readable to crawlers that do not execute JS.
  const guideHtml = guide === 'learn' ? learnGuideHtml() : buildGuideHtml()

  return (
    <>
      <div
        id={containerId}
        className="juicebox-guide"
        aria-label={guide === 'learn' ? 'Learn Juicebox' : 'Build with Juicebox'}
        dangerouslySetInnerHTML={{ __html: guideHtml }}
      />
      <GuideInteractions containerId={containerId} />
    </>
  )
}
