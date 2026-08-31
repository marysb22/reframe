-- Splits the single continuous payments record per student into one
-- independent fee agreement per training year (1-4), so each year has its
-- own total fee, discount, plan, due date, ledger, and explicit
-- active/completed lifecycle -- payments no longer bleed across years.
-- The schedule (amounts, dates, number of payments) is expected to differ
-- year to year, so nothing here assumes a fixed monthly amount; the
-- "monthly breakdown" the UI shows is just the existing ledger grouped by
-- the month of payment_transactions.payment_date.

ALTER TABLE payments
  ADD COLUMN training_year TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER student_id,
  ADD COLUMN period_status VARCHAR(20) NOT NULL DEFAULT 'active' AFTER status;

ALTER TABLE payments
  ADD CONSTRAINT chk_payments_training_year CHECK (training_year BETWEEN 1 AND 4),
  ADD CONSTRAINT chk_payments_period_status CHECK (period_status IN ('active', 'completed'));

-- Every existing row was "the" fee agreement for that student -- it becomes
-- their Year 1 record for free via the DEFAULT 1 above, no data movement
-- needed. Replace the old one-row-per-student constraint with one-row-per-
-- student-per-year.
-- Add the new index before dropping the old one -- MySQL needs some index
-- covering student_id at all times to back fk_payments_student.
ALTER TABLE payments ADD CONSTRAINT uq_payments_student_year UNIQUE (student_id, training_year);
ALTER TABLE payments DROP INDEX student_id;

-- Ties each ledger entry to a specific year's fee agreement (not just the
-- student), so a year's transactions are found by payment_id instead of
-- reasoning about transaction dates -- important since a year's real-world
-- payment dates aren't assumed to fall inside any particular calendar
-- window relative to the other years.
ALTER TABLE payment_transactions ADD COLUMN payment_id BIGINT NULL AFTER student_id;

UPDATE payment_transactions pt
JOIN payments p ON p.student_id = pt.student_id
SET pt.payment_id = p.id
WHERE pt.payment_id IS NULL;

ALTER TABLE payment_transactions MODIFY COLUMN payment_id BIGINT NOT NULL;
ALTER TABLE payment_transactions
  ADD CONSTRAINT fk_paytx_payment FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE;

CREATE INDEX idx_paytx_payment ON payment_transactions(payment_id);
