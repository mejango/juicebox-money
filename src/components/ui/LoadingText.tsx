/** CSS-only progress dots keep the original text available to screen readers. */
export function LoadingText({ text, active = /(?:…|\.{3})$/.test(text) }: { text: string; active?: boolean }) {
  if (!active) return <>{text}</>;
  const label = text.replace(/(?:…|\.{3}|\.)$/, "");
  return <span>{label}<span className="sr-only">{text.slice(label.length)}</span><span aria-hidden="true" className="loading-dots" /></span>;
}
