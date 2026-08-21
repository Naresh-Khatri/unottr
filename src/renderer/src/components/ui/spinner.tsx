import { CircleNotch } from "@phosphor-icons/react"
import type { IconProps } from "@phosphor-icons/react"

import { cn } from "@/lib/utils"

/** Indeterminate only — there is no work here that can report a percentage. */
function Spinner({ className, ...props }: IconProps) {
  return (
    <CircleNotch
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      weight="bold"
      // reduced motion gets a slower turn, not a frozen one: stillness reads as hung
      className={cn("size-4 animate-spin motion-reduce:[animation-duration:2s]", className)}
      {...props}
    />
  )
}

export { Spinner }
