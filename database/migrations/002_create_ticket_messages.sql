-- =====================================================
-- Migration 002: Criação da tabela ticket_messages
-- Help Desk — Gestão de Chamados
-- =====================================================

-- Enum de direção da mensagem
CREATE TYPE ticket_message_direction AS ENUM ('Entrada', 'Saida');

-- Tabela de mensagens (timeline de conversa)
CREATE TABLE ticket_messages (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id           UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    direcao             ticket_message_direction NOT NULL,
    remetente_email     TEXT NOT NULL,
    destinatario_email  TEXT NOT NULL,
    corpo_mensagem      TEXT NOT NULL,
    outlook_message_id  TEXT,
    data_criacao        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índices para consultas frequentes
CREATE INDEX idx_ticket_messages_ticket_id ON ticket_messages (ticket_id);
CREATE INDEX idx_ticket_messages_data_criacao ON ticket_messages (data_criacao);

-- Row Level Security
ALTER TABLE ticket_messages ENABLE ROW LEVEL SECURITY;

-- Policy para service_role (backend) acessar tudo
CREATE POLICY "Service role full access on ticket_messages"
    ON ticket_messages
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
