CREATE TABLE IF NOT EXISTS system_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  committed_revision bigint NOT NULL DEFAULT 0 CHECK (committed_revision >= 0)
);
INSERT INTO system_state (singleton, committed_revision)
VALUES (true, 0)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS seasons (
  season_id text PRIMARY KEY CHECK (season_id ~ '^[a-z][a-z0-9-]{0,63}$'),
  generation integer NOT NULL CHECK (generation > 0),
  state text NOT NULL CHECK (state IN ('open', 'frozen', 'closed')),
  created_revision bigint NOT NULL CHECK (created_revision > 0),
  freeze_revision bigint CHECK (freeze_revision > 0),
  close_revision bigint CHECK (close_revision > 0),
  current_publication_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_assignments (
  season_id text PRIMARY KEY REFERENCES seasons(season_id) ON DELETE CASCADE,
  worker_id text NOT NULL CHECK (worker_id ~ '^[a-z][a-z0-9-]{0,63}$'),
  generation integer NOT NULL CHECK (generation > 0),
  updated_revision bigint NOT NULL CHECK (updated_revision > 0),
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS mutation_requests (
  request_key text PRIMARY KEY CHECK (request_key ~ '^[a-z][a-z0-9-]{0,63}$'),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
  operation text NOT NULL,
  http_status integer NOT NULL CHECK (http_status BETWEEN 200 AND 299),
  result_revision bigint CHECK (result_revision > 0),
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS score_events (
  event_id text PRIMARY KEY CHECK (event_id ~ '^[a-z][a-z0-9-]{0,63}$'),
  request_key text NOT NULL REFERENCES mutation_requests(request_key),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
  season_id text NOT NULL REFERENCES seasons(season_id),
  season_generation integer NOT NULL CHECK (season_generation > 0),
  player_id text NOT NULL CHECK (player_id ~ '^[a-z][a-z0-9-]{0,63}$'),
  score bigint NOT NULL CHECK (score BETWEEN 0 AND 1000000000),
  committed_revision bigint NOT NULL UNIQUE CHECK (committed_revision > 0),
  best_changed boolean NOT NULL,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS score_events_season_revision_idx
  ON score_events (season_id, committed_revision);
CREATE UNIQUE INDEX IF NOT EXISTS score_events_request_key_idx
  ON score_events (request_key);

CREATE TABLE IF NOT EXISTS player_bests (
  season_id text NOT NULL REFERENCES seasons(season_id),
  player_id text NOT NULL CHECK (player_id ~ '^[a-z][a-z0-9-]{0,63}$'),
  best_score bigint NOT NULL CHECK (best_score BETWEEN 0 AND 1000000000),
  first_achieved_revision bigint NOT NULL CHECK (first_achieved_revision > 0),
  winning_event_id text NOT NULL REFERENCES score_events(event_id),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (season_id, player_id)
);
CREATE INDEX IF NOT EXISTS player_bests_order_idx
  ON player_bests (season_id, best_score DESC, first_achieved_revision ASC, player_id ASC);

CREATE TABLE IF NOT EXISTS publications (
  publication_id text PRIMARY KEY CHECK (publication_id ~ '^[a-z][a-z0-9-]{0,63}$'),
  request_key text NOT NULL UNIQUE CHECK (request_key ~ '^[a-z][a-z0-9-]{0,63}$'),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
  season_id text NOT NULL REFERENCES seasons(season_id),
  season_generation integer NOT NULL CHECK (season_generation > 0),
  worker_id text NOT NULL CHECK (worker_id ~ '^[a-z][a-z0-9-]{0,63}$'),
  worker_generation integer NOT NULL CHECK (worker_generation > 0),
  source_revision bigint NOT NULL CHECK (source_revision >= 0),
  item_count integer NOT NULL CHECK (item_count BETWEEN 0 AND 256),
  ordered_digest text NOT NULL CHECK (ordered_digest ~ '^[0-9a-f]{64}$'),
  items_json jsonb NOT NULL CHECK (jsonb_typeof(items_json) = 'array'),
  state text NOT NULL CHECK (state IN ('prepared', 'published')),
  retained boolean NOT NULL DEFAULT true,
  rebuilding boolean NOT NULL DEFAULT false,
  rebuild_request_key text,
  gc_request_key text,
  projection_deleted_at timestamptz,
  result_json jsonb,
  created_at timestamptz NOT NULL,
  published_at timestamptz,
  CHECK ((state = 'prepared' AND published_at IS NULL) OR
         (state = 'published' AND published_at IS NOT NULL AND result_json IS NOT NULL)),
  CONSTRAINT publications_item_count_matches_json
    CHECK (jsonb_array_length(items_json) = item_count)
);
CREATE INDEX IF NOT EXISTS publications_season_created_idx
  ON publications (season_id, created_at, publication_id);
ALTER TABLE publications ADD COLUMN IF NOT EXISTS retained boolean NOT NULL DEFAULT true;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'publications_item_count_matches_json'
  ) THEN
    ALTER TABLE publications ADD CONSTRAINT publications_item_count_matches_json
      CHECK (jsonb_array_length(items_json) = item_count);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS query_requests (
  request_key text PRIMARY KEY CHECK (request_key ~ '^[a-z][a-z0-9-]{0,63}$'),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
  season_id text NOT NULL REFERENCES seasons(season_id),
  publication_id text NOT NULL REFERENCES publications(publication_id),
  shape_json jsonb NOT NULL,
  result_json jsonb,
  created_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS gc_runs (
  request_key text PRIMARY KEY CHECK (request_key ~ '^[a-z][a-z0-9-]{0,63}$'),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
  season_id text NOT NULL REFERENCES seasons(season_id),
  worker_id text NOT NULL,
  worker_generation integer NOT NULL CHECK (worker_generation > 0),
  candidate_ids jsonb NOT NULL CHECK (jsonb_typeof(candidate_ids) = 'array'),
  state text NOT NULL CHECK (state IN ('prepared', 'completed')),
  result_json jsonb,
  created_at timestamptz NOT NULL,
  completed_at timestamptz
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'seasons_current_publication_fk'
  ) THEN
    ALTER TABLE seasons ADD CONSTRAINT seasons_current_publication_fk
      FOREIGN KEY (current_publication_id) REFERENCES publications(publication_id);
  END IF;
END $$;
