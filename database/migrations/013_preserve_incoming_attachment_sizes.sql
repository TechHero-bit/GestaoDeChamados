-- =====================================================
-- Migration 013: tamanhos de origem dos anexos recebidos
--
-- Revisar e executar manualmente antes de publicar o backend correspondente.
-- Não execute em produção sem autorização.
-- =====================================================

ALTER TABLE ticket_message_attachments
    ADD COLUMN outlook_declared_size BIGINT,
    ADD COLUMN source_content_size BIGINT;

-- Em linhas ainda não disponíveis, file_size mantém o valor originalmente
-- declarado pelo Outlook. Em linhas já concluídas ele contém o tamanho real e
-- não é possível reconstruir o valor declarado antigo com segurança.
UPDATE ticket_message_attachments
SET outlook_declared_size = file_size
WHERE processing_status <> 'Disponivel'
  AND outlook_declared_size IS NULL;

ALTER TABLE ticket_message_attachments
    ADD CONSTRAINT ticket_message_attachments_outlook_declared_size_check
        CHECK (outlook_declared_size IS NULL OR outlook_declared_size >= 0),
    ADD CONSTRAINT ticket_message_attachments_source_content_size_check
        CHECK (source_content_size IS NULL OR source_content_size > 0);

COMMENT ON COLUMN ticket_message_attachments.outlook_declared_size IS
    'Tamanho de transporte informado pela propriedade size do Outlook/Graph.';

COMMENT ON COLUMN ticket_message_attachments.source_content_size IS
    'Tamanho dos bytes efetivamente decodificados de contentBytes pelo Power Automate.';
