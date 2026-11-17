-- Sealed apply (SPEC §5.11): encrypted columns read nullable, writes keep NOT NULL.
CREATE TABLE patients (
  id TEXT PRIMARY KEY,
  clinic_id TEXT NOT NULL,
  given_names TEXT NOT NULL,
  notes TEXT,
  ward TEXT NOT NULL
);

CREATE INDEX idx_patients_clinic ON patients (clinic_id, id);
