import { useEffect, useState } from "react";
import { PencilSimple } from "@phosphor-icons/react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Click-to-edit recording title. `value` is what's shown (user or ai title, else filename);
 * `initial` seeds the editor (the user title only, so an ai/filename fallback isn't
 * "confirmed" by accident). Empty commit = clear back to the fallback.
 */
export function EditableTitle({ value, initial, onCommit, className, inputClassName }: {
  value: string; initial: string; onCommit: (title: string) => void;
  className?: string; inputClassName?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(initial), [initial]);

  if (editing)
    return (
      <Input autoFocus value={draft} placeholder={value}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { setEditing(false); if (draft.trim() !== initial) onCommit(draft); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") { setDraft(initial); setEditing(false); }
        }}
        className={cn("h-7", inputClassName)} />
    );

  return (
    <button type="button" title="Rename"
      onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      className={cn("group/title inline-flex min-w-0 max-w-full items-center gap-1 text-left", className)}>
      <span className="truncate">{value}</span>
      <PencilSimple className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/title:opacity-100 group-hover/row:opacity-100" />
    </button>
  );
}
