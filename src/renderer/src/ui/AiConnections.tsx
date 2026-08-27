// Bring-your-own model. Provider selection and configuration stay in Settings; only the
// explanatory privacy and cost notes live behind the info button.

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, CheckCircle, Circle, Info, TerminalWindow, Trash, Warning, XCircle } from "@phosphor-icons/react";
import { api, os } from "@/ipc/client";
import type { AiAgentDiscovery, AiConnection, AiConnectionInput, AiPreset, AiSettings } from "@/ipc/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "./icons/providers";

export function AiCard() {
  const [ai, setAi] = useState<AiSettings | null>(null);
  const [conns, setConns] = useState<AiConnection[]>([]);
  const [infoOpen, setInfoOpen] = useState(false);

  const reload = useCallback(async () => {
    const [settings, list] = await Promise.all([api.aiSettings(), api.aiConnections()]);
    setAi(settings);
    setConns(list);
  }, []);

  useEffect(() => {
    reload().catch(() => {});
  }, [reload]);

  if (!ai) return null;
  const active = conns.find((c) => c.active) ?? null;
  const spend = conns.reduce((sum, c) => sum + c.spend_cents, 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>AI overview</CardTitle>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="How AI connections work"
            title="How AI connections work"
            onClick={() => setInfoOpen(true)}
          >
            <Info />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <InlineProviderSettings conns={conns} onChanged={reload} />

        <div className="flex items-center justify-between gap-3 border-t pt-3">
          <Label htmlFor="pseudonymize" className="text-sm font-medium">
            Hide speaker names
          </Label>
          <Switch
            id="pseudonymize"
            checked={ai.pseudonymize}
            onCheckedChange={async (on) => setAi(await api.aiSettingsSet({ pseudonymize: on }))}
          />
        </div>
      </CardContent>
      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">How AI connections work</DialogTitle>
            <DialogDescription className="text-xs">Privacy, defaults, and connection status.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 text-xs leading-5 text-muted-foreground">
            <p>Audio stays on this device. Transcript text is sent only when you use an AI action.</p>
            <p>Harnesses use their existing sign-in. API keys use the system keyring when available.</p>
            <p>Speaker names can be replaced before sending and restored locally.</p>
            {active?.kind === "cli" && (
              <p>The selected harness controls its model and reasoning settings.</p>
            )}
            {active && (
              <div className="flex items-center gap-2 border-t pt-2 text-sm text-foreground">
                <ProviderIcon preset={active.preset} />
                <span className="min-w-0 flex-1 truncate">{active.label}</span>
                <StatusDot conn={active} />
              </div>
            )}
            {active?.probe && !active.probe.ok && (
              <p className="text-destructive">
                {active.probe.rungs.find((rung) => !rung.ok)?.detail ?? "The last connection check failed."}
              </p>
            )}
            {spend > 0 && (
              <p className="text-xs tabular-nums">Estimated API spend: {spend < 100 ? `${spend.toFixed(1)}¢` : `$${(spend / 100).toFixed(2)}`}</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** Three states, and "never tested" is one of them — a green tick nobody earned is a lie. */
function StatusDot({ conn, className }: { conn: AiConnection; className?: string }) {
  if (!conn.probe) return <Badge variant="ghost" className={cn("shrink-0 text-muted-foreground", className)}><Circle />not tested</Badge>;
  if (conn.probe.ok) return <Badge variant="ghost" className={cn("shrink-0 text-emerald-600", className)}><CheckCircle weight="fill" />working</Badge>;
  return <Badge variant="ghost" className={cn("shrink-0 text-destructive", className)}><XCircle weight="fill" />not working</Badge>;
}

// -------------------------------------------------------------------------------- manage

type ProviderChoice = `connection:${number}` | `preset:${string}` | `agent:${string}`;

const connectionChoice = (id: number): ProviderChoice => `connection:${id}`;
const agentChoice = (preset: string): ProviderChoice => `agent:${preset}`;

function providerChoiceFor(conn: AiConnection | null): ProviderChoice | null {
  if (!conn) return null;
  return connectionChoice(conn.id);
}

function InlineProviderSettings({ conns, onChanged }: {
  conns: AiConnection[];
  onChanged: () => Promise<void>;
}) {
  const [presets, setPresets] = useState<AiPreset[]>([]);
  const [agents, setAgents] = useState<AiAgentDiscovery[] | null>(null);
  const [provider, setProvider] = useState<ProviderChoice | null>(() =>
    providerChoiceFor(conns.find((conn) => conn.active) ?? null),
  );
  const [removeTarget, setRemoveTarget] = useState<AiConnection | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState(false);
  const [switchingHarness, setSwitchingHarness] = useState(false);
  const [harnessError, setHarnessError] = useState<string | null>(null);
  // Test cannot probe a connection that does not exist yet, so it saves one first. Held here
  // rather than in the form: the row has to go back whichever way the form is left.
  const [draft, setDraft] = useState<number | null>(null);
  const draftRef = useRef<number | null>(null);
  const httpConns = conns.filter((c) => c.kind === "http");

  async function discard(): Promise<void> {
    if (draft === null) return;
    setDraft(null);
    await api.aiConnectionDelete(draft).catch(() => {});
    await onChanged();
  }

  useEffect(() => {
    api.aiPresets().then((all) => setPresets(all.filter((p) => p.kind === "http")), () => {});
    api.aiDetectAgents().then(setAgents, () => setAgents([]));
  }, []);

  // a row with no model can only say so in amber, which is a warning the user cannot act on.
  // one list call per broken row fills it in, and rows that are fine cost nothing.
  useEffect(() => {
    const unset = conns.filter((c) => c.kind === "http" && !c.active_model);
    if (!unset.length) return;
    void Promise.all(unset.map((c) => api.aiModelsFetch({ id: c.id }).catch(() => []))).then(onChanged);
    // mount only: onChanged refreshes conns, and depending on those would loop
  }, []);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => () => {
    if (draftRef.current !== null) void api.aiConnectionDelete(draftRef.current).catch(() => {});
  }, []);

  async function chooseProvider(next: ProviderChoice | null): Promise<void> {
    await discard();
    setProvider(next);
    setHarnessError(null);

    const connection = next?.startsWith("connection:")
      ? conns.find((item) => connectionChoice(item.id) === next) ?? null
      : null;
    const agent = next?.startsWith("agent:")
      ? agents?.find((item) => agentChoice(item.preset) === next) ?? null
      : connection?.kind === "cli"
        ? agents?.find((item) => item.preset === connection.preset) ?? null
        : null;
    if (connection?.kind !== "cli" && !agent) return;
    if (connection?.active) return;

    setSwitchingHarness(true);
    let createdId: number | null = null;
    try {
      const executablePath = agent?.executable_path ?? connection?.executable_path ?? await os.pickFile();
      if (!executablePath) {
        setProvider(providerChoiceFor(conns.find((item) => item.active) ?? null));
        return;
      }

      const saved = await api.aiConnectionSave(connection ? {
        id: connection.id,
        executable_path: executablePath,
        active_model: null,
      } : {
        preset: agent!.preset,
        executable_path: executablePath,
        active_model: null,
      });
      if (!connection) createdId = saved.id;

      const result = await api.aiConnectionTest(saved.id);
      if (!result.ok) {
        const failed = result.rungs.find((rung) => !rung.ok);
        throw new Error(failed?.detail ?? "The harness did not pass its connection test.");
      }
      await api.aiConnectionActivate(saved.id);
      await onChanged();
      setProvider(connectionChoice(saved.id));
    } catch (reason) {
      if (createdId !== null) await api.aiConnectionDelete(createdId).catch(() => {});
      setHarnessError(String(reason).replace(/^Error:\s*/, ""));
      await onChanged();
    } finally {
      setSwitchingHarness(false);
    }
  }

  const selectedConnection = provider?.startsWith("connection:")
    ? conns.find((conn) => connectionChoice(conn.id) === provider) ?? null
    : null;
  const selectedHttpConnection = selectedConnection?.kind === "http" ? selectedConnection : null;
  const selectedAgent = provider?.startsWith("agent:")
    ? agents?.find((item) => agentChoice(item.preset) === provider) ?? null
    : null;
  const selectedPreset = provider?.startsWith("preset:")
    ? presets.find((item) => `preset:${item.id}` === provider) ?? null
    : null;
  const localAgents = agents?.filter((agent) => agent.supported && agent.installed) ?? [];
  const cliConns = conns.filter((conn) => conn.kind === "cli");
  const active = conns.find((conn) => conn.active) ?? null;
  const providerIsActive = provider !== null && providerChoiceFor(active) === provider;
  const providerLabel = selectedConnection?.label ?? selectedAgent?.label ?? selectedPreset?.label ?? "Select a provider…";
  const providerPreset = selectedConnection?.preset ?? selectedAgent?.preset ?? selectedPreset?.id ?? null;

  return (
    <>
      <CompactField label="Provider" htmlFor="ai-provider">
        <Select
          value={provider}
          disabled={switchingHarness}
          onValueChange={(value) => void chooseProvider(value as ProviderChoice | null)}
        >
          <SelectTrigger id="ai-provider" className="min-w-0 flex-1">
            <SelectValue>{() => (
              <>
                {providerPreset && <ProviderIcon preset={providerPreset} />}
                <span className="truncate">{providerLabel}</span>
              </>
            )}</SelectValue>
          </SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false} className="w-(--anchor-width)">
            <SelectGroup>
              <SelectLabel>Local harnesses</SelectLabel>
              {cliConns.map((conn) => (
                <SelectItem key={conn.id} value={connectionChoice(conn.id)}>
                  <ProviderIcon preset={conn.preset} />
                  <span>{conn.label}</span>
                </SelectItem>
              ))}
              {localAgents.filter((agent) => !cliConns.some((conn) => conn.preset === agent.preset)).map((agent) => (
                <SelectItem key={agent.preset} value={agentChoice(agent.preset)}>
                  <ProviderIcon preset={agent.preset} />
                  <span>{agent.label}</span>
                </SelectItem>
              ))}
              {agents === null && cliConns.length === 0 && (
                <SelectItem value="detecting-harnesses" disabled>
                  <Spinner />Detecting harnesses…
                </SelectItem>
              )}
              {agents !== null && cliConns.length === 0 && localAgents.length === 0 && (
                <SelectItem value="no-harnesses" disabled>No harness found</SelectItem>
              )}
            </SelectGroup>

            {httpConns.length > 0 && (
              <>
                <SelectSeparator />
                <SelectGroup>
                  <SelectLabel>Configured APIs</SelectLabel>
                  {httpConns.map((conn) => (
                    <SelectItem key={conn.id} value={connectionChoice(conn.id)}>
                      <ProviderIcon preset={conn.preset} />
                      <span className="truncate">{conn.label}</span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </>
            )}

            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Connect an API</SelectLabel>
              {presets.map((item) => (
                <SelectItem key={item.id} value={`preset:${item.id}`}>
                  <ProviderIcon preset={item.id} />
                  <span>{item.label}</span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {switchingHarness
          ? <Badge variant="ghost" className="shrink-0 text-muted-foreground"><Spinner />testing</Badge>
          : active && providerIsActive && <StatusDot conn={active} />}
      </CompactField>

      {harnessError && <p className="pl-[7.25rem] text-xs text-destructive" role="alert">{harnessError}</p>}

      {(selectedHttpConnection || selectedPreset) && (
        <section className="relative border-t pt-3" aria-label="API configuration">
          <ConnectionForm
            key={provider}
            presets={presets}
            conn={selectedHttpConnection}
            initialPreset={selectedPreset?.id}
            onDraft={setDraft}
            onDone={async (id) => {
              setDraft(null);
              await onChanged();
              setProvider(connectionChoice(id));
            }}
          />
          {selectedHttpConnection && (
            <Button
              size="icon-sm"
              variant="ghost"
              className="absolute bottom-0 left-0 text-muted-foreground"
              aria-label={`Remove ${selectedHttpConnection.label}`}
              title={`Remove ${selectedHttpConnection.label}`}
              onClick={() => { setRemoveError(false); setRemoveTarget(selectedHttpConnection); }}
            >
              <Trash />
            </Button>
          )}
        </section>
      )}

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(next) => {
          if (!next && !removing) {
            setRemoveTarget(null);
            setRemoveError(false);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove connection?</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget
                ? `"${removeTarget.label}" will be removed from unottr. You can add it again later.`
                : "This connection will be removed from unottr."}
            </AlertDialogDescription>
            {removeError && (
              <p className="text-sm text-destructive" role="alert">
                Couldn't remove this connection. Check that unottr can access its database, then try again.
              </p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={removing}
              onClick={async () => {
                if (!removeTarget) return;
                setRemoving(true);
                setRemoveError(false);
                try {
                  await api.aiConnectionDelete(removeTarget.id);
                  await onChanged();
                  setProvider(null);
                  setRemoveTarget(null);
                } catch {
                  setRemoveError(true);
                } finally {
                  setRemoving(false);
                }
              }}
            >
              {removing && <Spinner />}Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function InstalledAgentSetup({ agents, conns, onChanged, onActivated, showMissing = false, compact = false }: {
  agents: AiAgentDiscovery[];
  conns: AiConnection[];
  onChanged: () => Promise<void>;
  onActivated?: () => void;
  showMissing?: boolean;
  compact?: boolean;
}) {
  const installed = agents.filter((a) => a.supported && (a.installed || showMissing));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Record<string, string>>({});
  if (!installed.length && !showMissing) return null;

  async function choose(agent: AiAgentDiscovery, selectedPath?: string): Promise<void> {
    const executablePath = selectedPath ?? agent.executable_path;
    if (!agent.supported || !executablePath) return;
    setBusy(agent.preset);
    setError((all) => ({ ...all, [agent.preset]: "" }));
    let createdId: number | null = null;
    try {
      let conn = conns.find((c) => c.kind === "cli" && c.preset === agent.preset);
      if (!conn) {
        conn = await api.aiConnectionSave({
          preset: agent.preset,
          executable_path: executablePath,
        });
        createdId = conn.id;
      } else if (conn.executable_path !== executablePath) {
        conn = await api.aiConnectionSave({ id: conn.id, executable_path: executablePath });
      }
      const result = await api.aiConnectionTest(conn.id);
      if (!result.ok) {
        const failed = result.rungs.find((r) => !r.ok);
        throw new Error(failed?.detail ?? "The agent did not pass its setup test.");
      }
      await api.aiConnectionActivate(conn.id);
      await onChanged();
      onActivated?.();
    } catch (e) {
      if (createdId !== null) await api.aiConnectionDelete(createdId).catch(() => {});
      setError((all) => ({ ...all, [agent.preset]: String(e).replace(/^Error:\s*/, "") }));
      await onChanged();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="flex min-w-0 flex-col gap-2" aria-labelledby="installed-agents-title">
      {compact ? (
        <h3 id="installed-agents-title" className="px-2 pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Installed agents</h3>
      ) : (
        <div className="flex items-start gap-2">
          <TerminalWindow className="mt-0.5 size-4 shrink-0" weight="duotone" />
          <div className="min-w-0">
            <h3 id="installed-agents-title" className="text-sm font-semibold">Installed agents</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Uses an account already signed in on this computer. Transcript text goes to that agent's provider.
            </p>
          </div>
        </div>
      )}

      <div className={cn("min-w-0", compact ? "flex flex-col gap-1" : "overflow-hidden rounded-lg border divide-y")}>
        {installed.length ? installed.map((agent) => {
          const conn = conns.find((c) => c.kind === "cli" && c.preset === agent.preset);
          const pending = busy === agent.preset;
          const agentError = error[agent.preset];
          return (
            <div key={agent.preset} className={cn(
              "flex min-w-0 flex-wrap items-center gap-3 px-3 py-3",
              compact && "rounded-lg py-2.5 hover:bg-muted/70",
              conn?.active && (compact ? "bg-muted" : "bg-primary/5"),
            )}>
              <div className={cn("flex flex-1 items-center gap-3", compact ? "min-w-0" : "min-w-52")}>
                <ProviderIcon preset={agent.preset} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-medium">
                    <span className="truncate">{agent.label}</span>
                    {agent.beta && <Badge variant="outline">beta</Badge>}
                  </span>
                  <span
                    className={cn("break-words text-xs leading-relaxed", agentError ? "text-destructive" : "text-muted-foreground")}
                    role={agentError ? "alert" : undefined}
                  >
                    {agentError || agent.detail}
                  </span>
                </div>
              </div>
              <Button
                size={compact ? "xs" : "sm"}
                variant={compact ? "ghost" : conn?.active ? "secondary" : "default"}
                disabled={pending || conn?.active}
                onClick={async () => {
                  if (agent.installed) return choose(agent);
                  const path = await os.pickFile();
                  if (path) await choose(agent, path);
                }}
              >
                {pending && <Spinner />}
                {conn?.active && <CheckCircle weight="fill" />}
                {conn?.active ? "Active" : !agent.installed ? "Locate" : conn?.probe?.ok ? "Use" : conn ? "Retry & use" : "Test & use"}
              </Button>
            </div>
          );
        }) : (
          <p className="px-3 py-4 text-sm text-muted-foreground">
            No supported agent CLIs were found on this computer.
          </p>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------- form

function ConnectionForm({ presets, conn, initialPreset, onDone, onDraft }: {
  presets: AiPreset[];
  conn: AiConnection | null;
  initialPreset?: string;
  onDone: (id: number) => Promise<void>;
  /** the row Test had to create, until Save makes it wanted — the provider picker cleans it up */
  onDraft: (id: number | null) => void;
}) {
  // the row this form writes to. Test has to save before it can probe, so after one press a
  // brand-new form is already backing a row — forgetting that is how Test adds a connection
  // every time it is pressed.
  const initialPresetId = conn?.preset ?? initialPreset ?? "ollama";
  const initialSpec = presets.find((item) => item.id === initialPresetId);
  const [rowId, setRowId] = useState<number | null>(conn?.id ?? null);
  const preset = initialPresetId;
  const [baseUrl, setBaseUrl] = useState(conn?.base_url ?? initialSpec?.base_url ?? "");
  const [key, setKey] = useState("");
  const [model, setModel] = useState(conn?.active_model ?? "");
  const [models, setModels] = useState<string[]>(conn?.models ?? []);
  const [listing, setListing] = useState(false);
  const [typedModel, setTypedModel] = useState(false);
  const [busy, setBusy] = useState<"saving" | "testing" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsPlain, setNeedsPlain] = useState(false);

  const spec = presets.find((p) => p.id === preset);

  // Existing connections may have a stale model list; new presets with a known endpoint can
  // populate the picker immediately. Failure stays quiet because a model id can still be typed.
  useEffect(() => {
    if (baseUrl) void loadModels(baseUrl, preset);
  }, []);

  /**
   * Ask the endpoint what it has, and pick the head of the list when nothing is chosen yet.
   * Quiet on failure: plenty of servers have no /models, and the field still takes a typed id.
   */
  async function loadModels(url: string, presetId: string): Promise<void> {
    setListing(true);
    try {
      const list = await api.aiModelsFetch({ ...(rowId !== null ? { id: rowId } : {}), preset: presetId, base_url: url, ...(key ? { key } : {}) });
      setModels(list);
      setModel((current) => current || list[0] || "");
    } catch {
      // keep whatever was listed before: a refresh that failed is not proof the list is wrong
    } finally {
      setListing(false);
    }
  }

  async function save(allowPlain: boolean): Promise<number | null> {
    setBusy("saving");
    setError(null);
    try {
      const input: AiConnectionInput = {
        ...(rowId !== null ? { id: rowId } : {}),
        preset,
        base_url: baseUrl,
        active_model: model || null,
        ...(key ? { key, allow_plain: allowPlain } : {}),
      };
      const saved = await api.aiConnectionSave(input);
      setRowId(saved.id);
      setKey("");
      setNeedsPlain(false);
      return saved.id;
    } catch (e) {
      setError(String(e));
      setNeedsPlain(String(e).includes("keyring"));
      return null;
    } finally {
      setBusy(null);
    }
  }

  /** One action owns the full setup: save, test, then activate only if every check passes. */
  async function connect(allowPlain = false): Promise<void> {
    const unsaved = rowId === null;
    const id = await save(allowPlain);
    if (id === null) return;
    if (unsaved) onDraft(id);
    setBusy("testing");
    setError(null);
    try {
      const result = await api.aiConnectionTest(id);
      if (result.models.length) setModels(result.models);
      if (result.model) setModel(result.model);
      if (!result.ok) {
        const failed = result.rungs.find((rung) => !rung.ok);
        setError(failed?.detail ?? "The connection did not pass its setup test.");
        return;
      }
      await api.aiConnectionActivate(id);
      onDraft(null);
      await onDone(id);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <CompactField label="Base URL" htmlFor="ai-base-url">
        <Input
          id="ai-base-url"
          value={baseUrl}
          placeholder="http://localhost:11434/v1"
          onChange={(e) => setBaseUrl(e.target.value)}
          onBlur={async () => {
            if (!baseUrl) return;
            const url = await api.aiNormalizeUrl(baseUrl);
            setBaseUrl(url);
            if (url !== conn?.base_url || !models.length) void loadModels(url, preset);
          }}
        />
      </CompactField>

      <CompactField label="API key" htmlFor="ai-api-key">
        <Input
          id="ai-api-key"
          type="password"
          autoComplete="off"
          value={key}
          placeholder={conn?.key_set ? "•••••••• (stored)" : spec?.key_required ? "required" : "optional"}
          onChange={(e) => setKey(e.target.value)}
        />
      </CompactField>
      {conn?.key_storage === "plain" && (
        <span className="text-xs text-amber-600">Stored unencrypted — no keyring was available.</span>
      )}

      <CompactField label="Model" htmlFor="ai-model">
        {models.length && !typedModel ? (
          <select
            id="ai-model"
            value={model}
            aria-label="Model"
            className={SELECT}
            onChange={(e) => {
              if (e.target.value === TYPE_IT) {
                setTypedModel(true);
                setModel("");
              } else setModel(e.target.value);
            }}
          >
            {!model && <option value="">Pick a model…</option>}
            {model && !models.includes(model) && <option value={model}>{model}</option>}
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
            <option value={TYPE_IT}>Type an id…</option>
          </select>
        ) : (
          <Input
            id="ai-model"
            value={model}
            placeholder="e.g. qwen3:8b"
            onChange={(e) => setModel(e.target.value)}
          />
        )}
        <Button
          size="xs"
          variant="ghost"
          aria-label="List models"
          disabled={!baseUrl || listing}
          onClick={() => {
            setTypedModel(false);
            void loadModels(baseUrl, preset);
          }}
        >
          {listing ? <Spinner /> : <ArrowClockwise />}
        </Button>
      </CompactField>

      {needsPlain && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
          <span className="inline-flex items-center gap-1.5 font-medium">
            <Warning className="size-4 shrink-0" />No OS keyring on this system.
          </span>
          <span className="text-muted-foreground">
            The key can only be stored as plain text in unottr’s database. Anyone with read
            access to your home directory can read it.
          </span>
          <Button size="sm" variant="outline" className="self-start" disabled={busy !== null} onClick={() => void connect(true)}>
            Store unencrypted and connect
          </Button>
        </div>
      )}
      {error && !needsPlain && <span className="text-xs text-destructive" role="alert">{error}</span>}

      <div className="flex justify-end pt-1">
        <Button
          size="sm"
          disabled={!baseUrl || busy !== null}
          onClick={() => void connect(false)}
        >
          {busy !== null && <Spinner />}
          {busy === "saving" ? "Saving…" : busy === "testing" ? "Testing…" : conn ? "Save & use" : "Connect & use"}
        </Button>
      </div>
    </div>
  );
}

/** Native select: hundreds of model ids scroll better in the OS widget than in anything we’d build. */
const SELECT =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

const TYPE_IT = "__type_it__";

function CompactField({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3">
      <Label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">{label}</Label>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </div>
  );
}
