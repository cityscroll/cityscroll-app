-- Preserve PASSPort's complete action values in the materialized contract table.
ALTER TABLE passport_contracts ADD COLUMN encumbered_amount REAL;
