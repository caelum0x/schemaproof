// Splits a .sql migration file into individual statements using the real
// PostgreSQL parser (libpg_query, via the libpg-query npm bindings), not a
// regex or a hand-rolled SQL tokenizer. This is the same parser class Squawk,
// Atlas and MigrationPilot use -- we lean on it for the same reason they do:
// a regex-based splitter silently mis-parses dollar-quoted bodies, comments
// containing semicolons, and string literals containing ";".
import pgQuery from "libpg-query";

export type ParsedStatement = {
  index: number;
  rawSql: string;
  node: any;
};

export async function parseMigration(sql: string): Promise<ParsedStatement[]> {
  const result: any = await pgQuery.parse(sql);
  const stmts: any[] = result.stmts ?? [];

  return stmts.map((entry, index) => {
    const start: number = entry.stmt_location ?? 0;
    const len: number | undefined = entry.stmt_len;
    const end = len !== undefined ? start + len : sql.length;
    const rawSql = sql.slice(start, end).trim();
    return { index, rawSql, node: entry.stmt };
  });
}
