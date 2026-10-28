import type { Finding } from "./types.js";

// Default expressions that PostgreSQL can prove are immutable/constant at
// ADD COLUMN time, so the "fast default" optimization (PG11+) applies and no
// table rewrite happens. Anything else (an arithmetic/concat expression, a
// genuinely VOLATILE FuncCall like random(), gen_random_uuid(), nextval(...))
// is treated as "possibly volatile" and flagged, because Postgres still
// rewrites the whole table for those even on modern versions.
const SAFE_CONST_DEFAULT_NODES = new Set(["A_Const", "TypeCast"]);

// SQLValueFunction nodes (CURRENT_TIMESTAMP, CURRENT_DATE, CURRENT_TIME,
// LOCALTIME, LOCALTIMESTAMP, CURRENT_USER, SESSION_USER, etc.) have no
// side effects and are STABLE, not VOLATILE -- same fast-default path as a
// literal constant, not a per-row table rewrite.
//
// now() is the single FuncCall name allow-listed below for the same reason:
// it's STABLE (pg_proc.provolatile = 's'), not VOLATILE, despite being a
// function call. The previous version of this rule treated every FuncCall
// default (including now() and CURRENT_TIMESTAMP) as "possibly volatile" and
// returned BLOCK/"forces a full table rewrite" -- a false positive on one of
// the most common real-world migration patterns (`created_at timestamptz
// DEFAULT now()`).
//
// Verified live against a real seeded Postgres 14 instance (200k-row table,
// not guessed from docs): after `ADD COLUMN ... DEFAULT now()` /
// `DEFAULT CURRENT_TIMESTAMP` / `DEFAULT CURRENT_DATE`, `pg_relation_filenode()`
// was unchanged and `pg_attribute.atthasmissing` was true (fast-default path,
// no rewrite) -- identical to a literal constant default. By contrast,
// `DEFAULT random()` (genuinely VOLATILE) changed the relfilenode,
// `atthasmissing` was false, and existing rows got distinct per-row values
// -- a real rewrite. Do not add more names to SAFE_FUNC_CALL_NAMES without
// confirming `SELECT provolatile FROM pg_proc WHERE proname = '<name>'`
// is not `'v'` -- gen_random_uuid(), nextval(), clock_timestamp(), and
// random() are all genuinely `'v'` and must keep returning BLOCK.
const SAFE_FUNC_CALL_NAMES = new Set(["now"]);

function relname(node: any): string | null {
  return node?.relation?.relname ?? null;
}

function hasConstraint(colDef: any, contype: string): any | undefined {
  return (colDef?.constraints ?? []).find(
    (c: any) => c?.Constraint?.contype === contype,
  )?.Constraint;
}

function isVolatileDefault(defaultConstraint: any): boolean {
  const rawExpr = defaultConstraint?.raw_expr;
  if (!rawExpr) return false;
  const kind = Object.keys(rawExpr)[0];
  if (SAFE_CONST_DEFAULT_NODES.has(kind)) return false;
  if (kind === "SQLValueFunction") return false;
  if (kind === "FuncCall") {
    const funcname = (rawExpr.FuncCall?.funcname ?? [])
      .map((n: any) => n?.String?.sval)
      .filter(Boolean)
      .join(".");
    if (SAFE_FUNC_CALL_NAMES.has(funcname)) return false;
  }
  return true;
}

function describeType(typeName: any): string {
  const names = (typeName?.names ?? [])
    .map((n: any) => n?.String?.sval)
    .filter((v: any) => v && v !== "pg_catalog");
  return names.join(".") || "unknown";
}

