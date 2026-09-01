import { z } from "zod";

export const microsoftTestEmailSchema = z
  .object({
    destinatario: z
      .string({ required_error: "destinatario é obrigatório." })
      .trim()
      .email("destinatario deve ser um e-mail válido.")
      .max(254, "destinatario excede o tamanho máximo."),
    assunto: z
      .string({ required_error: "assunto é obrigatório." })
      .trim()
      .min(1, "O assunto não pode ser vazio.")
      .max(320, "O assunto excede o tamanho máximo."),
    mensagem: z
      .string({ required_error: "mensagem é obrigatória." })
      .trim()
      .min(1, "A mensagem não pode ser vazia.")
      .max(10000, "A mensagem excede o tamanho máximo."),
  })
  .strict();

