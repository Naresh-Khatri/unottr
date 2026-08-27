import { constants, accessSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { AiAgentDiscovery } from "../../shared/ipc";
import { PRESETS } from "./providers";
import { loosely } from "./structured";

const STDOUT_LIMIT = 8 * 1024 * 1024;
const STDERR_LIMIT = 256 * 1024;

export class CliProcessError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null = null,
    readonly stderr = "",
  ) {
    super(message);
  }
}

export interface CliAnswer<T> {
  object: T;
  usage: { inputTokens?: number; outputTokens?: number };
  model: string | null;
}

interface CliAsk<T> {
  preset: string;
  executablePath: string;
  modelId: string | null;
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  abortSignal?: AbortSignal;
}

const unsupported = [
  {
    preset: "gemini-cli",
    label: "Gemini CLI",
    executable: "gemini",
    detail: "Detected, but not supported yet. Headless runs currently persist sessions.",
  },
  {
    preset: "opencode-cli",
    label: "OpenCode",
    executable: "opencode",
    detail: "Detected, but not supported yet. Headless runs currently persist sessions.",
  },
] as const;

/** Detection never launches the agent. Setup's Test action is the first networked call. */
export function detectAgents(): AiAgentDiscovery[] {
  const supported = PRESETS.filter((p) => p.kind === "cli" && p.executable).map((p) => {
    const path = findExecutable(p.executable as string);
    return {
      preset: p.id,
      label: p.label,
      executable_path: path,
      installed: path !== null,
      beta: p.beta,
      supported: true,
      detail: path ? (p.beta ? "Installed. CLI support is beta." : "Installed and ready to test.") : "Not found",
    } satisfies AiAgentDiscovery;
  });

  const deferred: AiAgentDiscovery[] = unsupported.map((p) => {
    const path = findExecutable(p.executable);
    return {
      preset: p.preset,
      label: p.label,
      executable_path: path,
      installed: path !== null,
      beta: true,
      supported: false,
      detail: path ? p.detail : "Not found",
    };
  });
  return [...supported, ...deferred];
}

export function discoveredPath(presetId: string): string | null {
  return detectAgents().find((a) => a.preset === presetId && a.supported)?.executable_path ?? null;
}

export async function askCli<T>(a: CliAsk<T>): Promise<CliAnswer<T>> {
  if (a.preset === "claude-code") return askClaude(a);
  if (a.preset === "codex-cli") return askCodex(a);
  throw new CliProcessError(`unsupported installed agent ${a.preset}`);
}

async function askClaude<T>(a: CliAsk<T>): Promise<CliAnswer<T>> {
  const schema = JSON.stringify(toClaudeJsonSchema(a.schema));
  const args = [
    "-p",
    "--safe-mode",
    "--tools", "",
    "--disallowedTools", "mcp__*",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format", "json",
    "--json-schema", schema,
    "--system-prompt", a.system,
    ...(a.modelId ? ["--model", a.modelId] : []),
    "Answer the request supplied on stdin.",
  ];
  const run = await inTemporaryDirectory((cwd) =>
    runProcess(a.executablePath, args, a.prompt, cwd, a.abortSignal),
  );
  return parseClaude(run.stdout, a.schema);
}

async function askCodex<T>(a: CliAsk<T>): Promise<CliAnswer<T>> {
  return inTemporaryDirectory(async (cwd) => {
    const schemaPath = join(cwd, "output-schema.json");
    writeFileSync(schemaPath, JSON.stringify(toJsonSchema(a.schema)), { mode: 0o600 });
    const args = [
      "exec",
      "-C", cwd,
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox", "read-only",
      "--skip-git-repo-check",
      "--json",
      "--output-schema", schemaPath,
      ...(a.modelId ? ["--model", a.modelId] : []),
      "-",
    ];
    const input = `<system_instructions>\n${a.system}\n</system_instructions>\n\n${a.prompt}`;
    const run = await runProcess(a.executablePath, args, input, cwd, a.abortSignal);
    return parseCodex(run.stdout, a.schema, a.modelId);
  });
}

export function parseClaude<T>(raw: string, schema: z.ZodType<T>): CliAnswer<T> {
  const body = parseJsonRecord(raw, "Claude Code returned unreadable JSON");
  const candidate = body.structured_output ?? loosely(String(body.result ?? ""));
  const usage = record(body.usage);
  const models = record(body.modelUsage);
  const model = Object.keys(models)[0] ?? string(body.model);
  const modelUsage = model ? record(models[model]) : {};
  return {
    object: schema.parse(candidate),
    usage: {
      inputTokens: number(usage.input_tokens, usage.inputTokens, modelUsage.input_tokens, modelUsage.inputTokens),
      outputTokens: number(usage.output_tokens, usage.outputTokens, modelUsage.output_tokens, modelUsage.outputTokens),
    },
    model,
  };
}

