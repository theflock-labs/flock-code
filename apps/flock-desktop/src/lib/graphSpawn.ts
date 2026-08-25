// Extra spawn args that give an agent graph access, per agent CLI.
//
// A module rather than a closure in App.tsx for one reason: **there is no URL
// in here to go stale.** The graph URL used to ride along inside the cached
// `graph_mcp_config` result, filled once on mount, so pointing Settings at the
// team graph left every agent spawned afterwards registered against the old
// database — the app read one graph while its agents wrote to another, and
// every surface reported success. The caller reads the URL at call time and
// passes it in; nothing here can hold one.
//
// Each CLI has a different injection surface:
//  - claude: `--append-system-prompt` (protocol + workspace brief) plus an
//    inline `--mcp-config` registering the flock-graph server.
//  - codex: inline `-c mcp_servers.*` overrides (no config.toml mutation); the
//    protocol, brief and per-prompt recall ride in on the codex hooks.json
//    brief/ground hooks. `--dangerously-bypass-hook-trust` runs those
//    flock-authored hooks without a per-change re-trust prompt.
//  - opencode: nothing per-spawn — its MCP server and grounding plugin are
//    installed globally.
//  - grok: nothing yet; grok's hook stdout is documented as ignored on
//    passive events, so per-prompt grounding needs verifying first.

export interface GraphSpawnInput {
  /** Settings → Graph. Everything here is gated on it. */
  enabled: boolean;
  /** Secure panes get nothing: the MCP config names a host macOS binary that
   *  neither exists nor could run inside the Linux jail, and shipping the
   *  protocol without its tools just makes the agent apologize for missing
   *  them. */
  secure?: boolean;
  /** Path to the flock-mcp sidecar, or null when it could not be located.
   *  Cacheable — unlike the URL, it does not change while the app runs. */
  mcpPath: string | null;
  /** Read live by the caller, at spawn. */
  url: string;
  /** This workspace's brief, already bound to the same live URL. Resolves to
   *  "" when the engine is down or slow — the protocol still applies. */
  brief: () => Promise<string>;
  /** The protocol text injected into a claude agent's system prompt. */
  protocol: string;
}

/** codex parses each `-c` value as TOML; a JSON string literal is a valid TOML
 *  basic string for these values (paths, URLs). Keys may contain the hyphen in
 *  `flock-graph` (TOML bare keys allow `-`). */
const toml = (s: string) => JSON.stringify(s);

export async function graphSpawnArgs(
  kind: string,
  { enabled, secure, mcpPath, url, brief, protocol }: GraphSpawnInput,
): Promise<string[]> {
  if (secure || !enabled) return [];

  if (kind === "codex") {
    if (!mcpPath) return [];
    return [
      "-c", `mcp_servers.flock-graph.command=${toml(mcpPath)}`,
      "-c", `mcp_servers.flock-graph.env.FLOCK_KG_URL=${toml(url)}`,
      "--dangerously-bypass-hook-trust",
    ];
  }

  if (kind !== "claude") return [];

  // Deterministic grounding: prepend what is already on record for this
  // workspace so the agent is aware of it on turn one, whether or not it
  // decides to query.
  let systemPrompt = protocol;
  try {
    const text = await brief();
    if (text && text.trim()) systemPrompt = `${text.trim()}\n\n${protocol}`;
  } catch { /* engine down; the protocol still applies */ }

  const out = ["--append-system-prompt", systemPrompt];
  if (mcpPath) {
    out.push(
      "--mcp-config",
      JSON.stringify({
        mcpServers: { "flock-graph": { command: mcpPath, env: { FLOCK_KG_URL: url } } },
      }),
    );
  }
  return out;
}
