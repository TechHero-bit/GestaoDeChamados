import { sendTicketReply } from "./email.service.js";
import { replyToMicrosoftMessage, safeHtmlFromText } from "./microsoft-graph.service.js";
import { getMicrosoftConnectionStatus } from "./microsoft-oauth.service.js";
import { adicionarMensagem, getHelpdeskEmail } from "./ticket.service.js";
import { getUserSignatureConfig } from "./signature.service.js";

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
  if (!signature?.enabled || !signature?.hasSignature || !signature?.contentId) {
    return safeMessage;
  }

  return `<div>${safeMessage}</div><br><br><img src="cid:${escapeHtmlAttribute(signature.contentId)}" alt="Assinatura" style="display:block;max-width:700px;height:auto;">`;
}

function createSignatureDebug(signature, userId) {
  const authUserIdPresent = typeof userId === "string" && userId.length > 0;
  const profileEnabled = signature?.profileEnabled === true;
  const replyEnabled = signature?.enabled === true;
  const pathFound =
    typeof signature?.storagePath === "string" && signature.storagePath.trim().length > 0;

  return {
    enabled: replyEnabled,
    auth_user_id_present: authUserIdPresent,
    signature_service_received_string_id:
      signature?.signatureServiceReceivedStringId === true,
    signature_profile_found: signature?.signatureProfileFound === true,
    profile_enabled: profileEnabled,
    reply_enabled: replyEnabled,
    path_found: pathFound,
    has_signature: signature?.hasSignature === true,
    same_authenticated_user: signature?.sameAuthenticatedUser === true,
    storage_downloaded:
      signature?.storageDownloaded === true && Buffer.isBuffer(signature?.imageBytes),
    draft_created: false,
    body_contains_cid: false,
    attachment_created: false,
    attachment_inline: false,
    content_id_matches: false,
    draft_sent: false,
  };
}

function logSignatureDiagnostic(signature, html, signatureAppended) {
  const pathFound = typeof signature?.storagePath === "string" && signature.storagePath.trim().length > 0;
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
    getSignature = getUserSignatureConfig,
  } = {},
) {
  if (typeof userId !== "string" || userId.length === 0) {
    throw Object.assign(new Error("O identificador do usuário autenticado é inválido."), {
      statusCode: 500,
      publicCode: "SIGNATURE_USER_ID_INVALID",
      signatureError: true,
      signatureDebug: {
        enabled: false,
        auth_user_id_present: false,
        signature_service_received_string_id: false,
        signature_profile_found: false,
        profile_enabled: false,
        path_found: false,
        has_signature: false,
        same_authenticated_user: false,
        reply_enabled: false,
      },
      signatureLog: {
        stage: "reply.user_id",
        status: 500,
        receivedType: Array.isArray(userId) ? "array" : typeof userId,
      },
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
  const signature = await getSignature(userId, { downloadImage: true });
  let signatureDebug = createSignatureDebug(signature, userId);
  const contentId = signature?.enabled ? "smartdesk-signature" : null;
  const signatureForEmail = signature?.enabled
    ? { ...signature, contentId }
    : signature;
  const mensagemTimeline = message;
  const mensagemEmailHtml = composeTicketReplyHtml(mensagemTimeline, signatureForEmail);
  const signatureAppended =
    signatureForEmail?.enabled === true &&
    signatureForEmail?.hasSignature === true &&
    signatureForEmail?.contentId === "smartdesk-signature" &&
    Buffer.isBuffer(signatureForEmail?.imageBytes);

  if (signatureForEmail?.enabled === true && !signatureAppended) {
    signatureDebug.body_contains_cid = mensagemEmailHtml.includes(
      'src="cid:smartdesk-signature"',
    );
    signatureDebug.content_id_matches =
      signatureForEmail?.contentId === "smartdesk-signature" &&
      signatureDebug.body_contains_cid;
    throw Object.assign(new Error("Não foi possível preparar a assinatura inline."), {
      statusCode: 502,
      publicCode: "SIGNATURE_ATTACHMENT_FAILED",
      diagnosticCode: "SIGNATURE_ATTACHMENT_FAILED",
      microsoftDiagnosticError: true,
      safeToFallback: false,
      signatureDebug,
    });
  }

  const inlineAttachment = signatureAppended
    ? {
        contentId,
        contentBytes: signatureForEmail.imageBytes.toString("base64"),
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
      const graphResult = await replyWithMicrosoftGraph(userId, graphPayload);
      if (signatureDebug.enabled) {
        signatureDebug = {
          ...signatureDebug,
          ...(graphResult?.signatureDebug || {}),
        };
      }
      logSignatureDiagnostic(signatureForEmail, mensagemEmailHtml, signatureAppended);
      provider = "microsoft_graph";
      senderEmail = microsoftSenderEmail(connection, helpdeskEmail);
    } catch (error) {
      if (signatureDebug.enabled) {
        error.signatureDebug = {
          ...signatureDebug,
          ...(error.signatureDebug || {}),
        };
      }
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

  return { message: persistedMessage, provider, signatureDebug };
}
