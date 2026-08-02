-- Registers parquet tables into the DuckDB catalog.
-- Paths are substituted by warehouse/scripts/register.py ({{PARQUET_GLOB}}, {{TABLE}}).

CREATE OR REPLACE VIEW {{TABLE}} AS
SELECT * FROM read_parquet('{{PARQUET_GLOB}}');
