import * as ticketService from "../services/ticket.service.js";
import {
  getReplyMessageId,
  sendAndPersistTicketReply,
} from "../services/ticket-reply.service.js";
import {
  cancelReplyDraftSchema,
  createReplyDraftSchema,
  listTicketsQuerySchema,
  replyDraftActionSchema,
  replyTicketSchema,
  sendReplyDraftSchema,
  ticketIdSchema,
  updateTicketSchema,
} from "../schemas/ticket.schema.js";
import { getUserSignatureConfig } from "../services/signature.service.js";
import {
  cancelTicketReplyDraft,
  createTicketReplyDraft,
  createTicketReplyUploadSession,
  sendTicketReplyDraft,
  uploadSmallTicketReplyAttachment,
} from "../services/ticket-reply-draft.service.js";

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

export { getReplyMessageId };

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

    const ticket = await ticketService.atualizarTicket(id, resultado.data);

    return res.json({
      success: true,
      message: "Chamado atualizado com sucesso.",
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
export async function responderTicket(
  req,
  res,
  next,
  {
    findTicket = ticketService.buscarPorId,
    sendReply = sendAndPersistTicketReply,
    getSignature = getUserSignatureConfig,
  } = {},
) {
  try {
    const id = parseTicketId(req.params.id, res);
    if (!id) return;

    // 1. Validar mensagem
    const resultado = replyTicketSchema.safeParse(req.body);
    if (!resultado.success) {
      return validationError(res, resultado);
    }

    // 2. Buscar ticket
    const ticket = await findTicket(id);
    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: "Chamado não encontrado.",
      });
    }

    // 3. O backend escolhe Graph ou Power Automate e só então persiste.
    const authenticatedUserId = req.user.id;
    const { message, provider } = await sendReply(
      {
        ticket,
        userId: authenticatedUserId,
        message: resultado.data.mensagem,
      },
      { getSignature },
    );

    return res.status(201).json({
      success: true,
      message: "Resposta enviada com sucesso.",
      data: message,
      provider,
    });
  } catch (error) {
    next(error);
  }
}

async function requireTicket(id, res) {
  const ticket = await ticketService.buscarPorId(id);
  if (!ticket) {
    res.status(404).json({ success: false, message: "Chamado não encontrado." });
    return null;
  }
  return ticket;
}

export async function criarRascunhoResposta(req, res, next) {
  try {
    const id = parseTicketId(req.params.id, res);
    if (!id) return;
    const result = createReplyDraftSchema.safeParse(req.body);
    if (!result.success) return validationError(res, result);
    const ticket = await requireTicket(id, res);
    if (!ticket) return;
    const draft = await createTicketReplyDraft({
      ticket, userId: req.user.id, message: result.data.mensagem,
      attachments: result.data.attachments,
    });
    return res.status(201).json({ success: true, data: draft });
  } catch (error) {
    next(error);
  }
}

export async function criarSessaoUploadResposta(req, res, next) {
  try {
    const id = parseTicketId(req.params.id, res);
    if (!id) return;
    const result = replyDraftActionSchema.safeParse(req.body);
    if (!result.success) return validationError(res, result);
    const session = await createTicketReplyUploadSession({
      ticketId: id, userId: req.user.id, handle: result.data.handle,
      message: result.data.mensagem, attachments: result.data.attachments,
      index: result.data.index,
    });
    return res.status(201).json({ success: true, data: session });
  } catch (error) {
    next(error);
  }
}

export async function adicionarAnexoSimplesResposta(
  req,
  res,
  next,
  { uploadAttachment = uploadSmallTicketReplyAttachment } = {},
) {
  try {
    const id = parseTicketId(req.params.id, res);
    if (!id) return;
    let attachments;
    try {
      attachments = JSON.parse(req.multipartFields?.attachments || "null");
    } catch {
      attachments = null;
    }
    const result = replyDraftActionSchema.safeParse({
      handle: req.multipartFields?.handle,
      index: Number(req.multipartFields?.index),
      mensagem: req.multipartFields?.mensagem,
      attachments,
    });
    if (!result.success) return validationError(res, result);
    const metadata = await uploadAttachment({
      ticketId: id, userId: req.user.id, handle: result.data.handle,
      message: result.data.mensagem, attachments: result.data.attachments,
      index: result.data.index, file: req.file,
    });
    return res.status(201).json({ success: true, data: metadata });
  } catch (error) {
    next(error);
  }
}

export async function finalizarRascunhoResposta(req, res, next) {
  try {
    const id = parseTicketId(req.params.id, res);
    if (!id) return;
    const result = sendReplyDraftSchema.safeParse(req.body);
    if (!result.success) return validationError(res, result);
    const ticket = await requireTicket(id, res);
    if (!ticket) return;
    const sent = await sendTicketReplyDraft({
      ticket, userId: req.user.id, handle: result.data.handle,
      message: result.data.mensagem, attachments: result.data.attachments,
    });
    return res.status(201).json({
      success: true, message: "Resposta enviada com sucesso.", data: sent.message,
      provider: sent.provider, attachments: sent.attachments,
    });
  } catch (error) {
    next(error);
  }
}

export async function cancelarRascunhoResposta(req, res, next) {
  try {
    const id = parseTicketId(req.params.id, res);
    if (!id) return;
    const result = cancelReplyDraftSchema.safeParse(req.body);
    if (!result.success) return validationError(res, result);
    await cancelTicketReplyDraft({ ticketId: id, userId: req.user.id, handle: result.data.handle });
    return res.status(200).json({ success: true, message: "Rascunho cancelado." });
  } catch (error) {
    next(error);
  }
}
