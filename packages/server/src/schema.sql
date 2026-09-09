-- Applied at boot, idempotently. v1 keeps PNG bytes in Postgres (see db.ts for why).

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  label       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  repo        TEXT,
  branch      TEXT,
  sha         TEXT,
  device      JSONB       NOT NULL,
  app         JSONB       NOT NULL,
  update_url  TEXT,
  "index"     JSONB       NOT NULL
);

CREATE INDEX IF NOT EXISTS runs_repo_branch_created_at_idx
  ON runs (repo, branch, created_at DESC);

-- owner_id is a run id for captured screens and a compare id for generated diff masks.
CREATE TABLE IF NOT EXISTS files (
  owner_id  TEXT  NOT NULL,
  name      TEXT  NOT NULL,
  bytes     BYTEA NOT NULL,
  PRIMARY KEY (owner_id, name)
);

CREATE TABLE IF NOT EXISTS compares (
  id           TEXT PRIMARY KEY,
  baseline_id  TEXT        NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  candidate_id TEXT        NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  threshold    DOUBLE PRECISION NOT NULL,
  report       JSONB       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The cache key for GET /compare: one report per (baseline, candidate, threshold).
CREATE UNIQUE INDEX IF NOT EXISTS compares_inputs_idx
  ON compares (baseline_id, candidate_id, threshold);

-- One row per UTC day; the daily judge spend ceiling counts against it.
CREATE TABLE IF NOT EXISTS judge_calls (
  day    DATE   PRIMARY KEY,
  calls  BIGINT NOT NULL DEFAULT 0
);
