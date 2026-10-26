# SchemaProof

Know what a Postgres migration will actually do to **your** table, right now
— not what it would do to an empty staging copy.

```
npx schemaproof check migration.sql --db "$DATABASE_URL"
```

SchemaProof is a free, open-source (MIT) CLI for Supabase, Neon, and plain
Postgres teams. It parses your migration with the real PostgreSQL parser
(`libpg_query`, the same parser engine `psql` itself links against), classifies
the lock every statement takes, and — this is the part most migration
linters skip — connects to the actual target database and reads its real
`pg_class` / `pg_stat_user_tables` / `pg_locks` state before deciding how
serious that lock really is for *this* table, *right now*.

## Why this exists

Squawk, Atlas's free tier, and most migration linters are static: they parse
your `.sql` file and never touch a database, on purpose, so they're fast in
CI. That's a reasonable tradeoff, but it means `CREATE INDEX ON orders(...)`
gets flagged identically whether `orders` has 12 rows or 12 million, and
whether your database is sitting idle or already has 40 connections queued
behind a lock on that exact table. The handful of newer tools that *do* read
live stats (e.g. a bare `reltuples` estimate) are either Neon-only demo
projects with no linting layer, or keep the live-stats feature behind a
separate command with no AI explanation on top.

SchemaProof combines both halves in one tool, with every rule free forever
(no paywalled tier), and an optional AI layer that turns the rule + live-stat
output into a plain-English explanation and a ready-to-run safe rewrite —
citing your table's actual row count, dead-tuple ratio, and currently-active
blockers, not generic advice.

## What it checks today

Lock-classification rules (work with or without `--db`):

| Rule | What it catches |
|---|---|
| `create-index-without-concurrently` | `CREATE INDEX` without `CONCURRENTLY` — SHARE lock blocks writes for the whole build |
| `set-not-null` | `ALTER COLUMN ... SET NOT NULL` — ACCESS EXCLUSIVE during the verification scan |
| `add-fk-without-not-valid` | `ADD CONSTRAINT ... FOREIGN KEY` without `NOT VALID` — locks both tables during inline validation |
| `add-check-without-not-valid` | `ADD CONSTRAINT ... CHECK` without `NOT VALID` — same inline-validation cost |
| `add-unique-builds-index-inline` | `ADD CONSTRAINT ... UNIQUE` — builds its backing index inline instead of `CONCURRENTLY` |
| `alter-column-type` | `ALTER COLUMN ... TYPE` — full table rewrite under ACCESS EXCLUSIVE |
| `drop-column` | Destructive + breaks any still-running old app instance mid-deploy |
| `add-column-volatile-default` | `ADD COLUMN ... DEFAULT now()` (or any function call) — defeats Postgres's fast-default optimization, forces a rewrite |
| `add-notnull-column-without-default` | Will outright fail against any non-empty table |
| `delete-without-where` / `truncate-table` | Data-loss guardrails |

With `--db <connection-string>`, every lock-sensitive finding above is
re-scored against this database's **real** facts right now: `pg_class`
row-count estimate and on-disk size, `pg_stat_user_tables` dead-tuple ratio
and last autovacuum time, and an active `pg_locks` ⨝ `pg_stat_activity` scan
for backends currently holding or waiting on a lock against that exact
table. A rule that's always "block" in a static linter can come back `info`
here if your table is genuinely tiny today — and escalate to `block` if
something is already queued behind a lock on it at this exact moment.

Set `ANTHROPIC_API_KEY` (optional, same env-gated pattern as this project's
sibling tools) to also get an AI-written explanation that cites those same
real numbers plus a safe-rewrite SQL block. Unset, SchemaProof is still fully
useful — the rule engine's own `detail` + live `liveReasoning` text is real,
filled with that run's actual numbers, never canned.

## Example (real run, not illustrative)

Seeded a local Postgres with a real 150,000-row `orders` table and a 3-row
`tags` table, then ran the same `CREATE INDEX ... (no CONCURRENTLY)` pattern
against both inside one migration file:

