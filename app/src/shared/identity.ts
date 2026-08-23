// identity.ts — "cor por CLI, consistente em todas as telas". A task card, a
// worktree table, a chat bubble and the workforce roster all render the same
// agent, so the mapping lives where both processes can import it.

const DESIGNED: Record<string, { color: string; initials: string }> = {
  claude: { color: "#f08a63", initials: "cl" },
  codex: { color: "#4cc8c0", initials: "cx" },
  cursor: { color: "#a98cf5", initials: "cu" },
  cursorsdk: { color: "#a98cf5", initials: "cs" },
  opencode: { color: "#a3d05a", initials: "oc" },
  grok: { color: "#8b94a7", initials: "gk" },
  agy: { color: "#5aa7f0", initials: "ag" },
};

// anything the registry grows later still gets a stable colour instead of
// falling through to grey — one less thing to remember when adding a cli.
const FALLBACK = ["#5aa7f0", "#f0b04e", "#ee6a5f", "#53d08a", "#c58af9"];

export function agentColor(cli: string): string {
  const known = DESIGNED[cli];
  if (known) return known.color;
  let h = 0;
  for (const ch of cli) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK[h % FALLBACK.length];
}

export function agentInitials(cli: string): string {
  return DESIGNED[cli]?.initials ?? cli.slice(0, 2);
}
