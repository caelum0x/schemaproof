#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { parseMigration } from "./parser.js";
import { applyRules, applyFileLevelRules } from "./rules.js";
import { getLiveTableStats } from "./liveStats.js";
import { detectProvider, providerNote } from "./providers.js";
import { adjustSeverityWithLiveStats, rollUpSeverity } from "./verdict.js";
import { explainWithAi } from "./ai.js";
import { rehearse } from "./rehearse.js";
import type { Finding, LiveTableStats, Severity } from "./types.js";

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const command = args[0];
  const file = args[1];
  let db: string | undefined;
  let json = false;
  let prComment = false;
  let keepClone = false;
  let burstConnections: number | undefined;
  let burstMs: number | undefined;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--db") db = args[++i];
    else if (args[i] === "--json") json = true;
    else if (args[i] === "--pr-comment") prComment = true;
    else if (args[i] === "--keep-clone") keepClone = true;
    else if (args[i] === "--burst-connections") burstConnections = Number(args[++i]);
    else if (args[i] === "--burst-ms") burstMs = Number(args[++i]);
  }
  return { command, file, db, json, prComment, keepClone, burstConnections, burstMs };
}

const SEVERITY_LABEL: Record<Severity, string> = {
  block: "BLOCK",
  caution: "CAUTION",
  info: "INFO",
};

const SEVERITY_ICON: Record<Severity, string> = {
  block: "\x1b[31m✖\x1b[0m",
  caution: "\x1b[33m▲\x1b[0m",
  info: "\x1b[36mi\x1b[0m",
};

const SEVERITY_EMOJI: Record<Severity, string> = {
  block: "🛑",
  caution: "⚠️",
  info: "ℹ️",
};

const USAGE =
  "schemaproof check <migration.sql> [--db <connection-string>] [--json] [--pr-comment]\n\n" +
  "Without --db: static lock-classification only (same tier as Squawk/Atlas-free).\n" +
  "With --db:    also reads the real target database's catalog/pg_stat views and\n" +
  "              adjusts severity against the table's real row count, dead-tuple\n" +
  "              ratio and currently-active blockers. Set ANTHROPIC_API_KEY to also\n" +
  "              get an AI-written plain-English explanation + safe rewrite.\n" +
  "--pr-comment: print a GitHub-flavored markdown report (verdict table + a\n" +
  "              collapsible per-statement detail section) instead of the plain-\n" +
  "              text or --json report, ready to post as a PR comment body in\n" +
  "              whatever CI step your own repo already runs.\n\n" +
  "schemaproof rehearse <migration.sql> --db <connection-string> [--json]\n" +
  "              [--keep-clone] [--burst-connections <n>] [--burst-ms <ms>]\n\n" +
  "              Clones --db onto the same server (needs CREATEDB there),\n" +
  "              replays a concurrent read burst against every table the\n" +
  "              migration touches, and reports the real observed lock-wait\n" +
  "              time instead of check's row-count-based estimate. Drops the\n" +
  "              clone afterwards unless --keep-clone is passed.";

/**
 * Markdown report sized for a GitHub PR comment body, not a terminal — a one-line
 * verdict badge + a table of every statement's worst finding (what a reviewer
 * actually needs at a glance) followed by a `<details>` block per statement with
 * the real finding/live-stats/safe-rewrite text, so the comment stays short until
 * expanded. Built from the exact same `report`/`worstOverall` the plain-text and
 * `--json` paths already compute — no separate re-run against a weaker summary.
 */
function renderPrComment(report: Array<Record<string, any>>, worstOverall: Severity): string {
  const lines: string[] = [];
  lines.push(`### ${SEVERITY_EMOJI[worstOverall]} SchemaProof: ${SEVERITY_LABEL[worstOverall]}`);
  lines.push("");
  lines.push("| # | Verdict | Statement |");
  lines.push("|---|---|---|");
  report.forEach((r, i) => {
    const firstLine = String(r.statement).trim().split("\n")[0].slice(0, 80);
    lines.push(`| ${i + 1} | ${SEVERITY_EMOJI[r.verdict as Severity]} ${SEVERITY_LABEL[r.verdict as Severity]} | \`${firstLine}\` |`);
  });
  lines.push("");

  for (let i = 0; i < report.length; i++) {
    const r = report[i];
    if (r.findings.length === 0) continue;
    lines.push(`<details>`);
    lines.push(`<summary>Statement ${i + 1}: ${SEVERITY_EMOJI[r.verdict as Severity]} ${SEVERITY_LABEL[r.verdict as Severity]}</summary>`);
    lines.push("");
    lines.push("```sql");
    lines.push(String(r.statement).trim());
    lines.push("```");
    for (const f of r.findings) {
      lines.push(`- ${SEVERITY_EMOJI[f.severity as Severity]} **${f.ruleId}** — ${f.summary}`);
      lines.push(`  ${f.detail}`);
      if (f.liveReasoning) lines.push(`  \n  _live:_ ${f.liveReasoning}`);
      if (f.safeRewrite) {
        lines.push("  \n  Safe rewrite:");
        lines.push("  ```sql");
        lines.push("  " + String(f.safeRewrite).split("\n").join("\n  "));
        lines.push("  ```");
      }
    }
    if (r.aiExplanation) {
      lines.push("");
      lines.push(`**AI explanation:** ${r.aiExplanation}`);
    }
    lines.push("</details>");
    lines.push("");
  }

  lines.push("_Generated by [schemaproof](https://github.com/caelum0x/schemaproof) — live-database-aware Postgres migration safety checker._");
  return lines.join("\n");
}

