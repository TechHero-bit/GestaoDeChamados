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
  normalizeReplyAttachmentName,
  normalizeReplyAttachments,
  publicAttachmentMetadata,
  SMALL_ATTACHMENT_LIMIT_BYTES,
} from "./reply-attachment-policy.service.js";
import {
  replyDraftAttachmentIdDigest,
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
      digest: replyDraftDigest(message, normalized), signatureExpected, smallUploadReceipts: [],
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
  if (
    !file
      || !Buffer.isBuffer(file.buffer)
      || file.size !== attachment.size
      || file.buffer.length !== attachment.size
      || file.size >= SMALL_ATTACHMENT_LIMIT_BYTES
  ) {
    throw flowError("O arquivo recebido não corresponde ao anexo declarado.", 400, "ATTACHMENT_MISMATCH");
  }
  const createdAttachment = await addAttachment(userId, {
    draftId: flow.claims.draftId,
    attachment: { ...attachment, bytes: file.buffer },
  });
  if (
    createdAttachment?.graphCreateConfirmed !== true
      || createdAttachment?.isInline !== false
      || normalizeReplyAttachmentName(createdAttachment?.name) !== attachment.name
      || typeof createdAttachment?.attachmentId !== "string"
      || !createdAttachment.attachmentId
  ) {
    throw flowError(
      "O Microsoft Outlook não confirmou a identidade do anexo criado.",
      502,
      "GRAPH_ATTACHMENT_CONFIRMATION_INVALID",
    );
  }
  const receipt = {
    index,
    attachmentIdDigest: replyDraftAttachmentIdDigest(createdAttachment.attachmentId),
    expectedSize: attachment.size,
    parsedBufferSize: createdAttachment.parsedBufferSize,
    base64RoundtripValid: createdAttachment.base64RoundtripValid === true,
    graphCreateConfirmed: true,
  };
  const previousReceipts = Array.isArray(flow.claims.smallUploadReceipts)
    ? flow.claims.smallUploadReceipts.filter((item) => item?.index !== index)
    : [];
  const nextHandle = await signReplyDraftHandle({
    userId,
    ticketId,
    draftId: flow.claims.draftId,
    digest: flow.claims.digest,
    signatureExpected: flow.claims.signatureExpected === true,
    smallUploadReceipts: [...previousReceipts, receipt],
  });
  return {
    ...publicAttachmentMetadata(attachment),
    handle: nextHandle,
    small_attachment_created: true,
  };
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

function matchOneToOne(expected, actual, predicate) {
  const remaining = [...actual];
  let foundCount = 0;
  for (const expectedAttachment of expected) {
    const match = remaining.findIndex((actualAttachment) =>
      predicate(expectedAttachment, actualAttachment));
    if (match < 0) continue;
    foundCount += 1;
    remaining.splice(match, 1);
  }
  return { foundCount, remaining };
}

function sameAttachmentName(expectedAttachment, actualAttachment) {
  return normalizeReplyAttachmentName(actualAttachment?.name) === expectedAttachment.name;
}

function evaluateCompletedAttachments(expected, actual, signatureExpected, claims) {
  const graphAttachments = Array.isArray(actual) ? actual : [];
  const graphRegular = graphAttachments.filter((attachment) => attachment?.isInline === false);
  const signatureFound = graphAttachments.some((attachment) =>
    attachment?.isInline === true
      && (attachment?.contentId === SIGNATURE_CONTENT_ID
        || attachment?.name === "signature.png"),
  );
  const exact = matchOneToOne(expected, graphRegular, (expectedAttachment, actualAttachment) =>
    sameAttachmentName(expectedAttachment, actualAttachment)
      && Number(actualAttachment?.size) === expectedAttachment.size);
  const byName = matchOneToOne(expected, graphRegular, sameAttachmentName);
  const receipts = new Map(
    (Array.isArray(claims?.smallUploadReceipts) ? claims.smallUploadReceipts : [])
      .map((receipt) => [receipt?.index, receipt]),
  );
  const expectedWithIndex = expected.map((attachment, index) => ({ ...attachment, index }));
  function validSmallReceipt(expectedAttachment) {
    const receipt = receipts.get(expectedAttachment.index);
    return receipt?.expectedSize === expectedAttachment.size
      && receipt?.parsedBufferSize === expectedAttachment.size
      && receipt?.base64RoundtripValid === true
      && receipt?.graphCreateConfirmed === true
      && typeof receipt?.attachmentIdDigest === "string";
  }
  const confirmed = matchOneToOne(
    expectedWithIndex,
    graphRegular,
    (expectedAttachment, actualAttachment) => {
      if (!sameAttachmentName(expectedAttachment, actualAttachment)) return false;
      if (expectedAttachment.kind !== "simple") {
        return Number(actualAttachment?.size) === expectedAttachment.size;
      }
      // Para SMALL, o ID confirmado pelo POST 201 identifica o mesmo objeto na
      // listagem sem depender do size que o Exchange projetar para o attachment.
      const receipt = receipts.get(expectedAttachment.index);
      return validSmallReceipt(expectedAttachment)
        && typeof actualAttachment?.id === "string"
        && replyDraftAttachmentIdDigest(actualAttachment.id) === receipt.attachmentIdDigest;
    },
  );
  const expectedSmall = expectedWithIndex.filter((attachment) => attachment.kind === "simple");
  const smallUploadConfirmed = expectedSmall.every(validSmallReceipt);
  const draftHandleCurrent = smallUploadConfirmed;
  const allRegularFound = confirmed.foundCount === expected.length && confirmed.remaining.length === 0;
  const readyToSend = allRegularFound
    && (!signatureExpected || signatureFound)
    && draftHandleCurrent;
  const counts = {
    expected_count: expected.length,
    found_count: confirmed.foundCount,
    missing_count: expected.length - confirmed.foundCount,
    unexpected_count: confirmed.remaining.length,
  };
  const singleReceipt = receipts.get(0);
  const graphReceiptMatch = expected.length === 1 && typeof singleReceipt?.attachmentIdDigest === "string"
    ? graphRegular.find((attachment) =>
        typeof attachment?.id === "string"
          && replyDraftAttachmentIdDigest(attachment.id) === singleReceipt.attachmentIdDigest)
    : undefined;
  const graphNameMatch = expected.length === 1
    ? graphRegular.find((attachment) => sameAttachmentName(expected[0], attachment))
    : undefined;
  const graphSizeValue = Number(graphReceiptMatch?.size ?? graphNameMatch?.size);
  const graphSize = Number.isSafeInteger(graphSizeValue) && graphSizeValue >= 0 ? graphSizeValue : 0;
  const parsedBufferSize = Number.isSafeInteger(singleReceipt?.parsedBufferSize)
    ? singleReceipt.parsedBufferSize
    : 0;
  const attachmentDebug = expected.length === 1
    ? {
        expected_regular_count: expected.length,
        graph_regular_count: graphRegular.length,
        expected_size: expected[0].size,
        parsed_buffer_size: parsedBufferSize,
        graph_size: graphSize,
        size_delta: graphSize - expected[0].size,
        parser_size_matches: parsedBufferSize === expected[0].size,
        base64_roundtrip_valid: singleReceipt?.base64RoundtripValid === true,
        graph_create_confirmed: singleReceipt?.graphCreateConfirmed === true,
        signature_expected: signatureExpected,
        signature_found: signatureFound,
        regular_name_matches: byName.foundCount === expected.length,
        regular_size_matches: byName.foundCount === expected.length
          && exact.foundCount === expected.length,
        regular_inline_matches: graphAttachments.some((attachment) =>
          attachment?.isInline === false && sameAttachmentName(expected[0], attachment)),
        all_regular_found: allRegularFound,
        small_upload_confirmed: smallUploadConfirmed,
        graph_regular_attachment_found: confirmed.foundCount === expected.length,
        draft_handle_current: draftHandleCurrent,
        manifest_attachment_count: expected.length,
        ready_to_send: readyToSend,
      }
    : {
        ...counts,
        signature_expected: signatureExpected,
        signature_found: signatureFound,
        small_upload_confirmed: smallUploadConfirmed,
        draft_handle_current: draftHandleCurrent,
        manifest_attachment_count: expected.length,
        ready_to_send: readyToSend,
      };
  return { readyToSend, attachmentDebug };
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
  const validation = evaluateCompletedAttachments(
    flow.attachments,
    actual,
    flow.claims.signatureExpected === true,
    flow.claims,
  );
  if (!validation.readyToSend) {
    throw Object.assign(flowError(
      "Nem todos os anexos foram concluídos. O rascunho não foi enviado.",
      409,
      "ATTACHMENTS_INCOMPLETE",
    ), { attachmentDebug: validation.attachmentDebug });
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
    attachmentDebug: validation.attachmentDebug,
  };
}

export async function cancelTicketReplyDraft(
  { ticketId, userId, handle },
  { deleteDraft = deleteMicrosoftReplyDraft } = {},
) {
  const claims = await verifyReplyDraftHandle(handle, { userId, ticketId });
  await deleteDraft(userId, claims.draftId);
}
