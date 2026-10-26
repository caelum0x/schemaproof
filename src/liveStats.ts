import { Client } from "pg";
import type { LiveTableStats } from "./types.js";

/**
 * Pulls real facts about one table from the database's own catalog and
 * stats views -- not a static heuristic, not a hardcoded threshold. These
 * are the exact views a human DBA would check by hand before running a
 * risky ALTER TABLE: pg_class for size/row estimate, pg_stat_user_tables
 * for autovacuum health, and pg_locks joined to pg_stat_activity for who
 * is holding or waiting on a lock against this table right now.
 */
export async function getLiveTableStats(
  client: Client,
  table: string,
): Promise<LiveTableStats> {
  const versionRes = await client.query("SHOW server_version_num");
  const pgVersionNum = Number(versionRes.rows[0]?.server_version_num ?? 0);

  const classRes = await client.query(
    `SELECT c.reltuples::bigint AS reltuples,
            pg_total_relation_size(c.oid) AS total_size
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = $1
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      LIMIT 1`,
    [table],
  );

  if (classRes.rowCount === 0) {
    return {
      table,
      exists: false,
      approxRowCount: 0,
      totalSizeBytes: 0,
      deadTuples: 0,
      deadTupleRatio: 0,
      lastAutovacuum: null,
      lastAutoanalyze: null,
      activeBlockingBackends: 0,
      pgVersionNum,
    };
  }

  const approxRowCount = Number(classRes.rows[0].reltuples ?? 0);
  const totalSizeBytes = Number(classRes.rows[0].total_size ?? 0);

  const statRes = await client.query(
    `SELECT n_dead_tup, last_autovacuum, last_autoanalyze
       FROM pg_stat_user_tables
      WHERE relname = $1
      LIMIT 1`,
    [table],
  );

  const deadTuples = Number(statRes.rows[0]?.n_dead_tup ?? 0);
  const deadTupleRatio =
    approxRowCount > 0 ? deadTuples / (approxRowCount + deadTuples) : 0;

  const lockRes = await client.query(
    `SELECT count(*)::int AS active_blockers
       FROM pg_locks l
       JOIN pg_class c ON c.oid = l.relation
       JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE c.relname = $1
        AND a.pid <> pg_backend_pid()
        AND a.state != 'idle'
        AND l.mode IN (
          'RowExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock',
          'ExclusiveLock', 'AccessExclusiveLock'
        )`,
    [table],
  );

  const activeBlockingBackends = Number(
    lockRes.rows[0]?.active_blockers ?? 0,
  );

  return {
    table,
    exists: true,
    approxRowCount,
    totalSizeBytes,
    deadTuples,
    deadTupleRatio,
    lastAutovacuum: statRes.rows[0]?.last_autovacuum ?? null,
    lastAutoanalyze: statRes.rows[0]?.last_autoanalyze ?? null,
    activeBlockingBackends,
    pgVersionNum,
  };
}
