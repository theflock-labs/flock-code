// Per-tool MCP registration snippets for the flock-graph server. Shared
// by the setup wizard and the Settings → Graph pane so the two can never
// drift apart.

export type AgentTool = "claude" | "opencode" | "codex";

export interface GraphSnippet {
  title: string;
  hint: string;
  code: string;
}

export function graphSnippets(mcpPath: string, kgUrl: string): Record<AgentTool, GraphSnippet> {
  const shell = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  const server = {
    type: "local",
    command: [mcpPath],
    ...(kgUrl ? { environment: { FLOCK_KG_URL: kgUrl } } : {}),
  };
  return {
    claude: {
      title: "Claude Code",
      hint: "One command — --scope user makes the graph available in every project:",
      code: `claude mcp add --scope user flock-graph${kgUrl ? ` -e ${shell(`FLOCK_KG_URL=${kgUrl}`)}` : ""} -- ${shell(mcpPath)}`,
    },
    opencode: {
      title: "opencode",
      hint: "Add to ~/.config/opencode/opencode.json under the top-level \"mcp\" key:",
      code: JSON.stringify({ mcp: { "flock-graph": server } }, null, 2),
    },
    codex: {
      title: "Codex",
      hint: "Add to ~/.codex/config.toml:",
      code: `[mcp_servers.flock-graph]
command = ${JSON.stringify(mcpPath)}${kgUrl ? `\nenv = { FLOCK_KG_URL = ${JSON.stringify(kgUrl)} }` : ""}`,
    },
  };
}
