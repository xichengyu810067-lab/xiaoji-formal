-- Counters of the website's AI support (src/support.mjs): one row per day and one per hashed visitor and hour.
-- They hold counts only, never a question, an answer or an address: the visitor part of a bucket is a SHA-256 of
-- the day and the address, so it cannot be followed from one day to the next.
CREATE TABLE IF NOT EXISTS support_usage (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
