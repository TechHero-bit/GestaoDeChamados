-- =====================================================
-- Migration 003: Criação da tabela users
-- Help Desk — Gestão de Chamados
-- =====================================================

-- Enum de perfil de acesso do usuário
CREATE TYPE user_role AS ENUM ('ADMIN', 'AGENT');

-- Tabela de usuários
CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome                TEXT NOT NULL,
    email               TEXT NOT NULL UNIQUE,
    password_hash       TEXT NOT NULL,
    role                user_role NOT NULL DEFAULT 'AGENT',
    ativo               BOOLEAN NOT NULL DEFAULT true,
    ultimo_login        TIMESTAMPTZ,
    data_criacao        TIMESTAMPTZ NOT NULL DEFAULT now(),
    data_atualizacao    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trigger para auto-update de data_atualizacao
CREATE TRIGGER trigger_atualizar_data_atualizacao_users
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION atualizar_data_atualizacao();

-- Índices para otimização de consultas e autenticação
CREATE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_role ON users (role);
CREATE INDEX idx_users_ativo ON users (ativo);

-- Row Level Security
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Policy para service_role (backend) acessar tudo
CREATE POLICY "Service role full access on users"
    ON users
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
