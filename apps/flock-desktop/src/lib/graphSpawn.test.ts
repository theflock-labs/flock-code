import { describe, expect, it, vi } from "vitest";
import { graphSpawnArgs, type GraphSpawnInput } from "./graphSpawn";

const PROTOCOL = "PROTOCOL TEXT";

function input(over: Partial<GraphSpawnInput> = {}): GraphSpawnInput {
  return {
    enabled: true,
    mcpPath: "/path/to/flock-mcp",
    url: "postgres://team.example:5432/kg",
    brief: async () => "",
    protocol: PROTOCOL,
    ...over,
  };
}

/** The URL is read at spawn and passed in, so there is nothing here that can
 *  hold a stale one. These pin what an agent is actually handed. */
describe("the graph URL an agent is registered against", () => {
  it("is the one passed at spawn, for claude", async () => {
    const args = await graphSpawnArgs("claude", input({ url: "postgres://team/kg" }));
    const cfg = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
    expect(cfg.mcpServers["flock-graph"].env.FLOCK_KG_URL).toBe("postgres://team/kg");
    expect(cfg.mcpServers["flock-graph"].command).toBe("/path/to/flock-mcp");
  });

  it("is the one passed at spawn, for codex", async () => {
    const args = await graphSpawnArgs("codex", input({ url: "postgres://team/kg" }));
    expect(args).toContain('mcp_servers.flock-graph.env.FLOCK_KG_URL="postgres://team/kg"');
    expect(args).toContain('mcp_servers.flock-graph.command="/path/to/flock-mcp"');
    expect(args).toContain("--dangerously-bypass-hook-trust");
  });

  it("changes with the caller's URL between two spawns", async () => {
    // The regression, as behaviour: Settings points at the team graph, and the
    // *next* agent must be registered there. A cache anywhere in this path is
    // what made the app read one database while its agents wrote to another.
    const local = await graphSpawnArgs("codex", input({ url: "postgres://127.0.0.1:15432/kg" }));
    const team = await graphSpawnArgs("codex", input({ url: "postgres://team.internal/kg" }));
    expect(local).not.toEqual(team);
    expect(team.join(" ")).toContain("team.internal");
    expect(team.join(" ")).not.toContain("127.0.0.1");
  });
});

describe("what each agent gets", () => {
  it("prepends the workspace brief to the protocol for claude", async () => {
    const args = await graphSpawnArgs("claude", input({ brief: async () => "  KNOWN FACTS  " }));
    expect(args[0]).toBe("--append-system-prompt");
    expect(args[1]).toBe(`KNOWN FACTS\n\n${PROTOCOL}`);
  });

  it("still ships the protocol when the brief is empty or the engine is down", async () => {
    const empty = await graphSpawnArgs("claude", input({ brief: async () => "   " }));
    expect(empty[1]).toBe(PROTOCOL);
    const down = await graphSpawnArgs("claude", input({
      brief: async () => { throw new Error("engine down"); },
    }));
    expect(down[1]).toBe(PROTOCOL);
  });

  it("gives claude the protocol even with no sidecar, and codex nothing", async () => {
    // Without the binary there are no kg.* tools to register; claude can still
    // be told the protocol (the UserPromptSubmit hook injects recall), while
    // codex's whole integration is the -c overrides.
    const claude = await graphSpawnArgs("claude", input({ mcpPath: null }));
    expect(claude).toEqual(["--append-system-prompt", PROTOCOL]);
    expect(await graphSpawnArgs("codex", input({ mcpPath: null }))).toEqual([]);
  });

  it("gives nothing to the agents whose integration is not per-spawn", async () => {
    expect(await graphSpawnArgs("opencode", input())).toEqual([]);
    expect(await graphSpawnArgs("grok", input())).toEqual([]);
  });
});

describe("the gates", () => {
  it("gives nothing when the graph is off, and does not even ask for a brief", async () => {
    const brief = vi.fn(async () => "KNOWN FACTS");
    expect(await graphSpawnArgs("claude", input({ enabled: false, brief }))).toEqual([]);
    expect(brief).not.toHaveBeenCalled();
  });

  it("gives a secure pane nothing: the sidecar cannot run inside the jail", async () => {
    expect(await graphSpawnArgs("claude", input({ secure: true }))).toEqual([]);
    expect(await graphSpawnArgs("codex", input({ secure: true }))).toEqual([]);
  });
});
