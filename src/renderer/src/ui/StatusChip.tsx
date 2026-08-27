import { CheckCircle, CircleNotch, Clock, WarningCircle } from "@phosphor-icons/react";
import { Badge } from "@/components/ui/badge";
import type { JobPhase, Status } from "@/ipc/types";
import { IN_FLIGHT } from "@/ipc/types";
import { jobActivity } from "@/lib/activity";

export function StatusChip({ status, mode, phase }: {
  status: Status;
  mode?: "full" | "transcribe" | "diarize";
  phase?: JobPhase;
}) {
  if (status === "done")
    return <Badge variant="secondary"><CheckCircle weight="fill" />Done</Badge>;
  if (status === "failed")
    return <Badge variant="destructive"><WarningCircle weight="fill" />Failed</Badge>;
  if (status === "discovered")
    return (
      <Badge variant="ghost">
        <Clock />{phase ? jobActivity(status, phase, mode).label : "Queued"}
      </Badge>
    );
  if (IN_FLIGHT.includes(status))
    return (
      <Badge variant="outline">
        {phase === "queued"
          ? <Clock />
          : <CircleNotch className="animate-spin motion-reduce:animate-none" />}
        {jobActivity(status, phase, mode).label}
      </Badge>
    );
  return <Badge variant="outline">{jobActivity(status, phase, mode).label}</Badge>;
}
