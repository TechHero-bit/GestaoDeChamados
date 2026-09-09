import { z } from "zod";

const VALID_STATUSES = ["Aberto", "Em Andamento", "Resolvido"];
const VALID_PRIORITIES = ["Baixa", "Normal", "Alta"];

export const ticketIdSchema = z
  .string()
  .uuid("Identificador do chamado inválido.");

export const listTicketsQuerySchema = z.object({
  status: z.enum(VALID_STATUSES).optional(),
  search: z
    .string()
    .trim()
    .max(200, "A busca excede o tamanho máximo.")
    .optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida.")
    .refine((value) => {
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return (
        !Number.isNaN(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === value
      );
    }, "Data inválida.")
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
});

/**
 * Schema para atualização de ticket.
 * Campos desconhecidos continuam sendo descartados pelo Zod e, portanto,
 * não chegam ao service como campos atualizáveis.
 */
export const updateTicketSchema = z.object({
  status: z
    .enum(VALID_STATUSES, {
      errorMap: () => ({
        message: `Status deve ser: ${VALID_STATUSES.join(", ")}`,
      }),
    })
    .optional(),
  prioridade: z
    .enum(VALID_PRIORITIES, {
      errorMap: () => ({
        message: `Prioridade deve ser: ${VALID_PRIORITIES.join(", ")}`,
      }),
    })
    .optional(),
}).refine(
  (dados) => dados.status !== undefined || dados.prioridade !== undefined,
  {
    message: "Informe ao menos um campo para atualizar.",
  },
);

/**
 * Schema para resposta a um ticket.
 */
export const replyTicketSchema = z
  .object({
    mensagem: z
      .string({ required_error: "mensagem é obrigatória." })
      .trim()
      .min(1, "A mensagem não pode ser vazia.")
      .max(10000, "A mensagem excede o tamanho máximo."),
  })
  .strict();

const replyAttachmentSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    contentType: z.string().trim().min(1).max(200),
  })
  .strict();

export const createReplyDraftSchema = z
  .object({
    mensagem: z.string().trim().min(1).max(10000),
    attachments: z.array(replyAttachmentSchema).min(1).max(20),
  })
  .strict();

export const replyDraftActionSchema = z
  .object({
    handle: z.string().min(100).max(4096),
    index: z.number().int().min(0).max(19),
    mensagem: z.string().trim().min(1).max(10000),
    attachments: z.array(replyAttachmentSchema).min(1).max(20),
  })
  .strict();

export const sendReplyDraftSchema = z
  .object({
    handle: z.string().min(100).max(4096),
    mensagem: z.string().trim().min(1).max(10000),
    attachments: z.array(replyAttachmentSchema).min(1).max(20),
  })
  .strict();

export const cancelReplyDraftSchema = z
  .object({ handle: z.string().min(100).max(4096) })
  .strict();
