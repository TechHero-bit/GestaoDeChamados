import { webhookPayloadSchema } from "../schemas/webhook.schema.js";
import * as ticketService from "../services/ticket.service.js";

/**
 * POST /api/webhooks/outlook
 * Recebe e-mail do Power Automate e cria ou anexa ao ticket da conversa.
 */
export async function receberEmailOutlook(req, res, next) {
  try {
    // 1. Validar payload com Zod
    const resultado = webhookPayloadSchema.safeParse(req.body);

    if (!resultado.success) {
      return res.status(400).json({
        success: false,
        message: "Payload inválido.",
        errors: resultado.error.errors.map((e) => ({
          campo: e.path.join("."),
          mensagem: e.message,
        })),
      });
    }

    const dados = resultado.data;

    // 2. Idempotência por message_id e, depois, correlação por conversation_id
    const resultadoEntrada = await ticketService.processarEntrada({
      ...dados,
      payload_original: req.body,
    });

    if (resultadoEntrada.duplicate) {
      return res.status(200).json({
        success: true,
        duplicate: true,
        message: "E-mail já processado.",
        ticket_id: resultadoEntrada.ticket.id,
      });
    }

    // 3. Uma resposta da conversa cria somente uma mensagem no ticket existente
    return res.status(201).json({
      success: true,
      duplicate: false,
      message: resultadoEntrada.threaded
        ? "Mensagem adicionada ao chamado com sucesso."
        : "Chamado criado com sucesso.",
      ticket_id: resultadoEntrada.ticket.id,
    });
  } catch (error) {
    next(error);
  }
}