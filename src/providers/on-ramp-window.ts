/**
 * Open the on-ramp window. Call it synchronously inside the click.
 *
 * A window opened after an await is blocked once the click's activation is spent (5s in
 * Chrome, sooner in Safari), and Para's own opener then waits on the blocked window forever.
 * With no URL it opens blank, to be pointed at the portal once Para has one.
 *
 * Never `noopener`: the portal talks to `window.opener`, and without one it cannot load the
 * purchase.
 *
 * Kept apart from `para-config` so the click path does not pull in the Para SDK.
 */
export function openOnRampWindow(url = ''): Window | null {
  try {
    return window.open(url, 'ParaOnRamp', 'popup,width=420,height=640')
  } catch {
    return null
  }
}
