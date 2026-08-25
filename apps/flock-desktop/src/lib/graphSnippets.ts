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
  return {
    claude: {
      title: "Claude Code",
      hint: "One command — --scope user makes the graph available in every project:",
      code: `claude mcp add --scope user flock-graph -e FLOCK_KG_URL=${kgUrl} -- ${mcpPath}`,
    },
    opencode: {
      title: "opencode",
      hint: "Add to ~/.config/opencode/opencode.json under the top-level \"mcp\" key:",
      code: `{
  "mcp": {
    "flock-graph": {
      "type": "local",
      "command": ["${mcpPath}"],
      "environment": { "FLOCK_KG_URL": "${kgUrl}" }
    }
  }
}`,
    },
    codex: {
      title: "Codex",
      hint: "Add to ~/.codex/config.toml:",
      code: `[mcp_servers.flock-graph]
command = "${mcpPath}"
env = { FLOCK_KG_URL = "${kgUrl}" }`,
    },
  };
}
