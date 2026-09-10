import { getValidMicrosoftAccessToken, logMicrosoftDiagnostic } from "./microsoft-oauth.service.js";

const GRAPH_SEND_MAIL_URL = "https://graph.microsoft.com/v1.0/me/sendMail";

function serviceError(message, statusCode = 502) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Envia um e-mail usando a conta Microsoft conectada ao usuário do Help Desk.
 * O token é obtido e utilizado somente no backend.
 */
export async function sendMicrosoftEmail(
  userId,
  { to, subject, html },
  { getAccessToken = getValidMicrosoftAccessToken, fetchImpl = globalThis.fetch } = {},
) {
  let accessToken;
  try {
    accessToken = await getAccessToken(userId);
  } catch (error) {
    // Mantém o erro funcional do OAuth, mas nunca propaga dados de credenciais.
    if (error?.statusCode === 404) {
      throw serviceError("Conta Microsoft não conectada.", 404);
    }
    throw serviceError("Não foi possível obter a conexão Microsoft para envio.", 502);
  }

  let response;
  try {
    response = await fetchImpl(GRAPH_SEND_MAIL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject,
          body: {
            contentType: "HTML",
            content: html,
          },
          toRecipients: [
            {
              emailAddress: {
                address: to,
              },
            },
          ],
        },
        saveToSentItems: true,
      }),
    });
  } catch (error) {
    throw serviceError("Não foi possível comunicar com o Microsoft Outlook.", 502);
  }

  if (response.status !== 202) {
    throw serviceError("A Microsoft não aceitou o envio do e-mail.", 502);
  }
}


export function safeHtmlFromText(text) {
  return String(text).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]).replace(/\r?\n/g, "<br>");
}

function graphReplyError(status) {
  const errors = {
    400: {
      code: "GRAPH_BAD_REQUEST",
      message: "A Microsoft rejeitou o payload ou o identificador da mensagem.",
    },
    401: {
      code: "GRAPH_UNAUTHORIZED",
      message: "A Microsoft não autorizou a resposta com a conta conectada.",
    },
    403: {
      code: "GRAPH_FORBIDDEN",
      message: "A conta Microsoft conectada não tem acesso para responder esta mensagem.",
    },
    404: {
      code: "GRAPH_MESSAGE_NOT_FOUND",
      message: "A mensagem original não foi encontrada na conta Microsoft conectada.",
    },
    408: {
      code: "GRAPH_REQUEST_REJECTED",
      message: "A Microsoft não processou a resposta dentro do prazo.",
      safeToFallback: true,
    },
    429: {
      code: "GRAPH_RATE_LIMITED",
      message: "A Microsoft limitou temporariamente o envio da resposta.",
      safeToFallback: true,
    },
  };
  const details =
    errors[status] ||
    (status >= 500 && status <= 599
      ? {
          code: "GRAPH_TEMPORARY_FAILURE",
          message: "A Microsoft está temporariamente indisponível para responder.",
          safeToFallback: true,
        }
      : {
          code: "GRAPH_REPLY_FAILED",
          message: "A Microsoft não aceitou a resposta da mensagem.",
        });
  return Object.assign(new Error(details.message), {
    statusCode: 502,
    publicCode: details.code,
    diagnosticCode: "MICROSOFT_GRAPH_REPLY_FAILED",
    microsoftDiagnosticError: true,
    graphStatus: status,
    safeToFallback: details.safeToFallback === true,
  });
}

async function readGraphErrorCode(response) {
  try {
    const payload = await response.clone().json();
    return typeof payload?.error?.code === "string"
      ? payload.error.code
      : typeof payload?.error === "string"
        ? payload.error
        : undefined;
  } catch {
    return undefined;
  }
}

function isPreSendNetworkError(error) {
  return (
    error instanceof TypeError ||
    error?.name === "AbortError" ||
    error?.name === "TimeoutError"
  );
}
const SIGNATURE_CONTENT_ID = "smartdesk-signature";

