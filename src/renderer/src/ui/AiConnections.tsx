// Bring-your-own model. The card in Settings stays one line — a provider you set up once is
// not something you want to look at every day — and everything else lives behind Manage.

import { useCallback, useEffect, useState } from "react";
import { ArrowClockwise, CheckCircle, Circle, Plus, Trash, Warning, XCircle } from "@phosphor-icons/react";
import { api } from "@/ipc/client";
import type { AiConnection, AiConnectionInput, AiPreset, AiSettings, ProbeResult } from "@/ipc/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "./icons/providers";

export function AiCard() {
  const [ai, setAi] = useState<AiSettings | null>(null);
  const [conns, setConns] = useState<AiConnection[]>([]);
  const [open, setOpen] = useState(false);

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
        <CardTitle>AI overview</CardTitle>
        <CardDescription>
          Transcription and diarization never touch a network. This step sends the transcript
          text — never the audio or video — to whichever model you point it at, and only when
          you press Generate.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
          {active ? (
            <>
              <ProviderIcon preset={active.preset} />
              <span className="truncate text-sm font-medium">{active.label}</span>
              <span className={cn("truncate text-sm", active.active_model ? "text-muted-foreground" : "text-amber-600")}>
                {active.active_model ?? "no model picked"}
              </span>
              <StatusDot conn={active} />
            </>
          ) : (
            <span className="text-sm text-muted-foreground">No model connected yet.</span>
          )}
          <Button size="xs" variant={active ? "ghost" : "default"} className="ml-auto" onClick={() => setOpen(true)}>
            {active ? "Manage" : <><Plus />Add a model</>}
          </Button>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <Label htmlFor="pseudonymize">Send speakers as “Speaker A”, not their names</Label>
            <span className="text-xs text-muted-foreground">
              Attribution still works — names are reattached here, after the answer comes back.
            </span>
          </div>
          <Switch
            id="pseudonymize"
            checked={ai.pseudonymize}
            onCheckedChange={async (on) => setAi(await api.aiSettingsSet({ pseudonymize: on }))}
          />
        </div>
      </CardContent>
      {spend > 0 && (
        <CardFooter className="justify-start text-xs text-muted-foreground">
          Estimated spend so far: {spend < 100 ? `${spend.toFixed(1)}¢` : `$${(spend / 100).toFixed(2)}`}
        </CardFooter>
      )}
      <ManageDialog open={open} onOpenChange={setOpen} conns={conns} onChanged={reload} />
    </Card>
  );
}

/** Three states, and "never tested" is one of them — a green tick nobody earned is a lie. */
function StatusDot({ conn }: { conn: AiConnection }) {
  if (!conn.probe) return <Badge variant="ghost" className="ml-auto shrink-0 text-muted-foreground"><Circle />not tested</Badge>;
  if (conn.probe.ok) return <Badge variant="ghost" className="ml-auto shrink-0 text-emerald-600"><CheckCircle weight="fill" />working</Badge>;
  return <Badge variant="ghost" className="ml-auto shrink-0 text-destructive"><XCircle weight="fill" />not working</Badge>;
}

// -------------------------------------------------------------------------------- manage

