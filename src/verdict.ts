import type { Finding, LiveTableStats, Severity } from "./types.js";

const LARGE_TABLE_ROWS = 100_000;
const MEDIUM_TABLE_ROWS = 10_000;
const HIGH_DEAD_TUPLE_RATIO = 0.2;

const SEVERITY_RANK: Record<Severity, number> = { info: 0, caution: 1, block: 2 };

function worse(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * Takes a rule's static (table-size-blind) severity and adjusts it using the
 * real numbers pulled from the live database for that specific table. This
 * is the step every static-only linter (Squawk, Atlas's free tier,
 * MigrationPilot) explicitly skips -- their rule hit is the same whether the
 * table has 12 rows or 12 million. Here, 12 rows downgrades a lock-taking
 * rule to "info"; 12 million with live writers in flight escalates it.
 */
export function adjustSeverityWithLiveStats(
  finding: Finding,
  stats: LiveTableStats | undefined,
): { severity: Severity; liveReasoning: string | null } {
  if (!stats || !stats.exists) {
    return {
      severity: finding.severity,
      liveReasoning: stats
        ? `Table "${finding.table}" does not exist yet in this database -- this statement ` +
          `presumably creates it earlier in the same migration, so no live-traffic risk applies.`
        : null,
    };
  }

  // Rules that are about correctness, not locking (e.g. missing DEFAULT on
  // a NOT NULL column, DELETE without WHERE) are not adjusted by table size:
  // they're exactly as broken on a 10-row table as a 10-million-row one.
  const LOCK_SENSITIVE_RULES = new Set([
    "create-index-without-concurrently",
    "set-not-null",
    "add-fk-without-not-valid",
    "add-check-without-not-valid",
    "add-unique-builds-index-inline",
    "alter-column-type",
    "drop-column",
  ]);

  if (!LOCK_SENSITIVE_RULES.has(finding.ruleId)) {
    return { severity: finding.severity, liveReasoning: null };
  }

  const rows = stats.approxRowCount;
  const sizeMb = (stats.totalSizeBytes / (1024 * 1024)).toFixed(1);
  const blockers = stats.activeBlockingBackends;

  const reasons: string[] = [];

  // The live row count REPLACES the static severity for lock-sensitive
  // rules, rather than only ever escalating it -- a rule that's always
  // "block" in a static linter (CREATE INDEX without CONCURRENTLY) is
  // genuinely not dangerous against a 3-row table today, and a tool that
  // can't say so is giving the same answer on every table, which is the
  // exact gap this live-stats layer exists to close.
  let severity: Severity;
  if (rows >= LARGE_TABLE_ROWS) {
    severity = "block";
    reasons.push(
      `"${finding.table}" has an estimated ${rows.toLocaleString()} rows (${sizeMb} MB) ` +
        `right now -- large enough that the lock this statement takes will be held for a ` +
        `duration proportional to that, not the few milliseconds a small staging copy shows.`,
    );
  } else if (rows >= MEDIUM_TABLE_ROWS) {
    severity = "caution";
    reasons.push(
      `"${finding.table}" has an estimated ${rows.toLocaleString()} rows (${sizeMb} MB) -- ` +
        `not huge, but enough that the lock duration is measurable, not instant.`,
    );
  } else {
    severity = "info";
    reasons.push(
      `"${finding.table}" has only an estimated ${rows.toLocaleString()} rows right now, so ` +
        `this specific lock would likely clear in milliseconds today -- the rule is still ` +
        `correct in general, re-check this once the table has grown.`,
    );
  }

  if (blockers > 0) {
    severity = "block";
    reasons.push(
      `${blockers} active backend(s) are holding or waiting on a lock against ` +
        `"${finding.table}" at this exact moment -- running this migration right now would ` +
        `queue behind (or deadlock with) that real, currently-running traffic.`,
    );
  }

  if (stats.deadTupleRatio >= HIGH_DEAD_TUPLE_RATIO) {
    reasons.push(
      `${(stats.deadTupleRatio * 100).toFixed(0)}% of "${finding.table}"'s rows are dead ` +
        `tuples not yet reclaimed by autovacuum (last autovacuum: ${stats.lastAutovacuum ?? "never"}) ` +
        `-- any full-table scan this statement runs will be slower than the live row count alone suggests.`,
    );
  }

  return {
    severity,
    liveReasoning: reasons.length > 0 ? reasons.join(" ") : null,
  };
}

export function rollUpSeverity(severities: Severity[]): Severity {
  return severities.reduce((acc, s) => worse(acc, s), "info" as Severity);
}
