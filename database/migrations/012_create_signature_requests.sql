-- =====================================================
-- Migration 012: Solicitações de assinaturas corporativas
--
-- Revisar e executar manualmente no SQL Editor do Supabase.
-- Esta migration não altera a configuração de assinatura dos usuários
-- administradores criada pela migration 008.
-- =====================================================

CREATE TYPE corporate_signature_status AS ENUM (
    'Pendente',
    'Revisão necessária',
    'Gerada'
);

CREATE TABLE signature_requests (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_ticket_id          UUID REFERENCES tickets(id) ON DELETE SET NULL,
    source_ticket_message_id  UUID REFERENCES ticket_messages(id) ON DELETE SET NULL,
    source_outlook_message_id TEXT NOT NULL UNIQUE,
    source_conversation_id    TEXT NOT NULL,
    source_sender_email       TEXT NOT NULL,
    source_subject            TEXT NOT NULL,
    employee_name             TEXT,
    job_title                 TEXT,
    phone                     TEXT,
    corporate_email           TEXT,
    status                    corporate_signature_status NOT NULL DEFAULT 'Revisão necessária',
    extraction_warnings       JSONB NOT NULL DEFAULT '[]'::jsonb,
    email_conflict            BOOLEAN NOT NULL DEFAULT false,
    photo_selection_required  BOOLEAN NOT NULL DEFAULT true,
    photo_confidence          NUMERIC(4,3),
    photo_attachment_id       UUID REFERENCES ticket_message_attachments(id) ON DELETE SET NULL,
    photo_storage_path        TEXT,
    generated_at              TIMESTAMPTZ,
    generated_by              UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    data_atualizacao          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT signature_requests_email_format CHECK (
        corporate_email IS NULL OR
        corporate_email ~ '^[a-z0-9][a-z0-9._-]*@centaurotelecom\.com\.br$'
    ),
    CONSTRAINT signature_requests_photo_source CHECK (
        photo_attachment_id IS NULL OR photo_storage_path IS NULL
    )
);

CREATE INDEX idx_signature_requests_corporate_email
    ON signature_requests (lower(corporate_email))
    WHERE corporate_email IS NOT NULL;

CREATE INDEX idx_signature_requests_status_created
    ON signature_requests (status, created_at DESC);

CREATE TABLE signature_request_images (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signature_request_id  UUID NOT NULL REFERENCES signature_requests(id) ON DELETE CASCADE,
    attachment_id         UUID NOT NULL REFERENCES ticket_message_attachments(id) ON DELETE CASCADE,
    position_index        INTEGER NOT NULL CHECK (position_index >= 0),
    score                 INTEGER NOT NULL,
    confidence            NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    classification        TEXT NOT NULL CHECK (classification IN ('provavel_foto', 'incerta', 'assinatura_remetente')),
    reasons               JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT signature_request_images_request_attachment_key
        UNIQUE (signature_request_id, attachment_id)
);

CREATE INDEX idx_signature_request_images_request
    ON signature_request_images (signature_request_id, score DESC);

CREATE TABLE signature_artifacts (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    signature_request_id  UUID NOT NULL REFERENCES signature_requests(id) ON DELETE CASCADE,
    storage_path          TEXT NOT NULL UNIQUE,
    file_name             TEXT NOT NULL,
    content_type          TEXT NOT NULL DEFAULT 'image/png',
    file_size             INTEGER NOT NULL CHECK (file_size > 0),
    snapshot              JSONB NOT NULL,
    created_by            UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_signature_artifacts_request_created
    ON signature_artifacts (signature_request_id, created_at DESC);

CREATE TRIGGER trigger_atualizar_signature_requests
    BEFORE UPDATE ON signature_requests
    FOR EACH ROW
    EXECUTE FUNCTION atualizar_data_atualizacao();

ALTER TABLE signature_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE signature_request_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE signature_artifacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on signature_requests"
    ON signature_requests FOR ALL TO service_role
    USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on signature_request_images"
    ON signature_request_images FOR ALL TO service_role
    USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on signature_artifacts"
    ON signature_artifacts FOR ALL TO service_role
    USING (true) WITH CHECK (true);

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'AssinaturasColaboradores',
    'AssinaturasColaboradores',
    false,
    5242880,
    ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Service role full access on AssinaturasColaboradores"
    ON storage.objects FOR ALL TO service_role
    USING (bucket_id = 'AssinaturasColaboradores')
    WITH CHECK (bucket_id = 'AssinaturasColaboradores');