/** One rule per AlterTableCmd. Each returns null when it doesn't apply. */
const ALTER_TABLE_CMD_RULES: Array<(cmd: any, table: string | null) => Finding | null> = [
  // AT_AddColumn
  (cmd, table) => {
    if (cmd.subtype !== "AT_AddColumn") return null;
    const colDef = cmd.def?.ColumnDef;
    if (!colDef) return null;
    const notNull = hasConstraint(colDef, "CONSTR_NOTNULL");
    const def = hasConstraint(colDef, "CONSTR_DEFAULT");

    if (def && isVolatileDefault(def)) {
      return {
        ruleId: "add-column-volatile-default",
        severity: "block",
        table,
        summary: `ADD COLUMN "${colDef.colname}" uses a non-constant DEFAULT`,
        detail:
          `PostgreSQL's "fast default" optimization (11+) only skips the table rewrite ` +
          `when the DEFAULT is a literal constant Postgres can prove is immutable. ` +
          `A VOLATILE function call (random(), gen_random_uuid(), nextval(...), ` +
          `clock_timestamp(), etc.) is evaluated ` +
          `per-row, which forces a full table rewrite under an ACCESS EXCLUSIVE lock -- ` +
          `the exact same cost as the pre-PG11 "every ADD COLUMN rewrites the table" problem.`,
        safeRewrite:
          `-- 1) add the column nullable, no default\n` +
          `ALTER TABLE ${table} ADD COLUMN "${colDef.colname}" ${describeType(colDef.typeName)};\n` +
          `-- 2) backfill in batches (application code or a batched UPDATE ... WHERE id BETWEEN ...)\n` +
          `-- 3) only after backfill, add NOT NULL via the safe NOT NULL rewrite below (if needed)`,
      };
    }

    if (notNull && !def) {
      return {
        ruleId: "add-notnull-column-without-default",
        severity: "block",
        table,
        summary: `ADD COLUMN "${colDef.colname}" is NOT NULL with no DEFAULT`,
        detail:
          `Postgres will reject this migration outright against any table that already ` +
          `has rows (NOT NULL has nothing to backfill existing rows with). This isn't a ` +
          `locking risk, it's a guaranteed migration failure on a non-empty table.`,
        safeRewrite:
          `ALTER TABLE ${table} ADD COLUMN "${colDef.colname}" ${describeType(colDef.typeName)};\n` +
          `-- backfill existing rows, then:\n` +
          `ALTER TABLE ${table} ALTER COLUMN "${colDef.colname}" SET NOT NULL;`,
      };
    }
    return null;
  },

  // AT_SetNotNull
  (cmd, table) => {
    if (cmd.subtype !== "AT_SetNotNull") return null;
    return {
      ruleId: "set-not-null",
      severity: "caution",
      table,
      summary: `SET NOT NULL on "${cmd.name}" scans the whole table under ACCESS EXCLUSIVE`,
      detail:
        `SET NOT NULL requires Postgres to verify every existing row is non-null. That scan ` +
        `happens while holding ACCESS EXCLUSIVE, which blocks every reader and writer on the ` +
        `table for the duration of the scan -- proportional to row count.`,
      safeRewrite:
        `ALTER TABLE ${table} ADD CONSTRAINT "${table}_${cmd.name}_not_null_chk" ` +
        `CHECK ("${cmd.name}" IS NOT NULL) NOT VALID;\n` +
        `ALTER TABLE ${table} VALIDATE CONSTRAINT "${table}_${cmd.name}_not_null_chk";` +
        ` -- takes SHARE UPDATE EXCLUSIVE, not ACCESS EXCLUSIVE\n` +
        `ALTER TABLE ${table} ALTER COLUMN "${cmd.name}" SET NOT NULL;` +
        ` -- now instant: Postgres trusts the already-validated CHECK\n` +
        `ALTER TABLE ${table} DROP CONSTRAINT "${table}_${cmd.name}_not_null_chk";`,
    };
  },

  // AT_AddConstraint -- FK / CHECK / UNIQUE
  (cmd, table) => {
    if (cmd.subtype !== "AT_AddConstraint") return null;
    const con = cmd.def?.Constraint;
    if (!con) return null;

    if (con.contype === "CONSTR_FOREIGN" && !con.skip_validation) {
      return {
        ruleId: "add-fk-without-not-valid",
        severity: "caution",
        table,
        summary: `ADD CONSTRAINT ${con.conname ?? ""} FOREIGN KEY validates inline`,
        detail:
          `Adding a FOREIGN KEY without NOT VALID makes Postgres scan and lock both the ` +
          `child and parent tables to verify every existing row before the DDL returns. ` +
          `On a large or hot table that scan runs under a lock that blocks writes to both tables.`,
        safeRewrite:
          `ALTER TABLE ${table} ADD CONSTRAINT ${con.conname ?? "fk_name"} ` +
          `FOREIGN KEY (...) REFERENCES ...(...) NOT VALID;\n` +
          `ALTER TABLE ${table} VALIDATE CONSTRAINT ${con.conname ?? "fk_name"};` +
          ` -- separate transaction, SHARE UPDATE EXCLUSIVE only`,
      };
    }

    if (con.contype === "CONSTR_CHECK" && !con.skip_validation) {
      return {
        ruleId: "add-check-without-not-valid",
        severity: "caution",
        table,
        summary: `ADD CONSTRAINT ${con.conname ?? ""} CHECK validates inline`,
        detail:
          `A CHECK constraint added without NOT VALID is validated against every existing ` +
          `row in the same statement, under a lock that blocks concurrent writers until the ` +
          `scan finishes.`,
        safeRewrite:
          `ALTER TABLE ${table} ADD CONSTRAINT ${con.conname ?? "chk_name"} CHECK (...) NOT VALID;\n` +
          `ALTER TABLE ${table} VALIDATE CONSTRAINT ${con.conname ?? "chk_name"};`,
      };
    }

    if (con.contype === "CONSTR_UNIQUE") {
      return {
        ruleId: "add-unique-builds-index-inline",
        severity: "caution",
        table,
        summary: `ADD CONSTRAINT ${con.conname ?? ""} UNIQUE builds its index inline`,
        detail:
          `Adding a UNIQUE constraint this way builds the backing btree index inline, taking ` +
          `the same SHARE lock as a non-concurrent CREATE INDEX -- writes to the table queue ` +
          `behind the index build.`,
        safeRewrite:
          `CREATE UNIQUE INDEX CONCURRENTLY ${con.conname ?? "uq_idx"} ON ${table} (...);\n` +
          `ALTER TABLE ${table} ADD CONSTRAINT ${con.conname ?? "uq_name"} ` +
          `UNIQUE USING INDEX ${con.conname ?? "uq_idx"};`,
      };
    }
    return null;
  },

  // AT_DropColumn
  (cmd, table) => {
    if (cmd.subtype !== "AT_DropColumn") return null;
    return {
      ruleId: "drop-column",
      severity: "caution",
      table,
      summary: `DROP COLUMN "${cmd.name}" is irreversible and breaks old app instances`,
      detail:
        `DROP COLUMN only takes a brief ACCESS EXCLUSIVE lock (it's metadata-only, the bytes ` +
        `are reclaimed later), but it is destructive and instant for any app instance still ` +
        `running the previous release that selects/writes this column -- including an ORM's ` +
        `cached prepared statements or "SELECT *" query mid-deploy.`,
      safeRewrite:
        `-- deploy app code that stops reading/writing "${cmd.name}" FIRST, let it roll out fully,\n` +
        `-- THEN run this DROP COLUMN in a separate migration/deploy.`,
    };
  },

  // AT_AlterColumnType
  (cmd, table) => {
    if (cmd.subtype !== "AT_AlterColumnType") return null;
    return {
      ruleId: "alter-column-type",
      severity: "block",
      table,
      summary: `ALTER COLUMN "${cmd.name}" TYPE ${describeType(cmd.def?.ColumnDef?.typeName)} rewrites the table`,
      detail:
        `Changing a column's type (even to a "compatible" one like varchar(50) -> text in ` +
        `some cases) forces Postgres to rewrite every row of the table under ACCESS EXCLUSIVE ` +
        `unless the specific old-type/new-type pair is one of the handful Postgres recognizes ` +
        `as binary-coercible. Treat every type change as a full rewrite unless proven otherwise.`,
      safeRewrite:
        `-- expand/contract: add a new column of the new type, backfill in batches, swap\n` +
        `-- reads over in application code, then drop the old column in a later migration.`,
    };
  },
];

