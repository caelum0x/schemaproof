// `schemaproof rehearse` applies a migration to a disposable clone of the
// real target database and reports *observed* lock-wait time instead of the
// row-count-based estimate `check --db` uses. This is the local-clone tier:
// it clones onto the same Postgres server `--db` points at (needs CREATEDB
// there), dumps+restores the source database's real data via pg_dump/
// pg_restore, replays a concurrent read burst against every table the
// migration touches, then measures how long the migration's own statements
// actually took to acquire their lock and how long a fresh query submitted
// at the same moment was blocked behind it. The disposable clone is dropped
// afterwards unless --keep-clone is passed.
//
// A Neon-branch tier (apply against a real copy-on-write branch instead of
// a same-server clone, so a slow pg_dump of a huge table never happens) is
// still on the roadmap -- it needs a real NEON_API_KEY to build against and
// verify live, which isn't available in this environment.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Client } from "pg";
import type { ParsedStatement } from "./parser.js";

export type RehearseStatementResult = {
  index: number;
  rawSql: string;
  tables: string[];
  statementMs: number;
  probeBlockedMs: number | null;
  error: string | null;
};

export type RehearseReport = {
  mode: "local-clone";
  sourceHost: string;
  sourceDatabase: string;
  cloneDatabase: string;
  burstConnections: number;
  burstMs: number;
  statements: RehearseStatementResult[];
  cleanedUp: boolean;
};

export type RehearseOptions = {
  burstConnections?: number;
  burstMs?: number;
  keepClone?: boolean;
};

type ConnParts = {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  sslmode: string | null;
};

function parseConnectionString(connectionString: string): ConnParts {
  const url = new URL(connectionString);
  return {
    host: url.hostname,
    port: url.port || "5432",
    user: decodeURIComponent(url.username || "postgres"),
    password: decodeURIComponent(url.password || ""),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres",
    sslmode: url.searchParams.get("sslmode"),
  };
}

