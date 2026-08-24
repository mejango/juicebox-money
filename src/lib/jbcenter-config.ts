import { JBCENTER_DEFAULT_URL } from '@bananapus/nana-sdk-core/jbcenter'

const DEV_SITE_URL = 'https://dev.juicebox.money'
const LOCAL_SITE_URL = 'http://localhost:3001'
const DEV_CENTER_URL = 'https://dev.juicebox.center'
const PRODUCTION_SITE_URL = 'https://juicebox.money'

function isDevSite(
  siteUrl: string | undefined,
): siteUrl is typeof DEV_SITE_URL | typeof LOCAL_SITE_URL {
  return siteUrl === DEV_SITE_URL || siteUrl === LOCAL_SITE_URL
}

export function jbCenterBaseUrl(
  siteUrl = process.env.NEXT_PUBLIC_SITE_URL,
): string {
  return isDevSite(siteUrl) ? DEV_CENTER_URL : JBCENTER_DEFAULT_URL
}

export function jbCenterAppOrigin(
  siteUrl = process.env.NEXT_PUBLIC_SITE_URL,
): string {
  return isDevSite(siteUrl) ? siteUrl : PRODUCTION_SITE_URL
}
