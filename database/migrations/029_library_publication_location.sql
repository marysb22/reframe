-- Adds Publication Location (the city/place a book was published --
-- distinct from Publisher, the publishing house, and from Country, the
-- nation) to the Library. Migration 025 already added country/isbn/
-- oclc_number to this same table; this is the one genuinely missing field
-- from that set, not a duplicate of any of them.
--
-- Purely additive: nullable column, no default, no backfill -- no existing
-- book has ever had this value captured, so there is nothing real to
-- migrate. Left NULL rather than guessed for every existing row, exactly
-- like country/isbn/oclc_number were when migration 025 added them.

ALTER TABLE learning_materials ADD COLUMN publication_location VARCHAR(255) NULL AFTER publisher;
