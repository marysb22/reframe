-- Replaces the Library's ISBN/OCLC identifier with a single DOI (Digital
-- Object Identifier) field, used going forward by Add Book/Edit Book/Book
-- Details/Search/Online Search across Admin, Master Trainer, and ToT.
--
-- Purely additive, same idiom as migrations 025/029: a new nullable column,
-- no default, no backfill. The existing `isbn`/`oclc_number` columns (added
-- by migration 025) are intentionally NOT dropped and NOT touched -- any
-- real value already stored in them (on production; this dev DB currently
-- has zero rows in `learning_materials` with material_type='book') stays
-- exactly as-is. The application layer simply stops reading/writing those
-- two columns from this point on; they are dead weight kept only so no
-- existing book record or foreign key is ever altered or lost. Nothing
-- disables FOREIGN_KEY_CHECKS and no row is deleted.
--
-- DOI is never inferred/guessed from an existing isbn/oclc_number value --
-- every existing book simply starts with doi = NULL until someone who
-- knows its real DOI (if it has one at all -- not every book does) edits it
-- in, or a Trainee/Admin/Supervisor adds a new book with one.

ALTER TABLE learning_materials ADD COLUMN doi VARCHAR(255) NULL AFTER country;
