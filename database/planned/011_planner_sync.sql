-- RASCUNHO PARA REVISÃO. Não aplicar nesta etapa.
-- Fora de migrations/ para não ser incluído na sequência de implantação atual.
-- Requer schema real validado e migrations 001–010.
BEGIN;

CREATE TABLE planner_ticket_links (
    ticket_id UUID PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
    planner_task_id TEXT NOT NULL UNIQUE,
    planner_plan_id TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT false,
    last_synced_status ticket_status,
    last_sync_origin TEXT CHECK (last_sync_origin IN ('portal', 'planner')),
    last_synced_at TIMESTAMPTZ,
    last_portal_version TIMESTAMPTZ,
    last_planner_etag TEXT,
    last_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX planner_ticket_links_plan_idx ON planner_ticket_links(planner_plan_id);

-- Outbox: na etapa 2 o evento deve ser inserido na MESMA transação do status.
CREATE TABLE planner_sync_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL REFERENCES planner_ticket_links(ticket_id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL UNIQUE,
    origin TEXT NOT NULL CHECK (origin IN ('portal', 'planner')),
    status ticket_status NOT NULL,
    source_version TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'processing', 'succeeded', 'conflict', 'failed', 'superseded')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_until TIMESTAMPTZ,
    last_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);
CREATE INDEX planner_sync_events_pending_idx ON planner_sync_events(state, next_attempt_at);

CREATE TABLE planner_sync_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID REFERENCES planner_sync_events(id) ON DELETE SET NULL,
    ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL,
    origin TEXT NOT NULL CHECK (origin IN ('portal', 'planner')),
    outcome TEXT NOT NULL,
    safe_error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Nenhum acesso direto do frontend. Credenciais de integração ficam no servidor.
ALTER TABLE planner_ticket_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE planner_sync_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE planner_sync_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON planner_ticket_links, planner_sync_events, planner_sync_logs FROM anon, authenticated;
CREATE POLICY planner_links_service ON planner_ticket_links FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY planner_events_service ON planner_sync_events FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY planner_logs_service ON planner_sync_logs FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
