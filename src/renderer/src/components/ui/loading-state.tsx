import type { ReactNode } from "react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

function LoadingState({
  label = "Loading",
  description,
  className,
}: {
  label?: string;
  description?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="loading-state"
      role="status"
      aria-live="polite"
      className={cn(
        "flex min-h-40 w-full flex-col items-center justify-center gap-3 px-6 py-10 text-center",
        className,
      )}
    >
      <Spinner aria-hidden="true" className="size-5 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description && (
          <p className="mx-auto max-w-sm text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}

export { LoadingState };
