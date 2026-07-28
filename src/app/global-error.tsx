'use client'

/** Last-resort boundary: renders without the app shell, so keep it inline-styled. */
export default function GlobalError({
  reset,
}: {
  error: Error
  reset: () => void
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'sans-serif',
          padding: '4rem 2rem',
          textAlign: 'center',
        }}
      >
        <h1 style={{ fontSize: '1.1rem' }}>Something went wrong.</h1>
        <button
          type="button"
          onClick={() => {
            reset()
            window.location.reload()
          }}
          style={{
            marginTop: '1rem',
            padding: '0.5rem 1rem',
            cursor: 'pointer',
          }}
        >
          Reload
        </button>
      </body>
    </html>
  )
}