function findIndexStmtFinding(node: any): Finding | null {
  const stmt = node?.IndexStmt;
  if (!stmt) return null;
  if (stmt.concurrent) return null;
  const table = relname(stmt);
  return {
    ruleId: "create-index-without-concurrently",
    severity: "block",
    table,
    summary: `CREATE INDEX ${stmt.idxname ?? ""} takes a SHARE lock for the whole build`,
    detail:
      `A plain CREATE INDEX holds a SHARE lock on the table for as long as the index build ` +
      `takes, which blocks every INSERT/UPDATE/DELETE against the table (reads still work). ` +
      `On a table with any real write volume, this is the single most common cause of a ` +
      `migration that "ran fine in staging" and froze writes in production.`,
    safeRewrite:
      `CREATE INDEX CONCURRENTLY ${stmt.idxname ?? "idx_name"} ON ${table} (...);\n` +
      `-- CONCURRENTLY can't run inside a transaction block -- run it as its own migration step.`,
  };
}

function findDeleteWithoutWhere(node: any): Finding | null {
  const stmt = node?.DeleteStmt;
  if (!stmt) return null;
  if (stmt.whereClause) return null;
  const table = relname(stmt);
  return {
    ruleId: "delete-without-where",
    severity: "block",
    table,
    summary: `DELETE FROM ${table} has no WHERE clause`,
    detail: `This deletes every row in the table. If this is intentional, TRUNCATE is faster and clearer; if not, this is a data-loss migration.`,
  };
}

