-- =====================================================
-- Migration 009: Anexos recebidos em mensagens de tickets
--
-- Execute manualmente no SQL Editor do Supabase depois das
-- migrations anteriores. O bucket é privado por padrão.
-- =====================================================

CREATE TYPE ticket_message_attachment_status AS ENUM (
    'Pendente',
    'Disponivel',
    'Falhou'
);

CREATE TABLE ticket_message_attachments (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_message_id     UUID NOT NULL REFERENCES ticket_messages(id) ON DELETE CASCADE,
    outlook_attachment_id TEXT NOT NULL,
    file_name             TEXT NOT NULL,
    content_type          TEXT NOT NULL DEFAULT 'application/octet-stream',
    file_size             BIGINT NOT NULL CHECK (file_size >= 0),
    storage_path          TEXT NOT NULL,
    is_inline             BOOLEAN NOT NULL DEFAULT false,
    content_id            TEXT,
    processing_status     ticket_message_attachment_status NOT NULL DEFAULT 'Pendente',
    processing_error      TEXT,
    available_at          TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    data_atualizacao      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ticket_message_attachments_message_outlook_attachment_key
        UNIQUE (ticket_message_id, outlook_attachment_id)
);

CREATE INDEX idx_ticket_message_attachments_message_id
    ON ticket_message_attachments (ticket_message_id);

CREATE INDEX idx_ticket_message_attachments_status
    ON ticket_message_attachments (processing_status);

CREATE TRIGGER trigger_atualizar_ticket_message_attachments
    BEFORE UPDATE ON ticket_message_attachments
    FOR EACH ROW
    EXECUTE FUNCTION atualizar_data_atualizacao();

ALTER TABLE ticket_message_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on ticket_message_attachments"
    ON ticket_message_attachments
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Bucket exclusivo para anexos de chamados. Não é o bucket Assinaturas.
INSERT INTO storage.buckets (id, name, public)
VALUES ('AnexosChamados', 'AnexosChamados', false)
ON CONFLICT (id) DO NOTHING;

-- Não há policy para anon/authenticated: acessos externos usam somente URLs
-- temporárias geradas pelo backend com a service role.
CREATE POLICY "Service role full access on AnexosChamados"
    ON storage.objects
    FOR ALL
    TO service_role
    USING (bucket_id = 'AnexosChamados')
    WITH CHECK (bucket_id = 'AnexosChamados');
