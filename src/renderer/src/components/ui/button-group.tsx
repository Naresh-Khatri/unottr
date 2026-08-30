import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

function ButtonGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="button-group"
      role="group"
      className={cn(
        "isolate inline-flex w-fit items-stretch [&>*]:relative [&>*:focus-visible]:z-10",
        className
      )}
      {...props}
    />
  )
}

export { ButtonGroup }
