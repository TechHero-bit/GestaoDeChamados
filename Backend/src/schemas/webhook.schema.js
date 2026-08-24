import { z } from "zod";

/**
 * Schema de validação do payload do Power Automate (webhook Outlook).
 */
export const webhookPayloadSchema = z.object({
  message_id: z
    .string({ required_error: "message_id é obrigatório." })
    .trim()
    .min(1, "message_id não pode ser vazio."),

  remetente_email: z
    .string({ required_error: "remetente_email é obrigatório." })
    .trim()
    .toLowerCase()
    .email("remetente_email deve ser um e-mail válido."),

  remetente_nome: z
    .string()
    .trim()
    .min(1, "remetente_nome não pode ser vazio.")
    .optional(),

  assunto: z
    .string({ required_error: "assunto é obrigatório." })
    .trim()
    .min(1, "assunto não pode ser vazio.")
    .refine((val) => val.toLowerCase().includes("(chamado)"), {
      message: 'O assunto deve conter "(chamado)".',
    }),

  corpo_mensagem: z
    .string({ required_error: "corpo_mensagem é obrigatório." })
    .trim()
    .min(1, "corpo_mensagem não pode ser vazio."),

  data_recebimento: z
    .string({ required_error: "data_recebimento é obrigatório." })
    .datetime({
      message: "data_recebimento deve ser uma data ISO 8601 válida.",
    }),
});
