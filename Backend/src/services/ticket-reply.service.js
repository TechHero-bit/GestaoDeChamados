import { sendTicketReply } from "./email.service.js";
import { replyToMicrosoftMessage, safeHtmlFromText } from "./microsoft-graph.service.js";
import { getMicrosoftConnectionStatus } from "./microsoft-oauth.service.js";
import { adicionarMensagem, getHelpdeskEmail } from "./ticket.service.js";

export function getReplyMessageId(ticket) {
  return ticket.outlook_last_message_id || ticket.outlook_message_id;
}

function replySubject(subject) {
  const original = subject.trim();
  return original.toLowerCase().startsWith("re:") ? original : `RE: ${original}`;
}

function microsoftSenderEmail(connection, fallback) {
  const email = connection?.email?.trim().toLowerCase();
  return email || fallback();
}

function escapeHtmlAttribute(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

export function composeTicketReplyHtml(message, signature) {
  const safeMessage = safeHtmlFromText(message);
  if (!signature?.enabled || !signature?.has_signature || !signature?.content_id) {
    return safeMessage;
  }

  return `<div>${safeMessage}</div><br><br><img src="cid:${escapeHtmlAttribute(signature.content_id)}" alt="Assinatura" style="display:block;max-width:700px;height:auto;">`;
}

function logSignatureDiagnostic(signature, html, signatureAppended) {
  const pathFound = typeof signature?.storage_path === "string" && signature.storage_path.trim().length > 0;
  console.log(`[SIGNATURE_DIAG] enabled=${signature?.enabled === true}`);
  console.log(`[SIGNATURE_DIAG] pathFound=${pathFound}`);
  console.log("[SIGNATURE_DIAG] publicUrlGenerated=false");
  console.log(`[SIGNATURE_DIAG] signatureAppended=${signatureAppended}`);
  console.log(`[SIGNATURE_DIAG] graphBodyContainsImg=${typeof html === "string" && /<img\b/i.test(html)}`);
  console.log("[SIGNATURE_DIAG] provider=microsoft_graph");
}

/**
 * Seleciona o provedor exclusivamente a partir do usuário autenticado e só
 * registra a mensagem depois que um provedor confirma o envio.
 */
export async function sendAndPersistTicketReply(
  { ticket, userId, message },
  {
    getConnectionStatus = getMicrosoftConnectionStatus,
    replyWithMicrosoftGraph = replyToMicrosoftMessage,
    replyWithPowerAutomate = sendTicketReply,
    persistMessage = adicionarMensagem,
    helpdeskEmail = getHelpdeskEmail,
    // O controller injeta a consulta real; o fallback nulo mantém o serviço isolável em testes.
    getSignature = async () => null,
  } = {},
) {
  if (!userId) {
    throw Object.assign(new Error("Usuário autenticado não identificado."), {
      statusCode: 401,
    });
  }

  const messageId = getReplyMessageId(ticket);
  if (typeof messageId !== "string" || !messageId.trim()) {
    throw Object.assign(
      new Error("O chamado não possui uma mensagem do Outlook para responder."),
      { statusCode: 422 },
    );
  }

  const connection = await getConnectionStatus(userId);
  const signature = await getSignature(userId);
  const contentId = signature?.enabled ? "smartdesk-signature" : null;
  const signatureForEmail = signature?.enabled
    ? { ...signature, content_id: contentId }
    : signature;
  const mensagemTimeline = message;
  const mensagemEmailHtml = composeTicketReplyHtml(mensagemTimeline, signatureForEmail);
  const signatureAppended =
    signatureForEmail?.enabled === true &&
    signatureForEmail?.has_signature === true &&
    signatureForEmail?.content_id === "smartdesk-signature" &&
    Buffer.isBuffer(signatureForEmail?.image_bytes);

  if (signatureForEmail?.enabled === true && !signatureAppended) {
    throw Object.assign(new Error("Não foi possível preparar a assinatura inline."), {
      statusCode: 502,
      publicCode: "SIGNATURE_ATTACHMENT_FAILED",
      safeToFallback: false,
    });
  }

  const inlineAttachment = signatureAppended
    ? {
        contentId,
        contentBytes: signatureForEmail.image_bytes.toString("base64"),
      }
    : null;
  const powerAutomatePayload = {
    ticketId: ticket.id,
    messageId,
    destinatario: ticket.remetente_email,
    assunto: replySubject(ticket.assunto),
    mensagem: mensagemTimeline,
    prioridade: ticket.prioridade ?? "Normal",
  };

  let provider;
  let senderEmail;

  if (connection.connected) {
    try {
      const graphPayload = signatureAppended
        ? { messageId, message: mensagemTimeline, html: mensagemEmailHtml, inlineAttachment }
        : { messageId, message: mensagemTimeline, html: mensagemEmailHtml };
      await replyWithMicrosoftGraph(userId, graphPayload);
      logSignatureDiagnostic(signatureForEmail, mensagemEmailHtml, signatureAppended);
      provider = "microsoft_graph";
      senderEmail = microsoftSenderEmail(connection, helpdeskEmail);
    } catch (error) {
      if (signatureAppended || error?.safeToFallback !== true) throw error;

      await replyWithPowerAutomate(powerAutomatePayload);
      provider = "power_automate";
      senderEmail = helpdeskEmail();
    }
  } else {
    await replyWithPowerAutomate(powerAutomatePayload);
    provider = "power_automate";
    senderEmail = helpdeskEmail();
  }

  let persistedMessage;
  try {
    persistedMessage = await persistMessage({
      ticket_id: ticket.id,
      direcao: "Saida",
      remetente_email: senderEmail,
      destinatario_email: ticket.remetente_email,
      corpo_mensagem: mensagemTimeline,
      created_by: userId,
    });
  } catch (cause) {
    throw Object.assign(
      new Error(
        "A resposta foi enviada, mas não pôde ser registrada na timeline. Não tente reenviar.",
      ),
      {
        statusCode: 502,
        publicCode: "REPLY_SENT_PERSIST_FAILED",
        deliveryConfirmed: true,
        cause,
      },
    );
  }

  return { message: persistedMessage, provider };
}