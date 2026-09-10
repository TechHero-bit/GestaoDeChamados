import { getMicrosoftConnectionStatus } from "./microsoft-oauth.service.js";
import {
  addMicrosoftDraftFileAttachment,
  createMicrosoftAttachmentUploadSession,
  createMicrosoftReplyDraft,
  deleteMicrosoftReplyDraft,
  listMicrosoftDraftAttachments,
  sendMicrosoftReplyDraft,
} from "./microsoft-graph.service.js";
import { getUserSignatureConfig } from "./signature.service.js";
import { adicionarMensagem, getHelpdeskEmail } from "./ticket.service.js";
import { composeTicketReplyHtml, getReplyMessageId } from "./ticket-reply.service.js";
import {
  normalizeReplyAttachments,
  publicAttachmentMetadata,
  SMALL_ATTACHMENT_LIMIT_BYTES,
} from "./reply-attachment-policy.service.js";
import {
  replyDraftDigest,
  signReplyDraftHandle,
  verifyReplyDraftHandle,
} from "./reply-draft-handle.service.js";

const SIGNATURE_CONTENT_ID = "smartdesk-signature";

function flowError(message, statusCode, publicCode) {
  return Object.assign(new Error(message), { statusCode, publicCode });
}

async function requireMicrosoft(userId, getConnectionStatus) {
  const connection = await getConnectionStatus(userId);
  if (!connection.connected) {
    throw flowError(
      "Para enviar anexos, conecte sua conta Microsoft Outlook.",
      422,
      "MICROSOFT_REQUIRED_FOR_ATTACHMENTS",
    );
  }
  return connection;
}

async function validateFlowPayload({ handle, userId, ticketId, message, attachments }) {
  const normalized = normalizeReplyAttachments(attachments);
  const claims = await verifyReplyDraftHandle(handle, { userId, ticketId });
  if (claims.digest !== replyDraftDigest(message, normalized)) {
    throw flowError("Os dados do rascunho foram alterados.", 403, "REPLY_DRAFT_MANIFEST_MISMATCH");
  }
  return { claims, attachments: normalized };
}

export async function createTicketReplyDraft(
  { ticket, userId, message, attachments },
  {
    getConnectionStatus = getMicrosoftConnectionStatus,
    getSignature = getUserSignatureConfig,
    createDraft = createMicrosoftReplyDraft,
    deleteDraft = deleteMicrosoftReplyDraft,
  } = {},
) {
  await requireMicrosoft(userId, getConnectionStatus);
  const normalized = normalizeReplyAttachments(attachments);
  const messageId = getReplyMessageId(ticket);
  if (typeof messageId !== "string" || !messageId.trim()) {
    throw flowError("O chamado não possui uma mensagem do Outlook para responder.", 422, "OUTLOOK_MESSAGE_MISSING");
  }

  const signature = await getSignature(userId, { downloadImage: true });
  const signatureExpected = signature?.enabled === true;
  const signatureReady = signatureExpected && signature?.hasSignature === true && Buffer.isBuffer(signature?.imageBytes);
  if (signatureExpected && !signatureReady) {
    throw flowError("Não foi possível preparar a assinatura inline.", 502, "SIGNATURE_ATTACHMENT_FAILED");
  }
  const signatureForEmail = signatureReady ? { ...signature, contentId: SIGNATURE_CONTENT_ID } : signature;
  const html = composeTicketReplyHtml(message, signatureForEmail);
  const inlineAttachment = signatureReady
    ? { contentId: SIGNATURE_CONTENT_ID, contentBytes: signature.imageBytes.toString("base64") }
    : undefined;
  const draft = await createDraft(userId, { messageId, html, inlineAttachment });
  let handle;
  try {
    handle = await signReplyDraftHandle({
      userId, ticketId: ticket.id, draftId: draft.draftId,
      digest: replyDraftDigest(message, normalized), signatureExpected,
    });
  } catch (error) {
    try { await deleteDraft(userId, draft.draftId); } catch {}
    throw error;
  }

  return {
    handle,
    attachments: normalized.map((attachment, index) => ({
      index, ...publicAttachmentMetadata(attachment), upload_type: attachment.kind,
    })),
    signature_added: draft.signatureAdded === true,
  };
}