```
$ schemaproof check examples/risky-migration.sql --db "$DATABASE_URL"

CREATE INDEX idx_orders_status ON orders (status)
✖ [BLOCK] create-index-without-concurrently
  live: "orders" has an estimated 150,000 rows (15.4 MB) right now -- large
  enough that the lock this statement takes will be held for a duration
  proportional to that, not the few milliseconds a small staging copy shows.

CREATE INDEX idx_tags_label ON tags (label)
i [INFO] create-index-without-concurrently
  live: "tags" has only an estimated 3 rows right now, so this specific lock
  would likely clear in milliseconds today -- the rule is still correct in
  general, re-check this once the table has grown.

Overall verdict: BLOCK
```

Same SQL pattern, same static rule — different real verdict, because the
two tables actually are different risks. With a second terminal holding a
real transaction-level lock on `orders` during the same run, the tool also
picked up `1 active backend(s) ... holding or waiting on a lock against
"orders" at this exact moment` and escalated accordingly — see
`examples/risky-migration.sql` / `examples/safe-migration.sql` to reproduce.

## Install

```
git clone https://github.com/caelum0x/schemaproof
cd schemaproof
npm install
npm run dev -- check path/to/migration.sql --db "$DATABASE_URL"
```

Or once published: `npx schemaproof check migration.sql --db "$DATABASE_URL"`.

## Provider notes

- **Supabase**: detected from `supabase.co`/`supabase.com` host. If your
  connection string uses the pooled port `6543` (transaction-mode pgbouncer),
  SchemaProof warns that multi-statement safe rewrites (`NOT VALID` +
  `VALIDATE CONSTRAINT`, `CREATE INDEX CONCURRENTLY`) need a real session —
  use the direct connection (port `5432`) or session-mode pooler.
- **Neon**: detected from `neon.tech`/`neon.build`. Safe to point directly
  at a branch connection string — a branch is already a disposable
  copy-on-write clone, so there's no separate "test database" step needed.
- **Plain Postgres** (RDS, local, anything else): works the same way,
  provider note is skipped.

## Rehearse: real observed lock-wait time, not an estimate

```
npx schemaproof rehearse migration.sql --db "$DATABASE_URL"
```

`check --db` re-scores static rules against your table's real row count and
current lock state, but it still never actually *runs* the migration.
`rehearse` does: it clones `--db` onto the same Postgres server (needs
`CREATEDB` there — the same local trust a normal `createdb` would need),
restores the real data via `pg_dump`/`pg_restore`, replays a concurrent read
burst against every table the migration touches, then runs each statement
for real and reports how long it actually took to acquire its lock plus how
long a fresh query submitted at the same moment was blocked behind it. The
clone is dropped afterwards (`--keep-clone` to inspect it instead).

Real example, same seeded 200k-row table used above: a plain
`SET NOT NULL` came back at 12ms (cheap, as the static rule-of-thumb would
suggest), but `ADD COLUMN ... DEFAULT md5(random()::text)` — a volatile
default that defeats the fast-default optimization and forces a full
rewrite — measured 586ms, with a concurrent query genuinely blocked for
583ms behind it. That's the actual number your production deploy would
stall for, not a row-count heuristic.

This is the local-clone tier. A Neon-branch tier (apply against a real
copy-on-write branch instead of a same-server clone, so a slow `pg_dump` of
a huge table is never on the critical path) is still on the roadmap — it
needs a real `NEON_API_KEY` to build and verify against.

## CI integration (design, not wired into this repo's own build)

Exit codes are CI-gate-ready: `0` = info/clean, `1` = caution, `2` = block.
A GitHub Actions step for *your* project would look like:

```yaml
- run: npx schemaproof check db/migrations/latest.sql --db "${{ secrets.STAGING_DATABASE_URL }}"
```

This repo intentionally does not ship its own `.github/workflows/` — that's
a deliberate choice for how *this* project is built, not a statement that
the feature is unsupported for your project.

## Roadmap

- Neon-branch tier for `rehearse` (apply to a real disposable copy-on-write
  branch instead of a same-server clone) — needs a real `NEON_API_KEY` to
  build and verify against.
- Supabase/Neon preview-branch GitHub Action that comments the verdict on
  the PR.
- Postgres-version-aware rule tuning (e.g. PG17's `ALTER TABLE ... ADD
  COLUMN` fast-default edge cases).

## License

MIT. See `LICENSE` and `NOTICE.md` for the one OSS dependency this project
is built directly on top of (`libpg-query`, the real Postgres parser).