function signatureGraphError(publicCode, message, signatureDebug) {
  return Object.assign(new Error(message), {
    statusCode: 502,
    publicCode,
    safeToFallback: false,
    microsoftDiagnosticError: true,
    diagnosticCode: publicCode,
    signatureDebug: { ...signatureDebug },
  });
}

function createInlineSignatureDebug(html, inlineAttachment) {
  const bodyContainsCid =
    typeof html === "string" && html.includes(`src="cid:${SIGNATURE_CONTENT_ID}"`);
  const contentIdMatches =
    inlineAttachment?.contentId === SIGNATURE_CONTENT_ID && bodyContainsCid;

  return {
    enabled: true,
    draft_created: false,
    body_contains_cid: bodyContainsCid,
    attachment_created: false,
    attachment_inline: true,
    content_id_matches: contentIdMatches,
    draft_sent: false,
  };
}

async function readResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function executeInlineSignatureDraft(
  accessToken,
  { messageId, html, inlineAttachment },
  fetchImpl,
) {
  const signatureDebug = createInlineSignatureDebug(html, inlineAttachment);
  const contentBytesPresent =
    typeof inlineAttachment?.contentBytes === "string" &&
    inlineAttachment.contentBytes.trim().length > 0;

  if (
    !signatureDebug.body_contains_cid ||
    !signatureDebug.content_id_matches ||
    !contentBytesPresent
  ) {
    throw signatureGraphError(
      "SIGNATURE_ATTACHMENT_FAILED",
      "Não foi possível preparar o conteúdo da assinatura inline.",
      signatureDebug,
    );
  }

  const messageUrl = "https://graph.microsoft.com/v1.0/me/messages/";
  let response;
  try {
    response = await fetchImpl(messageUrl + encodeURIComponent(messageId) + "/createReply", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw signatureGraphError(
      "SIGNATURE_DRAFT_FAILED",
      "Não foi possível criar o rascunho da resposta com assinatura.",
      signatureDebug,
    );
  }

  if (response.status !== 201) {
    throw signatureGraphError(
      "SIGNATURE_DRAFT_FAILED",
      "A Microsoft não aceitou a criação do rascunho da resposta.",
      signatureDebug,
    );
  }

  const draft = await readResponseJson(response);
  const draftId = typeof draft?.id === "string" && draft.id.trim() ? draft.id : null;
  if (!draftId) {
    throw signatureGraphError(
      "SIGNATURE_DRAFT_FAILED",
      "A Microsoft não retornou o identificador do rascunho.",
      signatureDebug,
    );
  }
  signatureDebug.draft_created = true;

  const draftUrl = messageUrl + encodeURIComponent(draftId);
  try {
    response = await fetchImpl(draftUrl, {
      method: "PATCH",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        body: {
          contentType: "HTML",
          content: html,
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw signatureGraphError(
      "SIGNATURE_DRAFT_FAILED",
      "Não foi possível atualizar o rascunho da resposta.",
      signatureDebug,
    );
  }

  if (response.status !== 200) {
    throw signatureGraphError(
      "SIGNATURE_DRAFT_FAILED",
      "A Microsoft não aceitou o HTML do rascunho da resposta.",
      signatureDebug,
    );
  }

  try {
    response = await fetchImpl(draftUrl + "/attachments", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: "signature.png",
        contentType: "image/png",
        contentId: SIGNATURE_CONTENT_ID,
        isInline: true,
        contentBytes: inlineAttachment.contentBytes,
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw signatureGraphError(
      "SIGNATURE_ATTACHMENT_FAILED",
      "Não foi possível adicionar a assinatura ao rascunho.",
      signatureDebug,
    );
  }

  if (response.status !== 201) {
    throw signatureGraphError(
      "SIGNATURE_ATTACHMENT_FAILED",
      "A Microsoft não aceitou a assinatura inline.",
      signatureDebug,
    );
  }
  signatureDebug.attachment_created = true;

  try {
    response = await fetchImpl(draftUrl + "/send", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw signatureGraphError(
      "SIGNATURE_SEND_FAILED",
      "Não foi possível enviar o rascunho com assinatura.",
      signatureDebug,
    );
  }

  if (response.status !== 202) {
    throw signatureGraphError(
      "SIGNATURE_SEND_FAILED",
      "A Microsoft não aceitou o envio do rascunho com assinatura.",
      signatureDebug,
    );
  }
  signatureDebug.draft_sent = true;

  return { draftId, status: 202, signatureDebug: { ...signatureDebug } };
}
/**
 * Responde diretamente a uma mensagem existente na mailbox Microsoft conectada.
 * Este método não persiste nada no Help Desk.
 */
export async function replyToMicrosoftMessage(
  userId,
  { messageId, message, html, inlineAttachment },
  { getAccessToken = getValidMicrosoftAccessToken, fetchImpl = globalThis.fetch } = {},
) {
  if (typeof messageId !== "string" || messageId.trim().length === 0) {
    throw Object.assign(new Error("Identificador da mensagem inválido."), { statusCode: 400 });
  }

  let accessToken;
  try {
    accessToken = await getAccessToken(userId);
  } catch (error) {
    if (error?.statusCode === 404) {
      throw Object.assign(new Error("Conta Microsoft não conectada."), {
        statusCode: 404,
        publicCode: "MICROSOFT_NOT_CONNECTED",
        diagnosticCode: "MICROSOFT_CONNECTION_NOT_FOUND",
        safeToFallback: true,
        microsoftAuthError: error.microsoftAuthError === true,
        microsoftAuthLog: error.microsoftAuthLog,
      });
    }
    if (error?.microsoftAuthError) {
      throw Object.assign(new Error(error.message), {
        statusCode: error.statusCode || 502,
        publicCode: "MICROSOFT_TOKEN_UNAVAILABLE",
        safeToFallback: false,
        microsoftAuthError: true,
        microsoftAuthLog: error.microsoftAuthLog,
        diagnosticCode: error.diagnosticCode || "MICROSOFT_TOKEN_REFRESH_FAILED",
      });
    }
    if (!error?.microsoftAuthError) {
      logMicrosoftDiagnostic("token.acquire", {
        userId,
        errorName: error?.constructor?.name || "Error",
      });
    }
    if (isPreSendNetworkError(error)) {
      throw Object.assign(
        new Error("A conexão Microsoft está temporariamente indisponível."),
        {
          statusCode: 502,
          publicCode: "MICROSOFT_TOKEN_NETWORK_ERROR",
          safeToFallback: true,
        },
      );
    }
    throw Object.assign(new Error("Não foi possível obter a conexão Microsoft para responder."), {
      statusCode: 502,
      publicCode: "MICROSOFT_TOKEN_UNAVAILABLE",
      safeToFallback: false,
    });
  }

  if (inlineAttachment) {
    return executeInlineSignatureDraft(
      accessToken,
      { messageId, html, inlineAttachment },
      fetchImpl,
    );
  }

  let response;
  try {
    response = await fetchImpl(
      `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/reply`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            body: {
              contentType: "HTML",
              content: typeof html === "string" ? html : safeHtmlFromText(message),
            },
          },
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
  } catch (error) {
    logMicrosoftDiagnostic("graph.reply", {
      userId,
      errorName: error?.constructor?.name || "Error",
    });
    throw Object.assign(new Error("Não foi possível confirmar se o Microsoft Outlook enviou a resposta."), {
      statusCode: 502,
      publicCode: "GRAPH_DELIVERY_UNKNOWN",
      safeToFallback: false,
    });
  }

  if (response.status !== 202) {
    const externalCode = await readGraphErrorCode(response);
    logMicrosoftDiagnostic("graph.reply", {
      userId,
      status: response.status,
      code: externalCode,
      errorName: "MicrosoftGraphError",
    });
    throw graphReplyError(response.status);
  }

  logMicrosoftDiagnostic("graph.reply", {
    userId,
    status: response.status,
    success: true,
  });
}

const GRAPH_MESSAGES_URL = "https://graph.microsoft.com/v1.0/me/messages/";

function safeGraphErrorCode(externalCode) {
  return typeof externalCode === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(externalCode)
    ? externalCode
    : "unknown";
}

function graphAttachmentError(status, externalCode, attachmentStrategy, attachmentDebug) {
  const limitCodes = new Set([
    "ErrorMessageSizeExceeded", "ErrorAttachmentSizeLimitExceeded",
    "RequestEntityTooLarge", "MessageTooBig", "MaximumAttachmentSizeExceeded",
  ]);
  const sizeLimited = status === 413 || limitCodes.has(externalCode);
  const code = sizeLimited ? "EXCHANGE_MESSAGE_SIZE_LIMIT" : "GRAPH_ATTACHMENT_FAILED";
  return Object.assign(
    new Error(sizeLimited
      ? "O Outlook recusou o anexo porque o tamanho permitido pela caixa postal foi excedido."
      : "O Microsoft Outlook não aceitou a operação com o anexo."),
    {
      statusCode: sizeLimited ? 422 : 502,
      code,
      publicCode: code,
      diagnosticCode: code,
      microsoftDiagnosticError: true,
      graphStatus: status,
      graphError: safeGraphErrorCode(externalCode),
      ...(attachmentStrategy === "small" || attachmentStrategy === "large"
        ? { attachmentStrategy }
        : {}),
      ...(attachmentDebug ? { attachmentDebug } : {}),
    },
  );
}

function logAttachmentGraphDiagnostic(fields) {
  console.info(`ATTACHMENT_GRAPH_DIAG: ${JSON.stringify(fields)}`);
}

async function acquireDraftToken(userId, getAccessToken) {
  try {
    return await getAccessToken(userId);
  } catch (error) {
    if (error?.statusCode === 404) {
      throw Object.assign(new Error("Para enviar anexos, conecte sua conta Microsoft Outlook."), {
        statusCode: 422, publicCode: "MICROSOFT_REQUIRED_FOR_ATTACHMENTS",
      });
    }
    throw error;
  }
}

async function ensureGraphResponse(response, acceptedStatuses, attachmentStrategy, attachmentDebug) {
  if (acceptedStatuses.includes(response.status)) return;
  const code = await readGraphErrorCode(response);
  throw graphAttachmentError(response.status, code, attachmentStrategy, attachmentDebug);
}

async function graphDraftFetch(fetchImpl, url, options, deliveryUnknown = false) {
  try {
    return await fetchImpl(url, options);
  } catch {
    const code = deliveryUnknown ? "GRAPH_DELIVERY_UNKNOWN" : "GRAPH_NETWORK_ERROR";
    throw Object.assign(
      new Error(deliveryUnknown
        ? "Não foi possível confirmar se o Microsoft Outlook enviou a resposta."
        : "Não foi possível comunicar com o Microsoft Outlook."),
      {
        statusCode: 502,
        publicCode: code,
        diagnosticCode: code,
        microsoftDiagnosticError: true,
        safeToFallback: false,
      },
    );
  }
}

const FILE_ATTACHMENT_ODATA_TYPE = "#microsoft.graph.fileAttachment";

export function buildMicrosoftFileAttachmentPayload({
  name,
  contentType,
  contentBytes,
  isInline,
  contentId,
}) {
  return {
    "@odata.type": FILE_ATTACHMENT_ODATA_TYPE,
    name,
    contentType,
    contentBytes,
    isInline,
    ...(isInline && contentId ? { contentId } : {}),
  };
}

export function buildSignatureAttachmentPayload({ contentBytes, contentId }) {
  return buildMicrosoftFileAttachmentPayload({
    name: "signature.png",
    contentType: "image/png",
    contentBytes,
    isInline: true,
    contentId,
  });
}

export function buildRegularAttachmentPayload({ name, contentType, contentBytes }) {
  return buildMicrosoftFileAttachmentPayload({
    name,
    contentType,
    contentBytes,
    isInline: false,
  });
}

async function postFileAttachmentToDraft(
  accessToken,
  draftId,
  payload,
  { fetchImpl, timeoutMs, attachmentStrategy, attachmentDebug } = {},
) {
  const response = await graphDraftFetch(fetchImpl,
    `${GRAPH_MESSAGES_URL}${encodeURIComponent(draftId)}/attachments`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  await ensureGraphResponse(response, [201], attachmentStrategy, attachmentDebug);
}

export async function createMicrosoftReplyDraft(
  userId,
  { messageId, html, inlineAttachment },
  { getAccessToken = getValidMicrosoftAccessToken, fetchImpl = globalThis.fetch } = {},
) {
  const accessToken = await acquireDraftToken(userId, getAccessToken);
  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" };
  const createResponse = await graphDraftFetch(fetchImpl,
    `${GRAPH_MESSAGES_URL}${encodeURIComponent(messageId)}/createReply`,
    { method: "POST", headers, signal: AbortSignal.timeout(15000) },
  );
  await ensureGraphResponse(createResponse, [201]);
  const draft = await readResponseJson(createResponse);
  if (typeof draft.id !== "string" || !draft.id) {
    throw graphAttachmentError(502, "MissingDraftId");
  }
  const draftUrl = `${GRAPH_MESSAGES_URL}${encodeURIComponent(draft.id)}`;

  try {
    const patchResponse = await graphDraftFetch(fetchImpl, draftUrl, {
      method: "PATCH", headers,
      body: JSON.stringify({ body: { contentType: "HTML", content: html } }),
      signal: AbortSignal.timeout(15000),
    });
    await ensureGraphResponse(patchResponse, [200]);

    if (inlineAttachment) {
      await postFileAttachmentToDraft(
        accessToken,
        draft.id,
        buildSignatureAttachmentPayload({
          contentBytes: inlineAttachment.contentBytes,
          contentId: SIGNATURE_CONTENT_ID,
        }),
        { fetchImpl, timeoutMs: 15000 },
      );
    }
  } catch (error) {
    try {
      await fetchImpl(draftUrl, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } });
    } catch {}
    throw error;
  }

  return { draftId: draft.id, signatureAdded: Boolean(inlineAttachment) };
}

export async function addMicrosoftDraftFileAttachment(
  userId,
  { draftId, attachment },
  { getAccessToken = getValidMicrosoftAccessToken, fetchImpl = globalThis.fetch } = {},
) {
  const fileBufferPresent = Buffer.isBuffer(attachment?.bytes);
  const fileSizeValid = fileBufferPresent
    && Number.isSafeInteger(attachment?.size)
    && attachment.size === attachment.bytes.length;
  const contentBytes = fileBufferPresent ? attachment.bytes.toString("base64") : "";
  const base64Generated = contentBytes.length > 0
    && !contentBytes.startsWith("data:")
    && Buffer.from(contentBytes, "base64").equals(attachment.bytes);
  const diagnostic = {
    strategy: "small",
    draft_exists: typeof draftId === "string" && draftId.length > 0,
    file_buffer_present: fileBufferPresent,
    file_size_valid: fileSizeValid,
    base64_generated: base64Generated,
    attachment_request_started: false,
    attachment_created: false,
  };
  logAttachmentGraphDiagnostic(diagnostic);
  if (!diagnostic.draft_exists || !fileSizeValid || !base64Generated) {
    throw Object.assign(new Error("O arquivo recebido não corresponde ao anexo declarado."), {
      statusCode: 400,
      publicCode: "ATTACHMENT_MISMATCH",
    });
  }

  const accessToken = await acquireDraftToken(userId, getAccessToken);
  const payload = buildRegularAttachmentPayload({
    name: attachment.name,
    contentType: attachment.contentType,
    contentBytes,
  });
  const attachmentDebug = {
    draft_exists: diagnostic.draft_exists,
    draft_sent_before_attachment: false,
    same_draft: true,
    payload_direct_object: true,
    odata_type_matches_signature: payload["@odata.type"] === FILE_ATTACHMENT_ODATA_TYPE,
    buffer_present: fileBufferPresent,
    base64_roundtrip_valid: base64Generated,
  };
  diagnostic.attachment_request_started = true;
  logAttachmentGraphDiagnostic(diagnostic);
  try {
    await postFileAttachmentToDraft(
      accessToken,
      draftId,
      payload,
      { fetchImpl, timeoutMs: 30000, attachmentStrategy: "small", attachmentDebug },
    );
    diagnostic.attachment_created = true;
    logAttachmentGraphDiagnostic(diagnostic);
  } catch (error) {
    logAttachmentGraphDiagnostic(diagnostic);
    throw error;
  }
}

export async function createMicrosoftAttachmentUploadSession(
  userId,
  { draftId, attachment },
  { getAccessToken = getValidMicrosoftAccessToken, fetchImpl = globalThis.fetch } = {},
) {
  const diagnostic = {
    strategy: "large",
    upload_session_created: false,
    chunk_started: false,
    chunk_completed: false,
  };
  logAttachmentGraphDiagnostic(diagnostic);
  const accessToken = await acquireDraftToken(userId, getAccessToken);
  const response = await graphDraftFetch(fetchImpl,
    `${GRAPH_MESSAGES_URL}${encodeURIComponent(draftId)}/attachments/createUploadSession`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        AttachmentItem: {
          attachmentType: "file", name: attachment.name, size: attachment.size, isInline: false,
        },
      }),
      signal: AbortSignal.timeout(15000),
    },
  );
  await ensureGraphResponse(response, [201], "large");
  const session = await readResponseJson(response);
  if (typeof session.uploadUrl !== "string" || !session.uploadUrl) {
    throw graphAttachmentError(502, "MissingUploadUrl");
  }
  diagnostic.upload_session_created = true;
  logAttachmentGraphDiagnostic(diagnostic);
  return {
    uploadUrl: session.uploadUrl,
    expirationDateTime: session.expirationDateTime,
    nextExpectedRanges: Array.isArray(session.nextExpectedRanges) ? session.nextExpectedRanges : ["0-"],
  };
}

export async function listMicrosoftDraftAttachments(
  userId,
  draftId,
  {
    getAccessToken = getValidMicrosoftAccessToken,
    fetchImpl = globalThis.fetch,
    attachmentStrategy,
    attachmentDebug,
  } = {},
) {
  const accessToken = await acquireDraftToken(userId, getAccessToken);
  let url = `${GRAPH_MESSAGES_URL}${encodeURIComponent(draftId)}/attachments?$select=id,name,size,contentType,isInline`;
  const attachments = [];
  for (let page = 0; url && page < 10; page += 1) {
    const response = await graphDraftFetch(fetchImpl, url, {
      headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000),
    });
    await ensureGraphResponse(response, [200], attachmentStrategy, attachmentDebug);
    const data = await readResponseJson(response);
    if (Array.isArray(data.value)) attachments.push(...data.value);
    url = typeof data["@odata.nextLink"] === "string" ? data["@odata.nextLink"] : null;
  }
  return attachments;
}

export async function sendMicrosoftReplyDraft(
  userId,
  draftId,
  { getAccessToken = getValidMicrosoftAccessToken, fetchImpl = globalThis.fetch, attachmentStrategy } = {},
) {
  const accessToken = await acquireDraftToken(userId, getAccessToken);
  const response = await graphDraftFetch(fetchImpl, `${GRAPH_MESSAGES_URL}${encodeURIComponent(draftId)}/send`, {
    method: "POST", headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30000),
  }, true);
  await ensureGraphResponse(response, [202], attachmentStrategy);
}

export async function deleteMicrosoftReplyDraft(
  userId,
  draftId,
  { getAccessToken = getValidMicrosoftAccessToken, fetchImpl = globalThis.fetch } = {},
) {
  const accessToken = await acquireDraftToken(userId, getAccessToken);
  const response = await graphDraftFetch(fetchImpl, `${GRAPH_MESSAGES_URL}${encodeURIComponent(draftId)}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15000),
  });
  await ensureGraphResponse(response, [204, 404]);
}
