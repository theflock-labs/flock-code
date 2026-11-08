// The demo's agents get their names in a fixed order (vite.demo.config.ts
// swaps this in for src/lib/agentNames.ts), so the story reads the same every
// time: the agents it adds to the checkout thread are Wren, Nova and Finn,
// which is also how demo.ts knows which recording each one plays.
const NAMES = ["Wren", "Nova", "Finn", "Milo", "Luna", "Theo", "Fern", "Basil", "Iggy", "Moss"];

export function randomAgentName(taken: Iterable<string | undefined> = []): string {
  const used = new Set(taken);
  return NAMES.find((n) => !used.has(n)) ?? `Agent ${used.size + 1}`;
}
