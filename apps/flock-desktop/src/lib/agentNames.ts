// Whimsical, easy-to-say names assigned to each agent pane on spawn so
// panes can be told apart at a glance ("Pluto is still working" vs "pane 3").
const AGENT_NAMES = [
  "Pluto", "Harry", "Willy", "Zed", "Nova", "Juno", "Otto", "Remi",
  "Finn", "Wren", "Milo", "Suki", "Kip", "Theo", "Luna", "Basil",
  "Rex", "Enzo", "Coco", "Astrid", "Bodhi", "Fern", "Gus", "Hazel",
  "Iggy", "Jax", "Kiwi", "Lark", "Moss", "Ozzy", "Peach", "Quill",
  "Rufus", "Sable", "Tux", "Uma", "Vesper", "Wolf", "Yuki", "Zinnia",
];

/** Pick a random agent name, preferring one not already in use. */
export function randomAgentName(taken: Iterable<string | undefined> = []): string {
  const takenSet = new Set(taken);
  const available = AGENT_NAMES.filter((n) => !takenSet.has(n));
  const pool = available.length > 0 ? available : AGENT_NAMES;
  return pool[Math.floor(Math.random() * pool.length)];
}
