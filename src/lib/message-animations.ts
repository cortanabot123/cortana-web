import type { Variants } from "motion/react"

type AnimationDefinition = { variants: Variants }

/**
 * Entrance animations for chat turns. Kept in one place so the thread can
 * reuse them (and so `prefers-reduced-motion` has a single switch).
 */
export const MESSAGE_ANIMATIONS: Record<string, AnimationDefinition> = {
  "slide-up": {
    variants: {
      initial: { opacity: 0, y: 8 },
      animate: { opacity: 1, y: 0 },
    },
  },
}
