-- =====================================================
-- Migration 007: Conexões Microsoft por usuário e estados OAuth
-- Help Desk — Gestão de Chamados
-- =====================================================

CREATE TABLE user_microsoft_connections (
    id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                    UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    microsoft_user_id          TEXT NOT NULL,
    email                      TEXT NOT NULL,
    display_name               TEXT,
    access_token_encrypted     TEXT NOT NULL,
    refresh_token_encrypted    TEXT NOT NULL,
    access_token_expires_at    TIMESTAMPTZ NOT NULL,
    scopes                     TEXT[] NOT NULL DEFAULT '{}',
    connected_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at                 TIMESTAMPTZ
);

CREATE INDEX idx_user_microsoft_connections_microsoft_user_id
    ON user_microsoft_connections (microsoft_user_id);
CREATE INDEX idx_user_microsoft_connections_revoked_at
    ON user_microsoft_connections (revoked_at);

CREATE OR REPLACE FUNCTION atualizar_updated_at_microsoft()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_atualizar_updated_at_microsoft ON user_microsoft_connections;
CREATE TRIGGER trigger_atualizar_updated_at_microsoft
    BEFORE UPDATE ON user_microsoft_connections
    FOR EACH ROW
    EXECUTE FUNCTION atualizar_updated_at_microsoft();

ALTER TABLE user_microsoft_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on user_microsoft_connections"
    ON user_microsoft_connections
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- O valor original do state nunca é armazenado no banco.
CREATE TABLE microsoft_oauth_states (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state_hash  TEXT NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_microsoft_oauth_states_user_id ON microsoft_oauth_states (user_id);
CREATE INDEX idx_microsoft_oauth_states_expires_at ON microsoft_oauth_states (expires_at);

ALTER TABLE microsoft_oauth_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on microsoft_oauth_states"
    ON microsoft_oauth_states
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
