-- Tax-lien progression input: volume, publication range, and stage/cycle coverage.
SELECT COUNT(*) AS row_count,
       MIN(month) AS min_publication,
       MAX(month) AS max_publication,
       COUNT(DISTINCT month) AS publication_count,
       COUNT(DISTINCT CASE WHEN lower(cycle) LIKE '90 day%notice' THEN month END) AS cycle_count,
       COUNT(*) FILTER (WHERE lower(cycle) LIKE '90 day%notice') AS notice_90_count,
       COUNT(*) FILTER (WHERE lower(cycle) LIKE '60 day%notice') AS notice_60_count,
       COUNT(*) FILTER (WHERE lower(cycle) LIKE '30 day%notice') AS notice_30_count,
       COUNT(*) FILTER (WHERE lower(cycle) LIKE '10 day%notice') AS notice_10_count,
       COUNT(*) FILTER (WHERE lower(cycle) = 'final sale') AS final_sale_count
FROM dof_tax_lien_sale_lists;