export function parseCodex<T>(raw: string, schema: z.ZodType<T>, requestedModel: string | null): CliAnswer<T> {
  let answer = "";
  let usage: Record<string, unknown> = {};
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    const event = parseJsonRecord(line, "Codex returned an unreadable JSON event");
    const item = record(event.item);
    if (event.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") {
      answer = item.text;
    }
    if (event.type === "turn.completed") usage = record(event.usage);
  }
  if (!answer) throw new CliProcessError("Codex finished without a final answer");
  return {
    object: schema.parse(loosely(answer)),
    usage: {
      inputTokens: number(usage.input_tokens, usage.inputTokens),
      outputTokens: number(usage.output_tokens, usage.outputTokens),
    },
    model: requestedModel,
  };
}

async function inTemporaryDirectory<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "unottr-agent-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runProcess(
  executable: string,
  args: string[],
  input: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let abortReason: unknown = null;
    let limitError: Error | null = null;
    let stopping = false;
    let killTimer: NodeJS.Timeout | null = null;
    const detached = process.platform !== "win32";
    const child = spawn(executable, args, {
      cwd,
      detached,
      env: cliEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const stop = () => {
      if (child.pid == null || stopping) return;
      stopping = true;
      try {
        if (detached) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        // It may have exited between the signal and this call.
      }
      killTimer = setTimeout(() => {
        try {
          if (detached) process.kill(-(child.pid as number), "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, 2_000);
      killTimer.unref();
    };

    const onAbort = () => {
      abortReason = signal?.reason ?? new DOMException("The operation was aborted", "AbortError");
      stop();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > STDOUT_LIMIT && !limitError) {
        limitError = new CliProcessError("installed agent output exceeded 8 MB");
        stop();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr = Buffer.concat([stderr, chunk]).subarray(0, STDERR_LIMIT);
    });
    child.on("error", (err) => reject(new CliProcessError(`could not start ${executable}: ${err.message}`)));
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (abortReason) return reject(abortReason);
      if (limitError) return reject(limitError);
      const errText = stderr.toString("utf8").trim();
      if (code !== 0) {
        return reject(new CliProcessError(errText || `installed agent exited with code ${code}`, code, errText));
      }
      resolve({ stdout: stdout.toString("utf8"), stderr: errText });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function cliEnvironment(): NodeJS.ProcessEnv {
  const keep = [
    "HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY",
  ];
  return Object.fromEntries(keep.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

function findExecutable(name: string): string | null {
  for (const path of executableCandidates(name)) {
    try {
      accessSync(path, constants.X_OK);
      return realpathSync(path);
    } catch {
      // Try the next location.
    }
  }
  return null;
}

function executableCandidates(name: string): string[] {
  const home = homedir();
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, name));
  const fixed = [
    join(home, ".local", "bin", name),
    join(home, ".npm-global", "bin", name),
    join(home, ".local", "share", "pnpm", name),
    join(home, ".bun", "bin", name),
    join(home, ".claude", "local", name),
    join("/usr/local/bin", name),
    join("/usr/bin", name),
  ];
  const nvmRoot = join(home, ".config", "nvm", "versions", "node");
  let nvm: string[] = [];
  try {
    nvm = readdirSync(nvmRoot).reverse().map((version) => join(nvmRoot, version, "bin", name));
  } catch {
    // nvm is optional.
  }
  return [...new Set([...paths, ...fixed, ...nvm])];
}

export function toClaudeJsonSchema(schema: z.ZodType<unknown>): unknown {
  const output = z.toJSONSchema(schema, { target: "draft-07" });
  delete output.$schema;
  return output;
}

const toJsonSchema = (schema: z.ZodType<unknown>): unknown => z.toJSONSchema(schema);

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

const string = (v: unknown): string | null => typeof v === "string" && v ? v : null;

const number = (...values: unknown[]): number | undefined =>
  values.find((v): v is number => typeof v === "number" && Number.isFinite(v));

function parseJsonRecord(raw: string, message: string): Record<string, unknown> {
  try {
    return record(JSON.parse(raw));
  } catch {
    throw new CliProcessError(message);
  }
}
