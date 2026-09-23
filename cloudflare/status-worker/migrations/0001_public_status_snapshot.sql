-- This table intentionally has one row and stores only the de-identified
-- payload consumed by the public website. It must never receive Discord IDs,
-- message text, raw errors, credentials, or request headers.
CREATE TABLE IF NOT EXISTS public_status_snapshot (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