function ManageDialog({ open, onOpenChange, conns, onChanged }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  conns: AiConnection[];
  onChanged: () => Promise<void>;
}) {
  const [presets, setPresets] = useState<AiPreset[]>([]);
  const [editing, setEditing] = useState<AiConnection | "new" | null>(null);
  // Test cannot probe a connection that does not exist yet, so it saves one first. Held here
  // rather than in the form: the row has to go back whichever way the form is left.
  const [draft, setDraft] = useState<number | null>(null);

  async function discard(): Promise<void> {
    if (draft === null) return;
    setDraft(null);
    await api.aiConnectionDelete(draft).catch(() => {});
    await onChanged();
  }

  useEffect(() => {
    if (open) api.aiPresets().then(setPresets, () => {});
  }, [open]);

  // a row with no model can only say so in amber, which is a warning the user cannot act on.
  // one list call per broken row fills it in, and rows that are fine cost nothing.
  useEffect(() => {
    if (!open) return;
    const unset = conns.filter((c) => !c.active_model);
    if (!unset.length) return;
    void Promise.all(unset.map((c) => api.aiModelsFetch({ id: c.id }).catch(() => []))).then(onChanged);
    // on open only: onChanged refreshes conns, and depending on those would loop
  }, [open]);

  // opening onto an empty list should land on the add form, not an empty box with a button
  useEffect(() => {
    if (open && !conns.length) setEditing("new");
    if (!open) setEditing(null);
  }, [open, conns.length]);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) void discard(); onOpenChange(v); }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Connection" : "Models"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Point unottr at any OpenAI-compatible endpoint — a local server or a hosted API."
              : "Pick the one Generate should use. Everything else stays configured."}
          </DialogDescription>
        </DialogHeader>

        {editing ? (
          <ConnectionForm
            // remount per row: every field below is seeded from `conn` exactly once
            key={editing === "new" ? "new" : editing.id}
            presets={presets}
            conn={editing === "new" ? null : editing}
            onDraft={setDraft}
            onDone={async () => {
              await onChanged();
              setEditing(null);
            }}
            onCancel={async () => {
              await discard();
              // Test saves before probing, so even a kept row leaves the list behind
              await onChanged();
              setEditing(conns.length ? null : "new");
            }}
          />
        ) : (
          <div className="flex flex-col gap-2">
            {/* the list is the only part that grows without bound; -mx/px so focus rings clear */}
            <div className="-mx-1 flex max-h-[45dvh] flex-col gap-2 overflow-y-auto px-1">
              {conns.map((c) => (
                // whole row activates, same radio-in-a-bordered-row shape as the whisper tier picker
                <div
                  key={c.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-colors",
                    c.active ? "border-primary bg-primary/5" : "hover:bg-muted/50",
                  )}
                  onClick={async () => {
                    if (c.active) return;
                    await api.aiConnectionActivate(c.id);
                    await onChanged();
                  }}
                >
                  {/* readOnly: the row owns the click, and a keyboard press on the radio bubbles to it */}
                  <input
                    type="radio"
                    name="ai-connection"
                    checked={c.active}
                    readOnly
                    aria-label={`Use ${c.label}`}
                    className="size-4 shrink-0 accent-primary"
                  />
                  <ProviderIcon preset={c.preset} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-2 truncate text-sm font-medium">
                      {c.label}
                      {c.active && <Badge variant="outline" className="shrink-0">active</Badge>}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {c.active_model ?? <span className="text-amber-600">no model picked</span>} · {c.base_url}
                    </span>
                  </div>
                  <StatusDot conn={c} />
                  <Button size="xs" variant="ghost" className="shrink-0" onClick={(e) => { e.stopPropagation(); setEditing(c); }}>Edit</Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="shrink-0"
                    aria-label={`Remove ${c.label}`}
                    onClick={async (e) => {
                      e.stopPropagation();
                      await api.aiConnectionDelete(c.id);
                      await onChanged();
                    }}
                  >
                    <Trash />
                  </Button>
                </div>
              ))}
            </div>
            <Button size="xs" variant="outline" className="self-start" onClick={() => setEditing("new")}>
              <Plus />Add another
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------- form

function ConnectionForm({ presets, conn, onDone, onCancel, onDraft }: {
  presets: AiPreset[];
  conn: AiConnection | null;
  onDone: () => Promise<void>;
  onCancel: () => void | Promise<void>;
  /** the row Test had to create, until Save makes it wanted — the dialog cleans it up */
  onDraft: (id: number | null) => void;
}) {
  // the row this form writes to. Test has to save before it can probe, so after one press a
  // brand-new form is already backing a row — forgetting that is how Test adds a connection
  // every time it is pressed.
  const [rowId, setRowId] = useState<number | null>(conn?.id ?? null);
  const [preset, setPreset] = useState(conn?.preset ?? "ollama");
  const [label, setLabel] = useState(conn?.label ?? "");
  const [baseUrl, setBaseUrl] = useState(conn?.base_url ?? "");
  const [key, setKey] = useState("");
  const [model, setModel] = useState(conn?.active_model ?? "");
  const [models, setModels] = useState<string[]>(conn?.models ?? []);
  const [contextTokens, setContextTokens] = useState(conn?.context_tokens?.toString() ?? "");
  const [priceIn, setPriceIn] = useState(conn?.price_in_usd?.toString() ?? "");
  const [priceOut, setPriceOut] = useState(conn?.price_out_usd?.toString() ?? "");
  const [detected, setDetected] = useState<string[]>([]);
  const [listing, setListing] = useState(false);
  const [typedModel, setTypedModel] = useState(false);
  const [busy, setBusy] = useState<"saving" | "testing" | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(conn?.probe ?? null);
  const [error, setError] = useState<string | null>(null);
  const [needsPlain, setNeedsPlain] = useState(false);

  const spec = presets.find((p) => p.id === preset);

  // knock on the local servers while the form is opening, so someone already running Ollama
  // sees it offered instead of being asked for a url they'd have to go look up
  useEffect(() => {
    if (conn) {
      // an existing row may have been saved before there was a picker, or its server may have
      // loaded a different model since — either way, ask rather than show an empty field
      if (conn.base_url) void loadModels(conn.base_url, conn.preset);
      return;
    }
    api.aiDetectLocal().then(
      (found) => {
        setDetected(found.map((f) => f.preset));
        const first = found[0];
        if (first && !baseUrl) {
          setPreset(first.preset);
          setBaseUrl(first.base_url);
          setModels(first.models);
          setModel(first.models[0] ?? "");
        }
      },
      () => {},
    );
    // once, on mount: this is a suggestion, not a field that tracks state
  }, []);

  function pick(p: AiPreset) {
    setPreset(p.id);
    setBaseUrl(p.base_url);
    setLabel("");
    setProbe(null);
    setModels([]);
    setModel("");
    setTypedModel(false);
    if (p.base_url) void loadModels(p.base_url, p.id);
  }

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
        context_tokens: contextTokens ? Number(contextTokens) : null,
        price_in_usd: priceIn ? Number(priceIn) : null,
        price_out_usd: priceOut ? Number(priceOut) : null,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(key ? { key, allow_plain: allowPlain } : {}),
      };
      const saved = await api.aiConnectionSave(input);
      setRowId(saved.id);
      setKey("");
      setNeedsPlain(false);
      if (!label) setLabel(saved.label);
      return saved.id;
    } catch (e) {
      setError(String(e));
      setNeedsPlain(String(e).includes("keyring"));
      return null;
    } finally {
      setBusy(null);
    }
  }

  /** Save first, always: the test needs a row to read the key and the url off. */
  async function test() {
    const unsaved = rowId === null;
    const id = await save(false);
    if (id === null) return;
    if (unsaved) onDraft(id);
    setBusy("testing");
    setError(null);
    try {
      const result = await api.aiConnectionTest(id);
      setProbe(result);
      if (result.models.length) setModels(result.models);
      // the probe picks one when the field is empty; show which, rather than leaving it blank
      if (result.model) setModel(result.model);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }



  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <Button
            key={p.id}
            size="xs"
            variant={p.id === preset ? "default" : "outline"}
            onClick={() => pick(p)}
          >
            <ProviderIcon preset={p.id} className="size-3.5" />
            {p.label}
            {detected.includes(p.id) && <span className="text-xs opacity-70">· found</span>}
          </Button>
        ))}
      </div>

      <Field label="Base URL">
        <Input
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
      </Field>

      <Field label="API key">
        <Input
          type="password"
          value={key}
          placeholder={conn?.key_set ? "•••••••• (stored)" : spec?.key_required ? "required" : "optional"}
          onChange={(e) => setKey(e.target.value)}
        />
      </Field>
      {conn?.key_storage === "plain" && (
        <span className="text-xs text-amber-600">Stored unencrypted — no keyring was available.</span>
      )}

      <Field label="Model">
        {models.length && !typedModel ? (
          <select
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
      </Field>
      <ModelHint model={model} count={models.length} listing={listing} />

      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Advanced</summary>
        <div className="mt-2 flex flex-col gap-2">
          <Field label="Name">
            <Input value={label} placeholder={spec?.label ?? "as it appears in Settings"} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <Field label="Context">
            <Input
              value={contextTokens}
              inputMode="numeric"
              placeholder="tokens the model holds — filled in for you when known"
              onChange={(e) => setContextTokens(e.target.value.replace(/\D/g, ""))}
            />
          </Field>
          <Field label="Price">
            <Input value={priceIn} inputMode="decimal" placeholder="$/M in" onChange={(e) => setPriceIn(e.target.value)} />
            <Input value={priceOut} inputMode="decimal" placeholder="$/M out" onChange={(e) => setPriceOut(e.target.value)} />
          </Field>
        </div>
      </details>

      {needsPlain && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
          <span className="inline-flex items-center gap-1.5 font-medium">
            <Warning className="size-4 shrink-0" />No OS keyring on this system.
          </span>
          <span className="text-muted-foreground">
            The key can only be stored as plain text in unottr’s database. Anyone with read
            access to your home directory can read it.
          </span>
          <Button size="xs" variant="outline" className="self-start" onClick={() => save(true)}>
            Store it unencrypted anyway
          </Button>
        </div>
      )}
      {error && !needsPlain && <span className="text-xs text-destructive">{error}</span>}

      {(probe || busy === "testing") && <ProbeChecklist probe={probe} running={busy === "testing"} />}

      <div className="flex gap-2">
        <Button size="xs" variant="outline" disabled={!baseUrl || busy !== null} onClick={test}>
          {busy === "testing" && <Spinner />}Test
        </Button>
        <Button
          size="xs"
          disabled={!baseUrl || busy !== null}
          onClick={async () => {
            if ((await save(false)) === null) return;
            onDraft(null);
            await onDone();
          }}
        >
          {busy === "saving" && <Spinner />}Save
        </Button>
        <Button size="xs" variant="ghost" disabled={busy !== null} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

const RUNG_LABELS: Record<string, string> = {
  reachable: "Endpoint answers",
  authorized: "Key accepted",
  responds: "Model responds",
  structured: "Produces structured output",
};

/**
 * All four rungs, in order, including the ones not reached. A small local model passes the
 * first three and fails the last — which is exactly the failure a key check would have
 * called a success.
 */
function ProbeChecklist({ probe, running }: { probe: ProbeResult | null; running: boolean }) {
  const order = ["reachable", "authorized", "responds", "structured"];
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-3 text-xs">
      {order.map((step) => {
        const rung = probe?.rungs.find((r) => r.step === step);
        return (
          <div key={step} className="flex items-center gap-2">
            {rung ? (
              rung.ok ? <CheckCircle weight="fill" className="size-4 shrink-0 text-emerald-600" />
                : <XCircle weight="fill" className="size-4 shrink-0 text-destructive" />
            ) : running ? (
              <Spinner className="size-4 shrink-0" />
            ) : (
              <Circle className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className={rung || running ? "" : "text-muted-foreground"}>{RUNG_LABELS[step]}</span>
            {rung?.detail && <span className="truncate text-muted-foreground">— {rung.detail}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** Native select: hundreds of model ids scroll better in the OS widget than in anything we’d build. */
const SELECT =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

const TYPE_IT = "__type_it__";

/** The field above is the one thing that can be silently unset and break Generate later. */
function ModelHint({ model, count, listing }: { model: string; count: number; listing: boolean }) {
  if (listing) return <Hint className="text-muted-foreground">Asking the endpoint what it has…</Hint>;
  if (!model) {
    return (
      <Hint className="text-amber-600">
        No model picked — Generate needs one. {count ? "Choose from the list." : "Type the id your server serves."}
      </Hint>
    );
  }
  if (!count) return null;
  return <Hint className="text-muted-foreground">{count} model{count === 1 ? "" : "s"} on this endpoint.</Hint>;
}

const Hint = ({ className, children }: { className: string; children: React.ReactNode }) => (
  <span className={cn("-mt-1 pl-26 text-xs", className)}>{children}</span>
);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <Label className="w-24 shrink-0">{label}</Label>
      {children}
    </div>
  );
}
