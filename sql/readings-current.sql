BEGIN;

ALTER TABLE readings ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT false;

-- Keep existing history and mark the latest row by the same ordering the panel used.
WITH latest AS (
    SELECT DISTINCT ON (container_id) id, container_id
    FROM readings
    ORDER BY container_id, id DESC
)
UPDATE readings AS reading
SET is_current = true
FROM latest
WHERE reading.id = latest.id
  AND NOT EXISTS (
      SELECT 1 FROM readings AS current_reading
      WHERE current_reading.container_id = latest.container_id AND current_reading.is_current
  );

CREATE UNIQUE INDEX IF NOT EXISTS readings_one_current_per_container
    ON readings (container_id) WHERE is_current;

COMMIT;
