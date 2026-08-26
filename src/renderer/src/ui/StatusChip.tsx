import { CheckCircle, CircleNotch, Clock, WarningCircle } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import type { Status } from "@/ipc/types";
import { IN_FLIGHT } from "@/ipc/types";

const LABEL: Record<Status, string> = {
  discovered: "Queued",
  probing: "Probing",
  extracting: "Extracting",
  transcribing: "Transcribing · 1/2",
  diarizing: "Speakers · 2/2",
  merging: "Merging",
  done: "Done",
  failed: "Failed",
};

export function StatusChip({ status, mode }: {
  status: Status;
  mode?: "full" | "transcribe" | "diarize";
}) {
  if (status === "done")
    return <Badge variant="secondary"><CheckCircle weight="fill" />Done</Badge>;
  if (status === "failed")
    return <Badge variant="destructive"><WarningCircle weight="fill" />Failed</Badge>;
  if (status === "discovered")
    return <Badge variant="ghost"><Clock />Queued</Badge>;
  if (IN_FLIGHT.includes(status))
    return (
      <Badge variant="outline">
        <CircleNotch className="animate-spin" />
        {mode === "transcribe" && status === "transcribing"
          ? "Transcribing"
          : mode === "diarize" && status === "diarizing" ? "Identifying speakers" : LABEL[status]}
      </Badge>
    );
  return <Badge variant="outline">{LABEL[status]}</Badge>;
}