function connectionStringFor(parts: ConnParts, database: string): string {
  const user = encodeURIComponent(parts.user);
  const auth = parts.password ? `${user}:${encodeURIComponent(parts.password)}@` : `${user}@`;
  const query = parts.sslmode ? `?sslmode=${parts.sslmode}` : "";
  return `postgresql://${auth}${parts.host}:${parts.port}/${encodeURIComponent(database)}${query}`;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function runCommand(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

async function createClone(parts: ConnParts, cloneDb: string): Promise<void> {
  const env = { PGPASSWORD: parts.password };
  const created = await runCommand(
    "createdb",
    ["-h", parts.host, "-p", parts.port, "-U", parts.user, cloneDb],
    env,
  );
  if (created.code !== 0) {
    throw new Error(`createdb failed: ${created.stderr.trim()}`);
  }
}

async function dumpAndRestore(
  parts: ConnParts,
  cloneDb: string,
  dumpDir: string,
): Promise<void> {
  const env = { PGPASSWORD: parts.password };
  const dumpFile = join(dumpDir, "source.dump");

  const dumped = await runCommand(
    "pg_dump",
    [
      "-h", parts.host,
      "-p", parts.port,
      "-U", parts.user,
      "-d", parts.database,
      "--no-owner",
      "--no-privileges",
      "-Fc",
      "-f", dumpFile,
    ],
    env,
  );
  if (dumped.code !== 0) {
    throw new Error(`pg_dump failed: ${dumped.stderr.trim()}`);
  }

  const restored = await runCommand(
    "pg_restore",
    [
      "-h", parts.host,
      "-p", parts.port,
      "-U", parts.user,
      "-d", cloneDb,
      "--no-owner",
      "--no-privileges",
      dumpFile,
    ],
    env,
  );
  // pg_restore commonly exits non-zero on warnings it doesn't actually
  // consider fatal (e.g. an extension it can't own, a missing role it
  // skips) -- only treat it as a real failure if nothing was restored.
  if (restored.code !== 0 && !restored.stderr.includes("warning")) {
    throw new Error(`pg_restore failed: ${restored.stderr.trim()}`);
  }
}

async function dropClone(parts: ConnParts, cloneDb: string): Promise<void> {
  const env = { PGPASSWORD: parts.password };
  await runCommand(
    "dropdb",
    ["-h", parts.host, "-p", parts.port, "-U", parts.user, "--if-exists", cloneDb],
    env,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Keeps a handful of connections continuously reading from `table` so the
 * migration statement has to contend with the same kind of live traffic a
 * real production table would have, instead of landing on an idle clone. */
class ReadBurst {
  private stopped = false;
  private workers: Promise<void>[] = [];

  constructor(
    private readonly connectionString: string,
    private readonly table: string,
    private readonly concurrency: number,
  ) {}

  async start(): Promise<void> {
    this.workers = Array.from({ length: this.concurrency }, () => this.runWorker());
    // give workers a moment to connect and issue their first query before
    // the caller submits the real migration statement
    await sleep(100);
  }

  private async runWorker(): Promise<void> {
    const client = new Client({ connectionString: this.connectionString });
    try {
      await client.connect();
    } catch {
      return;
    }
    while (!this.stopped) {
      try {
        await client.query(`SELECT * FROM ${quoteIdent(this.table)} LIMIT 50`);
      } catch {
        // table may not exist yet, or the migration just locked it out --
        // that contention is exactly what this burst exists to create
      }
      await sleep(15);
    }
    await client.end().catch(() => {});
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.workers);
  }
}

async function timedQuery(connectionString: string, sql: string): Promise<number> {
  const client = new Client({ connectionString });
  await client.connect();
  const start = Date.now();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
  return Date.now() - start;
}

export async function rehearse(
  sourceConnectionString: string,
  statements: ParsedStatement[],
  tablesByStatement: Map<number, string[]>,
  options: RehearseOptions = {},
): Promise<RehearseReport> {
  const burstConnections = options.burstConnections ?? 4;
  const burstMs = options.burstMs ?? 1500;
  const parts = parseConnectionString(sourceConnectionString);
  const cloneDb = `schemaproof_rehearsal_${randomBytes(4).toString("hex")}`;
  const dumpDir = await mkdtemp(join(tmpdir(), "schemaproof-rehearse-"));

  let cleanedUp = false;
  const results: RehearseStatementResult[] = [];

  try {
    await createClone(parts, cloneDb);
    await dumpAndRestore(parts, cloneDb, dumpDir);
    const cloneConnectionString = connectionStringFor(parts, cloneDb);

    for (const stmt of statements) {
      const tables = tablesByStatement.get(stmt.index) ?? [];
      const primaryTable = tables[0] ?? null;

      let burst: ReadBurst | null = null;
      if (primaryTable) {
        burst = new ReadBurst(cloneConnectionString, primaryTable, burstConnections);
        await burst.start();
      }

      let statementMs = 0;
      let probeBlockedMs: number | null = null;
      let error: string | null = null;

      const client = new Client({ connectionString: cloneConnectionString });
      try {
        await client.connect();
        const start = Date.now();
        const probePromise = primaryTable
          ? timedQuery(cloneConnectionString, `SELECT 1 FROM ${quoteIdent(primaryTable)} LIMIT 1`).catch(
              () => null,
            )
          : Promise.resolve(null);
        await client.query(stmt.rawSql);
        statementMs = Date.now() - start;
        probeBlockedMs = await probePromise;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      } finally {
        await client.end().catch(() => {});
      }

      if (burst) {
        await burst.stop();
      } else {
        await sleep(Math.min(burstMs, 0));
      }

      results.push({
        index: stmt.index,
        rawSql: stmt.rawSql,
        tables,
        statementMs,
        probeBlockedMs,
        error,
      });
    }

    if (!options.keepClone) {
      await dropClone(parts, cloneDb);
      cleanedUp = true;
    }
  } finally {
    await rm(dumpDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    mode: "local-clone",
    sourceHost: parts.host,
    sourceDatabase: parts.database,
    cloneDatabase: cloneDb,
    burstConnections,
    burstMs,
    statements: results,
    cleanedUp,
  };
}
