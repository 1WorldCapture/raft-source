-- 0014_delivery: M5 delivery worker slice
-- (docs/m5-delivery-worker-contract.md). Additive only: no row is inserted,
-- no 0001-0013 statement is rewritten.
--
-- Table ownership (who WRITES it):
--   delivery (this module) : agent_deliveries, agent_delivery_attempts,
--                            agent_delivery_claims
--   message  (worker B)    : message_agent_mentions
--   channel  (worker B)    : agent_direct_messages
--   agent    (worker C)    : agent_launches
--
-- Conventions follow 0001: INTEGER unix-millisecond timestamps, TEXT UUIDs.

-- Composite parent keys required by the new composite foreign keys below.
-- id is the primary key of both parents, so these are always satisfiable.
CREATE UNIQUE INDEX idx_agents_id_workspace ON agents(id, workspace_id);
CREATE UNIQUE INDEX idx_machines_id_workspace ON machines(id, workspace_id);

-- 1. Typed agent mentions (new table; the human message_mentions of 0010 is
--    untouched and keeps its user_id semantics).
CREATE TABLE message_agent_mentions (
    message_id     TEXT NOT NULL,
    workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id       TEXT NOT NULL,
    handle_at_send TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    PRIMARY KEY (message_id, agent_id),
    FOREIGN KEY (message_id, workspace_id)
        REFERENCES messages(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id, workspace_id)
        REFERENCES agents(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX idx_message_agent_mentions_agent
    ON message_agent_mentions(workspace_id, agent_id, message_id);

-- 2. Logical delivery intents, one per (source, agent). scheduling_state is
--    the scheduling axis; receipt evidence lives on the attempt rows.
CREATE TABLE agent_deliveries (
    id               TEXT PRIMARY KEY,
    delivery_order   INTEGER NOT NULL UNIQUE
                     CHECK (typeof(delivery_order)='integer' AND delivery_order > 0
                            AND delivery_order <= 9007199254740991),
    workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id         TEXT NOT NULL,
    source_kind      TEXT NOT NULL CHECK (source_kind IN ('message','briefing')),
    source_id        TEXT NOT NULL CHECK (source_id <> ''),
    message_id       TEXT,
    conversation_id  TEXT,
    scheduling_state TEXT NOT NULL DEFAULT 'pending'
                     CHECK (scheduling_state IN ('pending','waiting_machine',
                            'waiting_identity','leased','acknowledged','blocked',
                            'cancelled')),
    retry_count      INTEGER NOT NULL DEFAULT 0
                     CHECK (typeof(retry_count)='integer' AND retry_count >= 0
                            AND retry_count <= 9007199254740991),
    next_attempt_at  INTEGER NOT NULL DEFAULT 0
                     CHECK (typeof(next_attempt_at)='integer' AND next_attempt_at >= 0),
    lease_expires_at INTEGER,
    last_error_code  TEXT,
    acknowledged_at  INTEGER,
    revision         INTEGER NOT NULL DEFAULT 1
                     CHECK (typeof(revision)='integer' AND revision > 0
                            AND revision <= 9007199254740991),
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    UNIQUE (workspace_id, source_kind, source_id, agent_id),
    FOREIGN KEY (agent_id, workspace_id) REFERENCES agents(id, workspace_id),
    FOREIGN KEY (message_id, workspace_id)
        REFERENCES messages(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id, workspace_id)
        REFERENCES channels(id, workspace_id),
    CHECK ((source_kind = 'message' AND message_id IS NOT NULL
            AND source_id = message_id AND conversation_id IS NOT NULL)
           OR (source_kind <> 'message' AND message_id IS NULL)),
    CHECK (scheduling_state <> 'leased' OR lease_expires_at IS NOT NULL)
);
CREATE INDEX idx_agent_deliveries_due
    ON agent_deliveries(next_attempt_at, delivery_order)
    WHERE scheduling_state IN ('pending','waiting_machine','waiting_identity');
CREATE INDEX idx_agent_deliveries_lease_expired
    ON agent_deliveries(lease_expires_at)
    WHERE scheduling_state = 'leased';
CREATE INDEX idx_agent_deliveries_agent_order
    ON agent_deliveries(workspace_id, agent_id, delivery_order);
CREATE INDEX idx_agent_deliveries_agent_state
    ON agent_deliveries(workspace_id, agent_id, scheduling_state);

-- 3. Claim batches for the external runner claim/ack path. The claim token is
--    the original ack batch shape {seqs, message_ids}; only its SHA-256
--    digest is persisted. A client-declared batch matching no digest of an
--    outstanding claim changes nothing.
CREATE TABLE agent_delivery_claims (
    id               TEXT PRIMARY KEY,
    workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id         TEXT NOT NULL,
    claim_digest     TEXT NOT NULL CHECK (length(claim_digest) = 64),
    event_count      INTEGER NOT NULL CHECK (typeof(event_count)='integer' AND event_count >= 0),
    removed_count    INTEGER,
    lease_expires_at INTEGER NOT NULL,
    acked_at         INTEGER,
    created_at       INTEGER NOT NULL,
    UNIQUE (workspace_id, agent_id, claim_digest),
    FOREIGN KEY (agent_id, workspace_id) REFERENCES agents(id, workspace_id)
);
CREATE INDEX idx_agent_delivery_claims_open
    ON agent_delivery_claims(workspace_id, agent_id, lease_expires_at)
    WHERE acked_at IS NULL;

-- 4. Protocol occurrences. The identity snapshot columns are IMMUTABLE after
--    insert (store-enforced: they appear in no UPDATE statement).
CREATE TABLE agent_delivery_attempts (
    occurrence_id       TEXT PRIMARY KEY,
    delivery_id         TEXT NOT NULL
                        REFERENCES agent_deliveries(id) ON DELETE CASCADE,
    attempt_number      INTEGER NOT NULL
                        CHECK (typeof(attempt_number)='integer' AND attempt_number > 0),
    workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id            TEXT NOT NULL,
    message_id          TEXT,
    machine_id_snapshot TEXT,
    launch_id_snapshot  TEXT,
    session_id_snapshot TEXT,
    transport_kind      TEXT NOT NULL
                        CHECK (transport_kind IN ('managed_wire','external_claim')),
    claim_id            TEXT REFERENCES agent_delivery_claims(id),
    lease_expires_at    INTEGER,
    retry_count         INTEGER NOT NULL DEFAULT 0
                        CHECK (typeof(retry_count)='integer' AND retry_count >= 0),
    dispatched_at       INTEGER,
    received_at         INTEGER,
    pending_at          INTEGER,
    drained_reported_at INTEGER,
    acked_at            INTEGER,
    state               TEXT NOT NULL CHECK (state IN ('in_flight','terminal')),
    terminal_code       TEXT CHECK (terminal_code IS NULL OR terminal_code IN
                        ('IDENTITY_UNKNOWN','IDENTITY_DRIFT','QUOTA_LIMITED',
                         'DELIVERY_REJECTED','UNSUPPORTED_DELIVERY_PATH',
                         'INSTRUMENT_FAILED','ACKED','RETRY_EXHAUSTED',
                         'SUPERSEDED','CANCELLED','SEND_FAILED','LEASE_EXPIRED')),
    revision            INTEGER NOT NULL DEFAULT 1
                        CHECK (typeof(revision)='integer' AND revision > 0),
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    UNIQUE (delivery_id, attempt_number),
    FOREIGN KEY (agent_id, workspace_id) REFERENCES agents(id, workspace_id),
    CHECK ((state = 'terminal') = (terminal_code IS NOT NULL)),
    CHECK (terminal_code <> 'ACKED' OR acked_at IS NOT NULL),
    -- managed wire carries the full identity snapshot from creation on
    CHECK (transport_kind <> 'managed_wire'
           OR (machine_id_snapshot IS NOT NULL AND launch_id_snapshot IS NOT NULL
               AND session_id_snapshot IS NOT NULL AND claim_id IS NULL)),
    -- external claim binds the claim lease, never a fabricated machine
    CHECK (transport_kind <> 'external_claim'
           OR (claim_id IS NOT NULL AND machine_id_snapshot IS NULL
               AND launch_id_snapshot IS NULL AND session_id_snapshot IS NULL))
);
CREATE INDEX idx_agent_delivery_attempts_delivery
    ON agent_delivery_attempts(delivery_id, attempt_number);
CREATE INDEX idx_agent_delivery_attempts_agent_open
    ON agent_delivery_attempts(workspace_id, agent_id)
    WHERE state = 'in_flight';
CREATE INDEX idx_agent_delivery_attempts_agent
    ON agent_delivery_attempts(workspace_id, agent_id, created_at);

-- 5. Persistent launch/start-dispatch facts (agent/lifecycle worker C owns
--    the writes). Delivery only reads them for dispatch identity resolution.
CREATE TABLE agent_launches (
    id                 TEXT PRIMARY KEY,
    start_dispatch_id  TEXT NOT NULL,
    workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id           TEXT NOT NULL,
    machine_id         TEXT NOT NULL,
    state              TEXT NOT NULL CHECK (state IN ('reserved','dispatched',
                          'acked','superseded','failed','cancelled')),
    queue_state        TEXT CHECK (queue_state IS NULL
                          OR queue_state IN ('queued','starting','running','rebound')),
    dispatch_count     INTEGER NOT NULL DEFAULT 0
                       CHECK (typeof(dispatch_count)='integer' AND dispatch_count >= 0),
    last_dispatch_at   INTEGER,
    acked_at           INTEGER,
    terminal_code      TEXT,
    revision           INTEGER NOT NULL DEFAULT 1
                       CHECK (typeof(revision)='integer' AND revision > 0),
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    UNIQUE (workspace_id, agent_id, start_dispatch_id),
    FOREIGN KEY (agent_id, workspace_id) REFERENCES agents(id, workspace_id),
    FOREIGN KEY (machine_id, workspace_id) REFERENCES machines(id, workspace_id)
);
CREATE INDEX idx_agent_launches_current
    ON agent_launches(workspace_id, agent_id, created_at);
CREATE INDEX idx_agent_launches_open
    ON agent_launches(workspace_id, agent_id)
    WHERE state IN ('reserved','dispatched');

-- 6. Human-agent canonical DM mapping (channel/messaging worker B owns the
--    writes). The human direct_messages table is NOT touched: agent UUIDs
--    never enter its user columns.
CREATE TABLE agent_direct_messages (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id     TEXT NOT NULL,
    channel_id   TEXT NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id, agent_id),
    FOREIGN KEY (agent_id, workspace_id)
        REFERENCES agents(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (channel_id, workspace_id)
        REFERENCES channels(id, workspace_id) ON DELETE CASCADE,
    CHECK (user_id <> agent_id)
);
CREATE INDEX idx_agent_direct_messages_agent
    ON agent_direct_messages(workspace_id, agent_id);
CREATE INDEX idx_agent_direct_messages_user ON agent_direct_messages(user_id);
