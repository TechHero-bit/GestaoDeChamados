import {
  completeIncomingAttachmentSchema,
  failIncomingAttachmentSchema,
  webhookPayloadSchema,
} from "../schemas/webhook.schema.js";
import {
  completeIncomingAttachment,
  failIncomingAttachment,
  prepareIncomingAttachments,
} from "../services/incoming-attachment.service.js";
import * as ticketService from "../services/ticket.service.js";

function validationError(res, result, message = "Payload inválido.") {
  return res.status(400).json({
    success: false,
    message,
    errors: result.error.errors.map((error) => ({
      campo: error.path.join("."),
      mensagem: error.message,
    })),
  });
}

/**
 * POST /api/webhooks/outlook
 * Recebe os metadados do e-mail/attachments do Power Automate, persiste a
 * mensagem e devolve capabilities temporárias para o upload direto ao Storage.
 */
export async function receberEmailOutlook(req, res, next) {
  try {
    const rawAttachments = Array.isArray(req.body?.attachments)
      ? req.body.attachments
      : [];

    console.log(
      "[INBOUND_ATTACHMENT_FLOW]",
      JSON.stringify({
        message_id_present: Boolean(req.body?.message_id),
        conversation_id_present: Boolean(req.body?.conversation_id),
        attachments_field_present: "attachments" in (req.body || {}),
        attachments_count: rawAttachments.length,
        attachment_names: rawAttachments.map((a) => a?.file_name || null),
        attachment_sizes: rawAttachments.map((a) =>
          typeof a?.file_size === "number" ? a.file_size : null,
        ),
        attachment_content_types: rawAttachments.map(
          (a) => a?.content_type || null,
        ),
        attachment_is_inline: rawAttachments.map((a) =>
          Boolean(a?.is_inline),
        ),
        attachment_content_id_present: rawAttachments.map((a) =>
          Boolean(a?.content_id),
        ),
      }),
    );

    const resultado = webhookPayloadSchema.safeParse(req.body);
    if (!resultado.success) return validationError(res, resultado);

    const dados = resultado.data;
    const resultadoEntrada = await ticketService.processarEntrada({
      ...dados,
      // Apenas metadados entram no payload de auditoria: nunca contentBytes.
      payload_original: req.body,
    });

    const attachments = resultadoEntrada.message
      ? await prepareIncomingAttachments({
          ticket: resultadoEntrada.ticket,
          message: resultadoEntrada.message,
          attachments: dados.attachments,
        })
      : [];

    return res.status(resultadoEntrada.duplicate ? 200 : 201).json({
      success: true,
      duplicate: resultadoEntrada.duplicate,
      message: resultadoEntrada.duplicate
        ? "E-mail já processado."
        : resultadoEntrada.threaded
          ? "Mensagem adicionada ao chamado com sucesso."
          : "Chamado criado com sucesso.",
      ticket_id: resultadoEntrada.ticket.id,
      message_id: dados.message_id,
      attachments,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/webhooks/outlook/attachments/complete
 * O Flow chama somente depois de o Supabase confirmar a escrita direta.
 */
export async function confirmarAnexoOutlook(req, res, next) {
  try {
    const result = completeIncomingAttachmentSchema.safeParse(req.body);
    if (!result.success) return validationError(res, result);

    const attachment = await completeIncomingAttachment({
      messageId: result.data.message_id,
      attachmentId: result.data.attachment_id,
    });
    return res.status(200).json({ success: true, data: attachment });
  } catch (error) {
    next(error);
  }
}

/** O Flow deve chamar esta rota em um ramo configurado como "run after failed". */
export async function falharAnexoOutlook(req, res, next) {
  try {
    const result = failIncomingAttachmentSchema.safeParse(req.body);
    if (!result.success) return validationError(res, result);

    const attachment = await failIncomingAttachment({
      messageId: result.data.message_id,
      attachmentId: result.data.attachment_id,
      failureCode: result.data.failure_code,
    });
    return res.status(200).json({ success: true, data: attachment });
  } catch (error) {
    next(error);
  }
}
