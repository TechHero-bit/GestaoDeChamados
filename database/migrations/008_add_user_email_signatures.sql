-- =====================================================
-- Migration 008: Assinatura de e-mail por usuário
-- Help Desk — Gestão de Chamados
--
-- Execute manualmente no Supabase depois de revisar o ambiente.
-- =====================================================

ALTER TABLE users
    ADD COLUMN signature_enabled BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN signature_storage_path TEXT;
