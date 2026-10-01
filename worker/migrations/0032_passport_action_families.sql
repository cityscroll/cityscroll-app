-- encumbered_amount belongs on passport_contracts.
-- Fresh databases receive it from 0007_passport_public.sql.
-- Production already carries the column because worker/src/passport.mjs
-- ensurePassportSchemaOnce creates the table with the column and repairs
-- older materializations with ALTER TABLE … ADD COLUMN, catching duplicate
-- column errors. SQLite has no ADD COLUMN IF NOT EXISTS, so a bare ALTER here
-- fails on production while succeeding on a fresh database. Keep this file as
-- a recorded no-op so wrangler can advance d1_migrations on both shapes.
SELECT 1;
