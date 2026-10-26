-- A real migration file with several classic footguns, meant to be run
-- against a real seeded Postgres database with `schemaproof check`.

-- 1. Non-concurrent index on a 150k-row table: takes a SHARE lock for the
--    whole build, blocking writes.
CREATE INDEX idx_orders_status ON orders (status);

-- 2. SET NOT NULL forces a full-table verification scan under ACCESS
--    EXCLUSIVE.
ALTER TABLE orders ALTER COLUMN amount SET NOT NULL;

-- 3. Adding a FOREIGN KEY without NOT VALID scans + locks both tables.
ALTER TABLE orders ADD CONSTRAINT fk_orders_customer
  FOREIGN KEY (customer_id) REFERENCES customers (id);

-- 4. DROP COLUMN on a column still read by the previous app release.
ALTER TABLE orders DROP COLUMN legacy_col;

-- 5. Same CREATE INDEX pattern against a tiny 3-row table -- the rule still
--    fires (it's always technically true) but live stats should show this
--    one is not actually dangerous today.
CREATE INDEX idx_tags_label ON tags (label);
