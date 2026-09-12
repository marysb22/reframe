-- Closes two duplicate-record gaps in learning_materials found during the
-- Materials-system hardening audit (see backend/src/routes/supervisor.js's
-- POST /materials and backend/src/routes/library.js's POST /books):
--
-- 1. Materials (documents/videos/images/etc, and links) had ZERO duplicate
--    protection of any kind -- a double-click or a retried request created
--    a brand new row every time. Fix: a client-supplied idempotency key,
--    unique at the database level, so the SAME logical submit attempt can
--    never produce two rows no matter how many times its request is sent.
--    Nullable + UNIQUE (MySQL allows any number of NULLs in a UNIQUE index)
--    so every pre-existing row -- which never had a key -- is completely
--    unaffected; only new inserts going forward populate it.
--
-- 2. Library books already had application-level SHA-256 duplicate
--    detection (file_hash, added in migration 021), but as a plain
--    check-then-insert with no DB-level guarantee, two near-simultaneous
--    uploads of the same file could both pass the check before either
--    committed (a classic TOCTOU race). A real UNIQUE constraint on
--    file_hash isn't correct for the *whole* table, though -- non-book
--    Materials legitimately share identical file content (the same
--    handout shared with two different trainees is not a duplicate). A
--    generated column that only carries a value for book rows lets the
--    uniqueness be enforced by MySQL itself, exactly where it belongs,
--    without constraining anything else. Verified locally that MySQL
--    accepts this generated column + unique index combination, that
--    non-book rows sharing a hash still insert freely, and that a second
--    book row with the same hash is rejected by the database itself.
--
-- Both changes are purely additive: two new nullable/generated columns and
-- two new indexes. No existing column is altered, no existing row is
-- touched, no data is deleted or rewritten.

ALTER TABLE learning_materials
  ADD COLUMN idempotency_key VARCHAR(64) NULL,
  ADD UNIQUE INDEX uniq_materials_idempotency_key (idempotency_key);

ALTER TABLE learning_materials
  ADD COLUMN book_hash_key VARCHAR(64)
    GENERATED ALWAYS AS (CASE WHEN material_type = 'book' THEN file_hash ELSE NULL END) VIRTUAL,
  ADD UNIQUE INDEX uniq_materials_book_hash (book_hash_key);

-- Same idempotency-key protection, same reasoning, for the separate
-- Documents feature (its own table, not learning_materials) -- both of
-- its "Share Document" endpoints (routes/supervisor.js's
-- POST /students/:studentId/documents and routes/profile.js's
-- POST /documents) had zero duplicate protection before this change.
ALTER TABLE documents
  ADD COLUMN idempotency_key VARCHAR(64) NULL,
  ADD UNIQUE INDEX uniq_documents_idempotency_key (idempotency_key);
