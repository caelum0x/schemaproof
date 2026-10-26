-- Same intent as risky-migration.sql, written the safe way.
CREATE INDEX CONCURRENTLY idx_orders_status_safe ON orders (status);

ALTER TABLE orders ADD CONSTRAINT fk_orders_customer_safe
  FOREIGN KEY (customer_id) REFERENCES customers (id) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT fk_orders_customer_safe;
