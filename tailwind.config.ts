import type { Config } from 'tailwindcss'

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // "Juice terminal" palette — see DESIGN.md §Color.
        bg: '#141217',
        panel: '#1c1922',
        panel2: '#221e2a',
        well: '#0f0d12',
        frame: '#39333f',
        ink: '#F2EFE6',
        dim: '#9b95a8',
        juice: { DEFAULT: '#FFB32C', 400: '#FFB32C', 500: '#F5A312', 600: '#E39117' },
        jcyan: '#46E4D8',
        lime: '#7DE858',
        magenta: '#E85D9B',
        jteal: '#2A9D8F',
        olive: '#8A8A1F',
        navy: '#274690',
      },
      fontFamily: {
        // Voice 1 — display: heavy tight neo-grotesque for headlines.
        display: ['-apple-system', '"Helvetica Neue"', 'Inter', 'Arial', 'sans-serif'],
        // Voice 2 — data/body: system mono for everything informational.
        mono: ['ui-monospace', '"SF Mono"', '"Cascadia Mono"', 'Menlo', 'monospace'],
        // Voice 3 — pixel: Silkscreen for buttons/badges only.
        pixel: ['var(--font-pixel)', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config
