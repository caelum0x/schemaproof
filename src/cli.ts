#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { parseMigration } from "./parser.js";
import { applyRules } from "./rules.js";
import { getLiveTableStats } from "./liveStats.js";
import { detectProvider, providerNote } from "./providers.js";
import { adjustSeverityWithLiveStats, rollUpSeverity } from "./verdict.js";
import { explainWithAi } from "./ai.js";
import type { Finding, LiveTableStats, Severity } from "./types.js";

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const command = args[0];
  const file = args[1];
  let db: string | undefined;
  let json = false;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--db") db = args[++i];
    else if (args[i] === "--json") json = true;
  }
  return { command, file, db, json };
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

async function main() {
  const { command, file, db, json } = parseArgs(process.argv);

  if (command !== "check" || !file) {
    console.log(
      "schemaproof check <migration.sql> [--db <connection-string>] [--json]\n\n" +
        "Without --db: static lock-classification only (same tier as Squawk/Atlas-free).\n" +
        "With --db:    also reads the real target database's catalog/pg_stat views and\n" +
        "              adjusts severity against the table's real row count, dead-tuple\n" +
        "              ratio and currently-active blockers. Set ANTHROPIC_API_KEY to also\n" +
        "              get an AI-written plain-English explanation + safe rewrite.",
    );
    process.exitCode = command === "check" ? 1 : 0;
    return;
  }

  const sql = readFileSync(file, "utf8");
  const statements = await parseMigration(sql);

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
    const findings: Finding[] = applyRules(stmt.node, stmt.rawSql);
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

  if (json) {
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

main().catch((err) => {
  console.error("schemaproof error:", err?.message ?? err);
  process.exitCode = 1;
});
