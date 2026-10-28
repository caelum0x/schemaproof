-- Regression repro for the add-column-volatile-default rule.
--
-- The first three statements use STABLE expressions (now(), CURRENT_DATE,
-- CURRENT_TIMESTAMP). Verified live against a seeded Postgres 14 instance
-- (200k-row table): pg_relation_filenode() is unchanged and
-- pg_attribute.atthasmissing is true after each of these -- the same
-- fast-default path (no table rewrite) as a literal constant. These must
-- report INFO / no findings.
ALTER TABLE orders ADD COLUMN created_at timestamptz DEFAULT now();
ALTER TABLE orders ADD COLUMN signup_date date DEFAULT CURRENT_DATE;
ALTER TABLE orders ADD COLUMN updated_at timestamptz DEFAULT CURRENT_TIMESTAMP;

-- gen_random_uuid() is genuinely VOLATILE (pg_proc.provolatile = 'v').
-- Verified live: this one DOES change the relfilenode and give every
-- existing row a distinct value -- a real rewrite. Must report BLOCK.
ALTER TABLE orders ADD COLUMN token uuid DEFAULT gen_random_uuid();