export async function uploadSmallTicketReplyAttachment(
  { ticketId, userId, handle, message, attachments, index, file },
  { addAttachment = addMicrosoftDraftFileAttachment } = {},
) {
  const flow = await validateFlowPayload({ handle, userId, ticketId, message, attachments });
  const attachment = flow.attachments[index];
  if (!attachment || attachment.kind !== "simple") {
    throw flowError("Este anexo não pertence ao fluxo de upload simples.", 400, "ATTACHMENT_FLOW_INVALID");
  }
  if (!file || file.size !== attachment.size || file.size >= SMALL_ATTACHMENT_LIMIT_BYTES) {
    throw flowError("O arquivo recebido não corresponde ao anexo declarado.", 400, "ATTACHMENT_MISMATCH");
  }
  await addAttachment(userId, {
    draftId: flow.claims.draftId,
    attachment: { ...attachment, bytes: file.buffer },
  });
  return publicAttachmentMetadata(attachment);
}

export async function createTicketReplyUploadSession(
  { ticketId, userId, handle, message, attachments, index },
  { createUploadSession = createMicrosoftAttachmentUploadSession } = {},
) {
  const flow = await validateFlowPayload({ handle, userId, ticketId, message, attachments });
  const attachment = flow.attachments[index];
  if (!attachment || attachment.kind !== "upload_session") {
    throw flowError("Este anexo não pertence ao fluxo de upload em partes.", 400, "ATTACHMENT_FLOW_INVALID");
  }
  return createUploadSession(userId, { draftId: flow.claims.draftId, attachment });
}

function validateCompletedAttachments(expected, actual, signatureExpected) {
  const ordinary = actual.filter((attachment) => attachment?.isInline !== true);
  const remaining = [...ordinary];
  for (const expectedAttachment of expected) {
    const match = remaining.findIndex((attachment) =>
      attachment?.name === expectedAttachment.name && Number(attachment?.size) === expectedAttachment.size,
    );
    if (match < 0) return false;
    remaining.splice(match, 1);
  }
  if (remaining.length > 0) return false;
  if (!signatureExpected) return true;
  return actual.some((attachment) =>
    attachment?.isInline === true
      && (attachment?.contentId === SIGNATURE_CONTENT_ID || attachment?.name === "signature.png"),
  );
}

function completedAttachmentContext(attachments, draftId) {
  const attachmentStrategy = attachments.every((attachment) => attachment.kind === "simple")
    ? "small"
    : "large";
  const attachmentDebug = attachmentStrategy === "small"
    ? {
        draft_exists: typeof draftId === "string" && draftId.length > 0,
        draft_sent_before_attachment: false,
        same_draft: true,
        payload_direct_object: true,
        odata_type_matches_signature: true,
        buffer_present: true,
        base64_roundtrip_valid: true,
      }
    : undefined;
  return { attachmentStrategy, attachmentDebug };
}

export async function sendTicketReplyDraft(
  { ticket, userId, handle, message, attachments },
  {
    getConnectionStatus = getMicrosoftConnectionStatus,
    listAttachments = listMicrosoftDraftAttachments,
    sendDraft = sendMicrosoftReplyDraft,
    persistMessage = adicionarMensagem,
    helpdeskEmail = getHelpdeskEmail,
  } = {},
) {
  const connection = await requireMicrosoft(userId, getConnectionStatus);
  const flow = await validateFlowPayload({ handle, userId, ticketId: ticket.id, message, attachments });
  const attachmentContext = completedAttachmentContext(flow.attachments, flow.claims.draftId);
  const actual = await listAttachments(userId, flow.claims.draftId, attachmentContext);
  if (!validateCompletedAttachments(flow.attachments, actual, flow.claims.signatureExpected === true)) {
    throw flowError(
      "Nem todos os anexos foram concluídos. O rascunho não foi enviado.",
      409,
      "ATTACHMENTS_INCOMPLETE",
    );
  }

  await sendDraft(userId, flow.claims.draftId, attachmentContext);
  let persisted;
  try {
    persisted = await persistMessage({
      ticket_id: ticket.id,
      direcao: "Saida",
      remetente_email: connection.email?.trim().toLowerCase() || helpdeskEmail(),
      destinatario_email: ticket.remetente_email,
      corpo_mensagem: message,
      created_by: userId,
    });
  } catch (cause) {
    throw Object.assign(
      new Error("A resposta foi enviada, mas não pôde ser registrada na timeline. Não tente reenviar."),
      { statusCode: 502, publicCode: "REPLY_SENT_PERSIST_FAILED", deliveryConfirmed: true, cause },
    );
  }
  return {
    message: persisted,
    provider: "microsoft_graph",
    attachments: flow.attachments.map(publicAttachmentMetadata),
  };
}

export async function cancelTicketReplyDraft(
  { ticketId, userId, handle },
  { deleteDraft = deleteMicrosoftReplyDraft } = {},
) {
  const claims = await verifyReplyDraftHandle(handle, { userId, ticketId });
  await deleteDraft(userId, claims.draftId);
}
