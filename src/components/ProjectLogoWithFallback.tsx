'use client'

import { useState } from 'react'
import { ProjectLogo, type ProjectLogoProps } from '@/components/ProjectLogo'

/** Project-page logo which replaces a failed image with ProjectLogo's tile. */
export function ProjectLogoWithFallback(props: ProjectLogoProps) {
  const [failedLogoUri, setFailedLogoUri] = useState<string | null>(null)
  const failed = !!props.logoUri && props.logoUri === failedLogoUri
  return (
    <ProjectLogo
      {...props}
      logoUri={failed ? null : props.logoUri}
      onError={() => setFailedLogoUri(props.logoUri)}
    />
  )
}
