-- Adds the second emergency-contact phone number field the Trainee "My
-- Profile" page's Health & Emergency section already had UI for but the
-- table never supported. Purely additive -- student_health_info currently
-- has no load/save route wired to it at all (this migration lands together
-- with the routes that finally wire it up), so there is no existing data
-- that could be affected either way.

ALTER TABLE student_health_info ADD COLUMN emergency_contact_phone_2 VARCHAR(50) NULL;
