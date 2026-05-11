import type { Config } from 'tailwindcss';

// Claude-inspired aesthetic. Warm paper + coral. Editorial typography.
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Surfaces — warm paper
        paper: {
          DEFAULT: '#FAF9F5', // canvas
          card: '#FFFFFF',
          subtle: '#F2EFE6',
          deep: '#EDE9DB'
        },
        // Ink — warm black
        ink: {
          DEFAULT: '#1F1F1C',
          soft: '#2A2A26',
          muted: '#5A5A57',
          quiet: '#8A8782',
          ghost: '#B8B5AE',
          inverse: '#FAF9F5'
        },
        // Border — warm gray
        rule: {
          DEFAULT: '#E8E3D5',
          strong: '#DBD5C3',
          soft: '#F0EBDC'
        },
        // Coral — Claude's signature accent
        coral: {
          DEFAULT: '#D97757',
          deep: '#C76A4D',
          subtle: '#FCEEE2',
          mute: '#F5DCC9'
        },
        // Status palette (warm-tinted)
        forest: '#5C7F5A',     // success / high energy
        amber: '#D49B40',      // warning / partial
        rust: '#B85850',       // danger / burnt
        sky: '#5681A8',        // info / running
        // Legacy aliases (kept so existing components don't break)
        bg: { DEFAULT: '#FAF9F5', sidebar: '#F2EFE6', hover: '#EDE9DB', active: '#FCEEE2' },
        text: { primary: '#1F1F1C', secondary: '#5A5A57', muted: '#8A8782', inverse: '#FAF9F5' },
        border: { DEFAULT: '#E8E3D5', strong: '#DBD5C3', focus: '#D97757' },
        accent: { success: '#5C7F5A', warning: '#D49B40', danger: '#B85850', info: '#5681A8', neutral: '#8A8782', product: '#D97757' }
      },
      fontFamily: {
        sans: ['var(--font-geist-sans)', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
        mono: ['var(--font-geist-mono)', 'monospace'],
        serif: ['var(--font-source-serif)', 'Songti SC', 'SimSun', 'Georgia', 'serif']
      },
      fontSize: {
        // Editorial display ramp
        hero: ['44px', { lineHeight: '48px', letterSpacing: '-0.025em', fontWeight: '500' }],
        display: ['32px', { lineHeight: '38px', letterSpacing: '-0.02em', fontWeight: '500' }],
        title: ['22px', { lineHeight: '28px', letterSpacing: '-0.015em', fontWeight: '500' }],
        heading: ['16px', { lineHeight: '22px', fontWeight: '600' }],
        body: ['14.5px', { lineHeight: '22px', fontWeight: '400' }],
        sidebar: ['13.5px', { lineHeight: '20px', fontWeight: '500' }],
        caption: ['12px', { lineHeight: '16px', fontWeight: '400' }]
      },
      borderRadius: {
        sm: '4px',
        md: '8px',
        lg: '12px',
        xl: '16px'
      },
      boxShadow: {
        card: '0 1px 0 rgba(31,31,28,0.04)',
        soft: '0 2px 8px rgba(31,31,28,0.06)',
        modal: '0 16px 48px rgba(31,31,28,0.12)',
        inset: 'inset 0 0 0 1px rgba(216,209,193,0.5)'
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(24px)' },
          to: { opacity: '1', transform: 'translateY(0)' }
        },
        'pulse-coral': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(217,119,87,0.45)' },
          '50%': { boxShadow: '0 0 0 8px rgba(217,119,87,0)' }
        },
        shimmer: {
          '0%, 100%': { opacity: '0.6' },
          '50%': { opacity: '1' }
        }
      },
      animation: {
        'fade-in': 'fade-in 0.4s ease-out forwards',
        'slide-up': 'slide-up 0.32s cubic-bezier(0.16,1,0.3,1) forwards',
        'pulse-coral': 'pulse-coral 1.6s ease-in-out infinite',
        shimmer: 'shimmer 1.6s ease-in-out infinite'
      }
    }
  },
  plugins: []
};

export default config;
