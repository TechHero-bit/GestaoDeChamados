-- =====================================================
-- Migration 006: Correlação de conversas de entrada do Outlook
-- =====================================================

-- As colunas são opcionais para manter compatibilidade com tickets legados.
ALTER TABLE tickets
    ADD COLUMN IF NOT EXISTS outlook_conversation_id TEXT,
    ADD COLUMN IF NOT EXISTS outlook_last_message_id TEXT;

-- Conversation Id é a chave de correlação, mas não é UNIQUE:
-- tickets existentes podem ter sido criados antes desta regra.
CREATE INDEX IF NOT EXISTS idx_tickets_outlook_conversation_id
    ON tickets (outlook_conversation_id);