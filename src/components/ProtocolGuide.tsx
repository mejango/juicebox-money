import { GuideSections } from '@/components/GuideSections'
import { BUILD_SECTIONS } from '@/lib/build-guide'
import { LEARN_SECTIONS } from '@/lib/learn-guide'

export function ProtocolGuide({ guide }: { guide: 'learn' | 'build' }) {
  return (
    <div id={`tab-${guide}`}>
      <GuideSections
        sections={guide === 'learn' ? LEARN_SECTIONS : BUILD_SECTIONS}
        ariaLabel={guide === 'learn' ? 'Learn Juicebox' : 'Build with Juicebox'}
      />
    </div>
  )
}
