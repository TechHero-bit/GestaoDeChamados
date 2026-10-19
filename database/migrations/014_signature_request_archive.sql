-- Migration 014: arquivamento auditável de solicitações corporativas.
-- Revisar e aplicar manualmente; nunca remove solicitações nem artefatos.

ALTER TABLE signature_requests
    ADD COLUMN archived_at TIMESTAMPTZ,
    ADD COLUMN archived_by UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN archive_reason TEXT;

ALTER TABLE signature_requests
    ADD CONSTRAINT signature_requests_archive_metadata_check
    CHECK (
        (archived_at IS NULL AND archived_by IS NULL AND archive_reason IS NULL)
        OR
        (archived_at IS NOT NULL AND archive_reason IS NOT NULL AND length(trim(archive_reason)) >= 5)
    );

CREATE INDEX idx_signature_requests_active_corporate_email
    ON signature_requests (lower(corporate_email))
    WHERE corporate_email IS NOT NULL AND archived_at IS NULL;

CREATE INDEX idx_signature_requests_archived_created
    ON signature_requests (archived_at DESC, created_at DESC)
    WHERE archived_at IS NOT NULL;
