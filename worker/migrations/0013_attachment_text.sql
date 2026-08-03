-- T1 attachment inline text. Binaries stay at City Record; this extends the
-- T0 notice_attachments rows with extracted plain text only (no images/OCR).
ALTER TABLE notice_attachments ADD COLUMN text_status TEXT;
ALTER TABLE notice_attachments ADD COLUMN text_reason TEXT;
ALTER TABLE notice_attachments ADD COLUMN text_method TEXT;
ALTER TABLE notice_attachments ADD COLUMN text_chars INTEGER;
ALTER TABLE notice_attachments ADD COLUMN text_preview TEXT;
ALTER TABLE notice_attachments ADD COLUMN extracted_text TEXT;
ALTER TABLE notice_attachments ADD COLUMN text_extracted_at TEXT;
