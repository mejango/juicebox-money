import type { Config } from 'tailwindcss'

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        juice: { 50: '#FFF8EB', 100: '#FFEECB', 400: '#FFB32C', 500: '#F5A312', 600: '#E39117' },
        cream: '#FFFDF8',
        ink: '#201E1A',
      },
    },
  },
  plugins: [],
} satisfies Config
