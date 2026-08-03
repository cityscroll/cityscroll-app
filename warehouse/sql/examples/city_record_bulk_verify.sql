-- WH-07 City Record bulk snapshot: size, historical range, and prediction inputs.
SELECT COUNT(*) AS row_count,
       MIN(start_date) AS min_start_date,
       MAX(start_date) AS max_start_date,
       COUNT(*) FILTER (WHERE section_name = 'Agency Rules') AS agency_rules_count,
       COUNT(*) FILTER (WHERE section_name = 'Property Disposition') AS property_disposition_count
FROM city_record;
