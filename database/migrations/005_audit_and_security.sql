-- =====================================================
-- Migration 005: Auditoria e rastreamento de autoria
-- Help Desk — Gestão de Chamados
-- =====================================================

-- Adiciona a coluna created_by na tabela de mensagens de tickets
ALTER TABLE ticket_messages
    ADD COLUMN created_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Índice para busca de mensagens por atendente/administrador
CREATE INDEX idx_ticket_messages_created_by ON ticket_messages (created_by);
