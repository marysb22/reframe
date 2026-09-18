-- Lets a Supervisor (Master Trainer or ToT) upload their own CV from My
-- Profile, exactly like a Trainee already can. Same storage convention as
-- students.cv_file: a single filename in backend/uploads/cv/, validated as
-- a real PDF by checkFileContent before it's ever written here.
--
-- Purely additive: nullable column, no default, no backfill -- no
-- Supervisor has ever had a CV file before this column existed.

ALTER TABLE supervisors ADD COLUMN cv_file VARCHAR(255) NULL AFTER photo;
