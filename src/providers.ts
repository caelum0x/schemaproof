import type { Provider } from "./types.js";

/**
 * Detects which managed Postgres the connection string points at, purely
 * from the host, so the CLI can surface provider-specific advice (Supabase's
 * pooler runs in transaction mode on port 6543, which breaks session-level
 * advisory locks and prepared statements some migration tools rely on; Neon
 * branch URLs are safe to point this tool at directly since a branch is
 * already a disposable copy).
 */
export function detectProvider(connectionString: string): Provider {
  let host = "";
  try {
    host = new URL(connectionString).hostname;
  } catch {
    host = connectionString;
  }

  if (host.includes("supabase.co") || host.includes("supabase.com")) {
    return "supabase";
  }
  if (host.includes("neon.tech") || host.includes("neon.build")) {
    return "neon";
  }
  return "plain-postgres";
}

export function providerNote(provider: Provider, connectionString: string): string | null {
  if (provider === "supabase" && connectionString.includes(":6543")) {
    return (
      "Connected via Supabase's pooled port (6543, transaction mode). " +
      "CREATE INDEX CONCURRENTLY and multi-statement NOT VALID/VALIDATE sequences " +
      "need a real session -- re-run against the direct connection (port 5432) or " +
      "Supabase's session-mode pooler for anything flagged below as requiring a separate step."
    );
  }
  if (provider === "neon") {
    return (
      "Neon detected. If this connection string points at a branch (not main), " +
      "the live stats below are the branch's copy-on-write data, which matches " +
      "main's row counts at branch-creation time but won't reflect write traffic " +
      "that only happened on main since then."
    );
  }
  return null;
}
