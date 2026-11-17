-- A sealed row reads NULL in given_names; the aliased marker names its key.
SELECT p.id, p.given_names, p.ward, p._sync_sealed_key AS sealed_key
FROM patients AS p
WHERE p.clinic_id = :clinicId
ORDER BY p.id
