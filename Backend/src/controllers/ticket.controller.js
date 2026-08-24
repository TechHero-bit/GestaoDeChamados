import * as ticketService from "../services/ticket.service.js";
import { sendTicketReply } from "../services/email.service.js";
import {
  listTicketsQuerySchema,
  replyTicketSchema,
  ticketIdSchema,
  updateTicketSchema,
} from "../schemas/ticket.schema.js";

function validationError(res, resultado, message = "Dados inválidos.") {
  return res.status(400).json({
    success: false,
    message,
    errors: resultado.error.errors.map((error) => ({
      campo: error.path.join("."),
      mensagem: error.message,
    })),
  });
}

function parseTicketId(id, res) {
  const result = ticketIdSchema.safeParse(id);
  if (!result.success) {
    validationError(res, result, "Identificador do chamado inválido.");
    return null;
  }
  return result.data;
}

/**
 * GET /api/tickets
 */
export async function listarTickets(req, res, next) {
  try {
    const resultado = listTicketsQuerySchema.safeParse(req.query);
    if (!resultado.success)
      return validationError(res, resultado, "Filtros inválidos.");

    const { tickets, total, page, pageSize } = await ticketService.listar(
      resultado.data,
    );

    return res.json({
      success: true,
      data: tickets,
      total,
      page,
      page_size: pageSize,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/tickets/:id
 */
export async function buscarTicket(req, res, next) {
  try {
    const id = parseTicketId(req.params.id, res);
    if (!id) return;
    const ticket = await ticketService.buscarPorId(id);

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: "Chamado não encontrado.",
      });
    }

    return res.json({
      success: true,
      data: ticket,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/tickets/:id
 */
export async function atualizarTicket(req, res, next) {
  try {
    const id = parseTicketId(req.params.id, res);
    if (!id) return;

    const resultado = updateTicketSchema.safeParse(req.body);
    if (!resultado.success) {
      return validationError(res, resultado);
    }

    // Verificar se ticket existe
    const existente = await ticketService.buscarPorId(id);
    if (!existente) {
      return res.status(404).json({
        success: false,
        message: "Chamado não encontrado.",
      });
    }

    const ticket = await ticketService.atualizarStatus(
      id,
      resultado.data.status,
    );

    return res.json({
      success: true,
      message: "Status atualizado com sucesso.",
      data: ticket,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/tickets/:id
 */
export async function excluirTicket(req, res, next) {
  try {
    const id = parseTicketId(req.params.id, res);
    if (!id) return;

    const existente = await ticketService.buscarPorId(id);
    if (!existente) {
      return res.status(404).json({
        success: false,
        message: "Chamado não encontrado.",
      });
    }

    await ticketService.excluir(id);

    return res.json({
      success: true,
      message: "Chamado excluído com sucesso.",
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/tickets/:id/reply
 */
export async function responderTicket(req, res, next) {
  try {
    const id = parseTicketId(req.params.id, res);
    if (!id) return;

    // 1. Validar mensagem
    const resultado = replyTicketSchema.safeParse(req.body);
    if (!resultado.success) {
      return validationError(res, resultado);
    }

    // 2. Buscar ticket
    const ticket = await ticketService.buscarPorId(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: "Chamado não encontrado.",
      });
    }

    // 3. Montar assunto de resposta (evitar múltiplos RE:)
    const assuntoOriginal = ticket.assunto.trim();
    const assuntoResposta = assuntoOriginal.toLowerCase().startsWith("re:")
      ? assuntoOriginal
      : `RE: ${assuntoOriginal}`;

    // 4. Enviar via Power Automate
    await sendTicketReply({
      ticketId: id,
      destinatario: ticket.remetente_email,
      assunto: assuntoResposta,
      mensagem: resultado.data.mensagem,
    });

    // 5. Registrar mensagem de saída (somente após envio bem-sucedido)
    const mensagem = await ticketService.adicionarMensagem({
      ticket_id: id,
      direcao: "Saida",
      remetente_email: ticketService.getHelpdeskEmail(),
      destinatario_email: ticket.remetente_email,
      corpo_mensagem: resultado.data.mensagem,
    });

    return res.status(201).json({
      success: true,
      message: "Resposta enviada com sucesso.",
      data: mensagem,
    });
  } catch (error) {
    next(error);
  }
}