function findTruncate(node: any): Finding | null {
  const stmt = node?.TruncateStmt;
  if (!stmt) return null;
  const table = (stmt.relations ?? [])
    .map((r: any) => r?.RangeVar?.relname)
    .filter(Boolean)
    .join(", ");
  return {
    ruleId: "truncate-table",
    severity: "caution",
    table: table || null,
    summary: `TRUNCATE ${table} removes all rows and takes ACCESS EXCLUSIVE`,
    detail: `TRUNCATE is instant but takes ACCESS EXCLUSIVE and is irreversible outside a transaction that hasn't committed yet. Confirm this is intentional for a migration, not leftover test code.`,
  };
}

const TRANSACTION_START_KINDS = new Set(["TRANS_STMT_BEGIN", "TRANS_STMT_START"]);
const TRANSACTION_END_KINDS = new Set(["TRANS_STMT_COMMIT", "TRANS_STMT_ROLLBACK"]);

type ConcurrentOp = { concurrent: boolean; table: string | null; label: string };

/**
 * CONCURRENTLY operations (CREATE/DROP INDEX CONCURRENTLY, REINDEX ...
 * CONCURRENTLY) are a hard Postgres error -- not a lock-duration risk --
 * when they run inside a transaction block. detectConcurrentOp() recognizes
 * every statement kind that carries a `concurrently` flag so the file-level
 * transaction scan below can catch all three, not just CREATE INDEX.
 */
function detectConcurrentOp(node: any): ConcurrentOp | null {
  const indexStmt = node?.IndexStmt;
  if (indexStmt) {
    return {
      concurrent: !!indexStmt.concurrent,
      table: relname(indexStmt),
      label: `CREATE INDEX${indexStmt.idxname ? ` ${indexStmt.idxname}` : ""} CONCURRENTLY`,
    };
  }

  const dropStmt = node?.DropStmt;
  if (dropStmt && dropStmt.removeType === "OBJECT_INDEX") {
    return { concurrent: !!dropStmt.concurrent, table: null, label: "DROP INDEX CONCURRENTLY" };
  }

  const reindexStmt = node?.ReindexStmt;
  if (reindexStmt) {
    const concurrent = (reindexStmt.params ?? []).some(
      (p: any) => p?.DefElem?.defname === "concurrently",
    );
    const table = reindexStmt.kind === "REINDEX_OBJECT_TABLE" ? relname(reindexStmt) : null;
    return { concurrent, table, label: "REINDEX ... CONCURRENTLY" };
  }

  return null;
}

/**
 * Whole-file rule: libpg_query parses `BEGIN`/`COMMIT` as their own
 * TransactionStmt nodes, so applyRules() -- which only ever sees one
 * statement at a time -- can never tell that a CREATE INDEX CONCURRENTLY is
 * sitting inside an explicit BEGIN...COMMIT elsewhere in the same file.
 * That combination isn't a lock-duration risk the live-stats layer can
 * grade: Postgres refuses to run it at all ("CREATE INDEX CONCURRENTLY
 * cannot run inside a transaction block"), aborting the whole transaction
 * and rolling back every earlier statement in it. Verified for real against
 * a local Postgres 14 instance. This pass needs the full, ordered statement
 * list, so it runs once per file instead of once per statement.
 */
