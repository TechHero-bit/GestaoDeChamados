-- Execute manualmente no Supabase após a migration 009.
-- Chamados existentes permanecem sem responsável.
ALTER TABLE tickets
    ADD COLUMN responsavel_id UUID
    CONSTRAINT tickets_responsavel_id_fkey REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX idx_tickets_responsavel_id ON tickets (responsavel_id);
