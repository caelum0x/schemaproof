# Provenance / third-party notices

SchemaProof is a fresh implementation (not a fork of a single upstream repo),
built directly on top of one real OSS dependency for SQL parsing, because
hand-rolling a PostgreSQL SQL parser would be re-inventing a solved, safety-
critical problem:

- **[`libpg-query`](https://github.com/pganalyze/libpg_query)** (the Postgres
  parser compiled out of the server, via the
  [`libpg-query` npm bindings](https://github.com/pganalyze/libpg_query)) --
  MIT (npm bindings) / BSD-3-Clause (underlying C library). SchemaProof's
  `src/parser.ts` and `src/rules.ts` walk the real AST this library returns;
  no SQL regexes are used to detect risky patterns.

No code was copied from Squawk, strong_migrations, Atlas, pgroll,
MigrationPilot, pg-lockguard or any other existing migration linter --
SchemaProof's rule set targets the same well-known, publicly documented
PostgreSQL locking behaviors (ACCESS EXCLUSIVE on SET NOT NULL, SHARE lock on
non-concurrent CREATE INDEX, inline validation on ADD CONSTRAINT, full-table
rewrite on ALTER COLUMN TYPE, etc.) that those projects also document, but the
rule implementations, the live-database-stats layer, and the AI-explanation
layer are original work for this project.

SchemaProof itself is MIT-licensed (see `LICENSE`).
