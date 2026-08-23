import { useCallback, useEffect, useState } from "react";
import { ArrowClockwise, Check, Download, Plus, Trash, UploadSimple } from "@phosphor-icons/react";
import { api, os } from "@/ipc/client";
import type { TerminologyRule, TerminologyRuleInput } from "@/ipc/types";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

const EMPTY_TERM: TerminologyRuleInput = {
  source: "",
  replacement: "",
  case_sensitive: false,
  whole_word: true,
  enabled: true,
};

type Action = "add" | "apply" | "import" | "export";

export function TerminologyCard() {
  const [rules, setRules] = useState<TerminologyRule[]>([]);
  const [draft, setDraft] = useState<TerminologyRuleInput>(EMPTY_TERM);
  const [action, setAction] = useState<Action | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api.terminologyRules().then(setRules), []);
  useEffect(() => { load().catch((e) => setError(String(e))); }, [load]);

  async function add() {
    if (!draft.source.trim() || !draft.replacement.trim()) return;
    setAction("add");
    setError(null);
    try {
      await api.terminologyAdd(draft);
      setDraft(EMPTY_TERM);
      setMessage("Rule saved. New recordings will use it automatically.");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setAction(null);
    }
  }

  async function applyLibrary() {
    setAction("apply");
    setError(null);
    try {
      const result = await api.terminologyApplyLibrary();
      setMessage(
        result.segments_changed === 0
          ? "The library already matches these rules."
          : `Updated ${result.segments_changed} segment${result.segments_changed === 1 ? "" : "s"} in ${result.recordings_changed} recording${result.recordings_changed === 1 ? "" : "s"}.`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setAction(null);
    }
  }

  async function importRules() {
    const path = await os.pickFile();
    if (!path) return;
    setAction("import");
    setError(null);
    try {
      const result = await api.terminologyImport(path);
      setMessage(
        `Imported ${result.rules_imported} rule${result.rules_imported === 1 ? "" : "s"}. `
        + "Apply them to update older recordings.",
      );
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setAction(null);
    }
  }

  async function exportRules() {
    const path = await os.saveFile("unottr-terminology.json", [
      { name: "JSON", extensions: ["json"] },
    ]);
    if (!path) return;
    setAction("export");
    setError(null);
    try {
      await api.terminologyExport(path);
      setMessage(`Exported ${rules.length} rule${rules.length === 1 ? "" : "s"}.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setAction(null);
    }
  }

  const busy = action !== null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Terminology</CardTitle>
        <CardDescription>
          Correct names, acronyms and phrases Whisper gets wrong repeatedly. Rules affect new
          recordings automatically. Use Apply to library after changing rules for older ones.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Input
            value={draft.source}
            onChange={(e) => setDraft({ ...draft, source: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            placeholder="What Whisper writes"
            aria-label="Text to replace"
            className="h-8"
          />
          <Input
            value={draft.replacement}
            onChange={(e) => setDraft({ ...draft, replacement: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            placeholder="Correct spelling"
            aria-label="Replacement text"
            className="h-8"
          />
          <Button
            size="xs"
            disabled={busy || !draft.source.trim() || !draft.replacement.trim()}
            onClick={add}
          >
            <Plus />{action === "add" ? "Adding..." : "Add"}
          </Button>
        </div>
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          <label className="flex items-center gap-2">
            <Switch
              checked={draft.whole_word}
              onCheckedChange={(whole_word) => setDraft({ ...draft, whole_word })}
            />
            Whole words
          </label>
          <label className="flex items-center gap-2">
            <Switch
              checked={draft.case_sensitive}
              onCheckedChange={(case_sensitive) => setDraft({ ...draft, case_sensitive })}
            />
            Match case
          </label>
        </div>

        {rules.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            Add a recurring correction, for example "post grass" to "Postgres".
          </p>
        ) : (
          <div className="-mx-1 flex max-h-[28rem] flex-col gap-2 overflow-y-auto px-1">
            {rules.map((rule) => <TerminologyRow key={rule.id} rule={rule} onChange={load} />)}
          </div>
        )}

        {message && <p className="text-xs text-muted-foreground" role="status">{message}</p>}
        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      </CardContent>
      <CardFooter className="flex-wrap justify-between gap-2">
        <div className="flex gap-2">
          <Button size="xs" variant="outline" disabled={busy} onClick={importRules}>
            <UploadSimple />{action === "import" ? "Importing..." : "Import"}
          </Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={exportRules}>
            <Download />{action === "export" ? "Exporting..." : "Export"}
          </Button>
        </div>
        <Button size="xs" disabled={busy} onClick={applyLibrary}>
          <ArrowClockwise />{action === "apply" ? "Applying..." : "Apply to library"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function TerminologyRow({ rule, onChange }: { rule: TerminologyRule; onChange: () => Promise<void> }) {
  const initial = (): TerminologyRuleInput => ({
    source: rule.source,
    replacement: rule.replacement,
    case_sensitive: rule.case_sensitive,
    whole_word: rule.whole_word,
    enabled: rule.enabled,
  });
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(initial()), [rule]);
  const dirty = draft.source !== rule.source || draft.replacement !== rule.replacement
    || draft.case_sensitive !== rule.case_sensitive || draft.whole_word !== rule.whole_word
    || draft.enabled !== rule.enabled;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.terminologyUpdate(rule.id, draft);
      await onChange();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.terminologyDelete(rule.id);
      await onChange();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
        <Input
          value={draft.source}
          onChange={(e) => setDraft({ ...draft, source: e.target.value })}
          aria-label="Text to replace"
          className="h-8"
        />
        <Input
          value={draft.replacement}
          onChange={(e) => setDraft({ ...draft, replacement: e.target.value })}
          aria-label="Replacement text"
          className="h-8"
        />
        <Button
          size="icon-xs"
          disabled={!dirty || busy}
          title="Save rule"
          aria-label="Save rule"
          onClick={save}
        >
          <Check />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={busy}
          title="Delete rule"
          aria-label="Delete rule"
          onClick={remove}
        >
          <Trash />
        </Button>
      </div>
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <label className="flex items-center gap-2">
          <Switch checked={draft.enabled} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />
          Enabled
        </label>
        <label className="flex items-center gap-2">
          <Switch
            checked={draft.whole_word}
            onCheckedChange={(whole_word) => setDraft({ ...draft, whole_word })}
          />
          Whole words
        </label>
        <label className="flex items-center gap-2">
          <Switch
            checked={draft.case_sensitive}
            onCheckedChange={(case_sensitive) => setDraft({ ...draft, case_sensitive })}
          />
          Match case
        </label>
        {error && <span className="text-destructive" role="alert">{error}</span>}
      </div>
    </div>
  );
}
