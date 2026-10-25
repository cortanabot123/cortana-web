import * as React from "react"
import { motion, useReducedMotion } from "motion/react"

import { MessageScrollerItem } from "@/components/ui/message-scroller"
import { MESSAGE_ANIMATIONS } from "@/lib/message-animations"

const MotionMessageScrollerItem = motion.create(MessageScrollerItem)

export function AnimatedMessageScrollerItem({
  children,
  ...props
}: React.ComponentProps<typeof MotionMessageScrollerItem>) {
  const shouldReduceMotion = useReducedMotion()

  return (
    <MotionMessageScrollerItem
      variants={MESSAGE_ANIMATIONS["slide-up"].variants}
      initial={shouldReduceMotion ? false : "initial"}
      animate="animate"
      {...props}
    >
      {children}
    </MotionMessageScrollerItem>
  )
}