async function runCheck(file: string, db: string | undefined, json: boolean, prComment = false): Promise<void> {
  const sql = readFileSync(file, "utf8");
  const statements = await parseMigration(sql);
  const fileLevelFindings = applyFileLevelRules(statements);

  let client: Client | null = null;
  if (db) {
    client = new Client({ connectionString: db });
    await client.connect();
    const provider = detectProvider(db);
    const note = providerNote(provider, db);
    if (!json) {
      console.log(`Provider detected: ${provider}`);
      if (note) console.log(`Note: ${note}\n`);
    }
  }

  const report: any[] = [];
  let worstOverall: Severity = "info";

  for (const stmt of statements) {
    const findings: Finding[] = [
      ...applyRules(stmt.node, stmt.rawSql),
      ...(fileLevelFindings.get(stmt.index) ?? []),
    ];
    const statsByTable = new Map<string, LiveTableStats>();

    if (client) {
      const tables = new Set(findings.map((f) => f.table).filter(Boolean) as string[]);
      for (const table of tables) {
        statsByTable.set(table, await getLiveTableStats(client, table));
      }
    }

    const adjustedFindings = findings.map((f) => {
      const stats = f.table ? statsByTable.get(f.table) : undefined;
      const { severity, liveReasoning } = adjustSeverityWithLiveStats(f, stats);
      return { ...f, severity, liveReasoning };
    });

    const stmtVerdict = rollUpSeverity(adjustedFindings.map((f) => f.severity));
    worstOverall = rollUpSeverity([worstOverall, stmtVerdict]);

    let aiExplanation: string | null = null;
    if (client && adjustedFindings.length > 0) {
      aiExplanation = await explainWithAi(
        stmt.rawSql,
        adjustedFindings,
        Array.from(statsByTable.values()),
      );
    }

    report.push({
      statement: stmt.rawSql,
      verdict: stmtVerdict,
      findings: adjustedFindings,
      liveStats: Array.from(statsByTable.values()),
      aiExplanation,
    });
  }

  if (client) await client.end();

  if (prComment) {
    console.log(renderPrComment(report, worstOverall));
  } else if (json) {
    console.log(JSON.stringify({ overallVerdict: worstOverall, statements: report }, null, 2));
  } else {
    for (const r of report) {
      console.log("―".repeat(72));
      console.log(r.statement);
      if (r.findings.length === 0) {
        console.log(`${SEVERITY_ICON.info} no risk rules triggered`);
        continue;
      }
      for (const f of r.findings) {
        const sev: Severity = f.severity;
        console.log(`${SEVERITY_ICON[sev]} [${SEVERITY_LABEL[sev]}] ${f.ruleId} -- ${f.summary}`);
        console.log(`   ${f.detail}`);
        if (f.liveReasoning) console.log(`   live: ${f.liveReasoning}`);
        if (f.safeRewrite) console.log(`   safe rewrite:\n${f.safeRewrite.split("\n").map((l: string) => "     " + l).join("\n")}`);
      }
      if (r.aiExplanation) {
        console.log(`\n   AI explanation:\n${r.aiExplanation}`);
      }
    }
    console.log("―".repeat(72));
    console.log(`Overall verdict: ${SEVERITY_LABEL[worstOverall]}`);
  }

  if (worstOverall === "block") process.exitCode = 2;
  else if (worstOverall === "caution") process.exitCode = 1;
}

async function runRehearse(
  file: string,
  db: string | undefined,
  json: boolean,
  keepClone: boolean,
  burstConnections: number | undefined,
  burstMs: number | undefined,
): Promise<void> {
  if (!db) {
    console.error("schemaproof rehearse requires --db <connection-string>");
    process.exitCode = 1;
    return;
  }

  const sql = readFileSync(file, "utf8");
  const statements = await parseMigration(sql);
  const tablesByStatement = new Map<number, string[]>();
  for (const stmt of statements) {
    const findings = applyRules(stmt.node, stmt.rawSql);
    const tables = Array.from(new Set(findings.map((f) => f.table).filter(Boolean) as string[]));
    tablesByStatement.set(stmt.index, tables);
  }

  if (!json) {
    console.log(`Cloning ${new URL(db).hostname} to rehearse ${statements.length} statement(s)...`);
  }

  const report = await rehearse(db, statements, tablesByStatement, {
    keepClone,
    burstConnections,
    burstMs,
  });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Clone database: ${report.cloneDatabase} (${report.cleanedUp ? "dropped" : "kept"})`);
    console.log(`Burst: ${report.burstConnections} concurrent readers per statement\n`);
    for (const s of report.statements) {
      console.log("―".repeat(72));
      console.log(s.rawSql);
      if (s.error) {
        console.log(`\x1b[31mfailed: ${s.error}\x1b[0m`);
        continue;
      }
      console.log(`observed lock-acquire + execute time: ${s.statementMs}ms`);
      if (s.probeBlockedMs !== null) {
        console.log(`a fresh query against the same table, submitted at the same moment, waited: ${s.probeBlockedMs}ms`);
      }
    }
    console.log("―".repeat(72));
  }
}

async function main(): Promise<void> {
  const { command, file, db, json, prComment, keepClone, burstConnections, burstMs } = parseArgs(process.argv);

  if (command === "check" && file) {
    await runCheck(file, db, json, prComment);
    return;
  }

  if (command === "rehearse" && file) {
    await runRehearse(file, db, json, keepClone, burstConnections, burstMs);
    return;
  }

  console.log(USAGE);
  process.exitCode = command === "check" || command === "rehearse" ? 1 : 0;
}

main().catch((err) => {
  console.error("schemaproof error:", err?.message ?? err);
  process.exitCode = 1;
});
