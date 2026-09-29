import { z } from "zod";

const MAX_INCOMING_ATTACHMENTS = 25;
const MAX_INCOMING_ATTACHMENT_BYTES = 5 * 1024 * 1024 * 1024;

const attachmentSchema = z
  .object({
    // Identificador estável devolvido por Get attachment (V2): a chave de
    // idempotência do arquivo dentro de uma mensagem do Outlook.
    attachment_id: z
      .string({ required_error: "attachment_id é obrigatório." })
      .trim()
      .min(1, "attachment_id não pode ser vazio.")
      .max(1024, "attachment_id é muito longo."),
    file_name: z
      .string({ required_error: "file_name é obrigatório." })
      .trim()
      .min(1, "file_name não pode ser vazio.")
      .max(255, "file_name é muito longo."),
    content_type: z
      .string()
      .trim()
      .max(255, "content_type é muito longo.")
      .optional()
      .default("application/octet-stream"),
    file_size: z
      .number({ required_error: "file_size é obrigatório." })
      .int("file_size deve ser um número inteiro.")
      .min(0, "file_size não pode ser negativo.")
      .max(
        MAX_INCOMING_ATTACHMENT_BYTES,
        "file_size excede o limite suportado.",
      ),
    is_inline: z.boolean().optional().default(false),
    content_id: z.string().trim().min(1).max(512).nullable().optional(),
  })
  .strict();

const attachmentActionSchema = z
  .object({
    message_id: z
      .string({ required_error: "message_id é obrigatório." })
      .trim()
      .min(1, "message_id não pode ser vazio.")
      .max(2048, "message_id é muito longo."),
    attachment_id: z
      .string({ required_error: "attachment_id é obrigatório." })
      .trim()
      .min(1, "attachment_id não pode ser vazio.")
      .max(1024, "attachment_id é muito longo."),
  })
  .strict();

/**
 * Schema do payload inicial do Power Automate. O JSON contém somente
 * metadados; os bytes seguem direto para o Supabase Storage por uma
 * autorização temporária devolvida nesta mesma chamada.
 */
export const webhookPayloadSchema = z.object({
  message_id: z
    .string({ required_error: "message_id é obrigatório." })
    .trim()
    .min(1, "message_id não pode ser vazio.")
    .max(2048, "message_id é muito longo."),

  conversation_id: z
    .string({ required_error: "conversation_id é obrigatório." })
    .trim()
    .min(1, "conversation_id não pode ser vazio.")
    .max(2048, "conversation_id é muito longo."),

  remetente_email: z
    .string({ required_error: "remetente_email é obrigatório." })
    .trim()
    .toLowerCase()
    .email("remetente_email deve ser um e-mail válido."),

  remetente_nome: z
    .string()
    .trim()
    .min(1, "remetente_nome não pode ser vazio.")
    .max(255, "remetente_nome é muito longo.")
    .optional(),

  assunto: z
    .string({ required_error: "assunto é obrigatório." })
    .trim()
    .min(1, "assunto não pode ser vazio.")
    .max(1000, "assunto é muito longo.")
    .refine(
      (val) => {
        const lower = val.toLowerCase();
        return (
          lower.includes("(chamado)") ||
          lower.includes("centauro / interno: chamado -")
        );
      },
      {
        message:
          'O assunto deve conter "(chamado)" ou "Centauro / Interno: Chamado -".',
      },
    ),

  corpo_mensagem: z
    .string({ required_error: "corpo_mensagem é obrigatório." })
    .trim()
    .min(1, "corpo_mensagem não pode ser vazio."),

  data_recebimento: z
    .string({ required_error: "data_recebimento é obrigatório." })
    .datetime({
      message: "data_recebimento deve ser uma data ISO 8601 válida.",
    }),

  attachments: z
    .array(attachmentSchema)
    .max(MAX_INCOMING_ATTACHMENTS)
    .optional()
    .default([]),
});

export const completeIncomingAttachmentSchema = attachmentActionSchema;

export const failIncomingAttachmentSchema = attachmentActionSchema.extend({
  failure_code: z
    .enum(["UPLOAD_FAILED", "SOURCE_UNAVAILABLE", "CONTENT_UNAVAILABLE"])
    .default("UPLOAD_FAILED"),
});