export function applyFileLevelRules(
  statements: Array<{ index: number; node: any }>,
): Map<number, Finding[]> {
  const findingsByIndex = new Map<number, Finding[]>();
  const nonTransactionCount = statements.filter((s) => !s.node?.TransactionStmt).length;

  let inExplicitTransaction = false;
  for (const stmt of statements) {
    const txn = stmt.node?.TransactionStmt;
    if (txn) {
      if (TRANSACTION_START_KINDS.has(txn.kind)) inExplicitTransaction = true;
      else if (TRANSACTION_END_KINDS.has(txn.kind)) inExplicitTransaction = false;
      continue;
    }

    const concurrentOp = detectConcurrentOp(stmt.node);
    if (!concurrentOp || !concurrentOp.concurrent) continue;

    const existing = findingsByIndex.get(stmt.index) ?? [];

    if (inExplicitTransaction) {
      existing.push({
        ruleId: "concurrently-inside-transaction-block",
        severity: "block",
        table: concurrentOp.table,
        summary: `${concurrentOp.label} is wrapped in an explicit BEGIN/COMMIT in this file`,
        detail:
          `Postgres refuses to run CONCURRENTLY operations inside a transaction block -- ` +
          `this is not a lock-duration risk the live-stats layer can grade, it is a guaranteed ` +
          `"cannot run inside a transaction block" error that aborts and rolls back every other ` +
          `statement already run in this same BEGIN...COMMIT, including any earlier ALTER TABLE ` +
          `in this same file.`,
        safeRewrite:
          `-- remove the surrounding BEGIN/COMMIT for this statement, or move it to its own\n` +
          `-- migration file that runs outside any transaction wrapper your migration tool adds.`,
      });
    } else if (nonTransactionCount > 1) {
      existing.push({
        ruleId: "concurrently-may-run-inside-framework-transaction",
        severity: "caution",
        table: concurrentOp.table,
        summary: `${concurrentOp.label} shares this file with ${nonTransactionCount - 1} other statement(s)`,
        detail:
          `This file has no explicit BEGIN/COMMIT, but most migration runners (Rails/ActiveRecord, ` +
          `Prisma Migrate, Flyway, node-pg-migrate, Sequelize) wrap an entire multi-statement ` +
          `migration file in one implicit transaction by default. If that happens here, this ` +
          `CONCURRENTLY statement will fail with "cannot run inside a transaction block" even ` +
          `though no BEGIN/COMMIT appears in this file's own text.`,
        safeRewrite:
          `-- confirm your migration tool runs this file outside a transaction (e.g. Rails'\n` +
          `-- disable_ddl_transaction!, Flyway's transactional=false, node-pg-migrate's\n` +
          `-- noTransaction: true), or move this statement to its own standalone migration file.`,
      });
    }

    if (existing.length > 0) findingsByIndex.set(stmt.index, existing);
  }

  return findingsByIndex;
}

export function applyRules(node: any, rawSql: string): Finding[] {
  const findings: Finding[] = [];

  const alterStmt = node?.AlterTableStmt;
  if (alterStmt) {
    const table = relname(alterStmt);
    for (const cmdWrapper of alterStmt.cmds ?? []) {
      const cmd = cmdWrapper?.AlterTableCmd;
      if (!cmd) continue;
      for (const rule of ALTER_TABLE_CMD_RULES) {
        const finding = rule(cmd, table);
        if (finding) findings.push(finding);
      }
    }
  }

  const indexFinding = findIndexStmtFinding(node);
  if (indexFinding) findings.push(indexFinding);

  const deleteFinding = findDeleteWithoutWhere(node);
  if (deleteFinding) findings.push(deleteFinding);

  const truncateFinding = findTruncate(node);
  if (truncateFinding) findings.push(truncateFinding);

  // lock_timeout hygiene: statements that take a strong lock should run
  // behind a lock_timeout so a blocked migration fails fast instead of
  // queuing behind application traffic indefinitely. We can't inspect
  // session-level SET statements reliably per-statement, so this is a
  // whole-file hint handled in cli.ts instead of here.
  void rawSql;

  return findings;
}
