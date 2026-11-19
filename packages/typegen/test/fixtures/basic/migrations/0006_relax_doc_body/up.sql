/* Schema version 6: a required column becomes nullable (SPEC §2.4). */
ALTER TABLE docs ALTER COLUMN body DROP NOT NULL;
