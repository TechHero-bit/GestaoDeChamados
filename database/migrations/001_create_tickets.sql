-- =====================================================
-- Migration 001: Criação da tabela tickets
-- Help Desk — Gestão de Chamados
-- =====================================================

-- Enum de status do ticket
CREATE TYPE ticket_status AS ENUM ('Aberto', 'Em Andamento', 'Resolvido');

-- Tabela principal de tickets
CREATE TABLE tickets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    remetente_email     TEXT NOT NULL,
    remetente_nome      TEXT,
    assunto             TEXT NOT NULL,
    corpo_mensagem      TEXT NOT NULL,
    status              ticket_status NOT NULL DEFAULT 'Aberto',
    outlook_message_id  TEXT UNIQUE,
    data_recebimento    TIMESTAMPTZ,
    data_criacao        TIMESTAMPTZ NOT NULL DEFAULT now(),
    data_atualizacao    TIMESTAMPTZ NOT NULL DEFAULT now(),
    payload_original    JSONB
);

-- Função para atualizar data_atualizacao automaticamente
CREATE OR REPLACE FUNCTION atualizar_data_atualizacao()
RETURNS TRIGGER AS $$
BEGIN
    NEW.data_atualizacao = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger para auto-update de data_atualizacao
CREATE TRIGGER trigger_atualizar_data_atualizacao
    BEFORE UPDATE ON tickets
    FOR EACH ROW
    EXECUTE FUNCTION atualizar_data_atualizacao();

-- Índices para consultas frequentes
CREATE INDEX idx_tickets_status ON tickets (status);
CREATE INDEX idx_tickets_data_criacao ON tickets (data_criacao DESC);
CREATE INDEX idx_tickets_remetente_email ON tickets (remetente_email);
CREATE INDEX idx_tickets_outlook_message_id ON tickets (outlook_message_id);

-- Row Level Security
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;

-- Policy para service_role (backend) acessar tudo
CREATE POLICY "Service role full access on tickets"
    ON tickets
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
