// What a new agent is started with: its model, its effort, and its first
// prompt — each as the agent's own command-line flags.
//
// The first prompt rides on the command line rather than being typed in once
// the agent looks ready. Typing it raced whatever the agent was showing: a new
// folder makes Claude Code ask whether you trust it, and the prompt's Enter
// answered "No, exit". On the command line the agent asks its questions first
// and runs the prompt after, so nothing has to guess what is on screen.

import type { AgentKind } from "../types";

export interface LaunchOptions {
  /** The agent's model flag value, e.g. "opus". Absent: the agent's default. */
  model?: string;
  /** Reasoning effort, e.g. "high". Absent: the agent's default. */
  effort?: string;
}

export interface ModelChoice {
  value: string;
  label: string;
}

/** Models offered per agent: only aliases the CLI itself documents
 *  (`claude --help`: "an alias for the latest model (e.g. 'fable', 'opus', or
 *  'sonnet')"), so the list never names a model the agent does not know. */
export const MODELS: Partial<Record<AgentKind, ModelChoice[]>> = {
  claude: [
    { value: "fable", label: "Fable" },
    { value: "opus", label: "Opus" },
    { value: "sonnet", label: "Sonnet" },
    { value: "haiku", label: "Haiku" },
  ],
};

/** Effort levels per agent, as each CLI takes them. */
export const EFFORTS: Partial<Record<AgentKind, string[]>> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high"],
  grok: ["low", "medium", "high"],
};

export function modelLabel(kind: string, model?: string): string {
  if (!model) return "Default model";
  return MODELS[kind as AgentKind]?.find((m) => m.value === model)?.label ?? model;
}

export function effortLabel(effort?: string): string {
  return effort ? `${effortName(effort)} effort` : "Default effort";
}

/** An effort level as a person says it: "high", "extra high". */
export function effortName(effort: string): string {
  const name = effort === "xhigh" ? "extra high" : effort;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/** The CLI flags for a model and effort. */
export function launchArgs(kind: string, o?: LaunchOptions): string[] {
  if (!o) return [];
  const out: string[] = [];
  switch (kind) {
    case "claude":
      if (o.model) out.push("--model", o.model);
      if (o.effort) out.push("--effort", o.effort);
      break;
    case "codex":
      if (o.model) out.push("-m", o.model);
      if (o.effort) out.push("-c", `model_reasoning_effort="${o.effort}"`);
      break;
    case "grok":
      if (o.model) out.push("-m", o.model);
      if (o.effort) out.push("--reasoning-effort", o.effort);
      break;
  }
  return out;
}

/** The first prompt as launch arguments, or null when this agent has to have
 *  it typed in once it is ready. `--` ends the options, so the prompt can never
 *  be read as one (Claude's `--mcp-config` takes every value that follows it).
 *  A one-word prompt is typed instead: as a lone operand it could name a
 *  subcommand ("update", "doctor") rather than a task. */
export function promptArgs(kind: string, prompt: string | undefined): string[] | null {
  const p = prompt?.trim();
  if (!p) return [];
  if (!/\s/.test(p)) return null;
  switch (kind) {
    case "claude":
    case "codex":
    case "grok":
      return ["--", p];
    default:
      return null;
  }
}

const KEY = "flock:v2-launch";

/** The model and effort last started with, per agent. */
export function loadLaunch(kind: string): LaunchOptions {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, LaunchOptions>;
    const o = all[kind] ?? {};
    // Only what this agent still offers survives a reload.
    return {
      model: o.model && MODELS[kind as AgentKind]?.some((m) => m.value === o.model) ? o.model : undefined,
      effort: o.effort && EFFORTS[kind as AgentKind]?.includes(o.effort) ? o.effort : undefined,
    };
  } catch {
    return {};
  }
}

export function saveLaunch(kind: string, o: LaunchOptions): void {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, LaunchOptions>;
    all[kind] = { model: o.model, effort: o.effort };
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* a preference */
  }
}
