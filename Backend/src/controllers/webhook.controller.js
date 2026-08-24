import { webhookPayloadSchema } from "../schemas/webhook.schema.js";
import * as ticketService from "../services/ticket.service.js";

/**
 * POST /api/webhooks/outlook
 * Recebe e-mail do Power Automate e cria ticket.
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

    // 2. Verificar duplicidade pelo message_id
    const existente = await ticketService.buscarPorMessageId(dados.message_id);

    if (existente) {
      return res.status(200).json({
        success: true,
        duplicate: true,
        message: "E-mail já processado.",
        ticket_id: existente.id,
      });
    }

    // 3. Criar ticket + mensagem de entrada
    const ticket = await ticketService.criar({
      ...dados,
      payload_original: req.body,
    });

    if (ticket.duplicate) {
      return res.status(200).json({
        success: true,
        duplicate: true,
        message: "E-mail já processado.",
        ticket_id: ticket.id,
      });
    }

    // 4. Retornar sucesso
    return res.status(201).json({
      success: true,
      duplicate: false,
      message: "Chamado criado com sucesso.",
      ticket_id: ticket.id,
    });
  } catch (error) {
    next(error);
  }
}
