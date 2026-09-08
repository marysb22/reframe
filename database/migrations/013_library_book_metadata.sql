-- Adds the richer metadata fields a real knowledge library needs. Purely
-- additive -- every existing Library ('book') row and every existing
-- ordinary Material row is completely unaffected.
--
-- resource_type is the new user-facing "Type" dropdown (Book/Article/
-- Research Paper/.../Other). Deliberately a DIFFERENT column from the
-- pre-existing material_type (which is what already distinguishes a
-- Library row from an ordinary Material) -- these are two independent
-- classifications, never to be confused with each other in code.

ALTER TABLE learning_materials ADD COLUMN publisher VARCHAR(255) NULL;
ALTER TABLE learning_materials ADD COLUMN publication_year SMALLINT NULL;
ALTER TABLE learning_materials ADD COLUMN resource_type VARCHAR(30) NULL;

-- Backfill: every existing Library row is conceptually a "book" already --
-- without this, existing books would show a blank Type after this ships.
UPDATE learning_materials SET resource_type = 'book' WHERE material_type = 'book' AND resource_type IS NULL;

ALTER TABLE learning_materials ADD CONSTRAINT chk_resource_type CHECK (
  resource_type IS NULL OR resource_type IN (
    'book', 'article', 'research_paper', 'academic_paper', 'thesis',
    'ebook', 'reference', 'guide', 'report', 'other'
  )
);

ALTER TABLE learning_materials ADD CONSTRAINT chk_publication_year CHECK (
  publication_year IS NULL OR publication_year BETWEEN 1000 AND 2100
);

-- The Library's main listing (WHERE material_type='book' ORDER BY
-- created_at) had no supporting index -- fine at today's volume, not
-- fine assumed at hundreds of rows. Purely additive, zero behavior change.
ALTER TABLE learning_materials ADD INDEX idx_materials_type_created (material_type, created_at);

-- NOTE: constraint/index names above confirmed by direct application to
-- the LOCAL DEV DB only. Auto-generated/explicit constraint names and
-- their exact accepted DROP syntax have differed between this dev DB and
-- production multiple times already this session (documented in migrations
-- 009-012) -- always confirm via SHOW CREATE TABLE / information_schema on
-- the actual target DB before running any DROP/ALTER against production.
