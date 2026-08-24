-- =====================================================
-- Migration 004: Criação da tabela user_sessions
-- Help Desk — Gestão de Chamados
-- =====================================================

-- Tabela de sessões para controle server-side e inatividade
CREATE TABLE user_sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    jti                 TEXT NOT NULL UNIQUE,
    last_activity_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL,
    revoked_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índices para otimização de verificação de sessão e revogação
CREATE INDEX idx_user_sessions_user_id ON user_sessions (user_id);
CREATE INDEX idx_user_sessions_jti ON user_sessions (jti);
CREATE INDEX idx_user_sessions_last_activity ON user_sessions (last_activity_at);
CREATE INDEX idx_user_sessions_expires_at ON user_sessions (expires_at);
CREATE INDEX idx_user_sessions_revoked_at ON user_sessions (revoked_at);

-- Row Level Security
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;

-- Policy para service_role (backend) acessar tudo
CREATE POLICY "Service role full access on user_sessions"
    ON user_sessions
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
