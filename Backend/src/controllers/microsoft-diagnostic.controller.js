/**
 * CONTROLLER TEMPORÁRIO — Diagnóstico Microsoft Graph / Shared Mailbox
 * =====================================================================
 * Objetivo: Verificar, em produção na Vercel, se o backend consegue:
 *   1. Encontrar a conexão Microsoft do usuário no Supabase.
 *   2. Descriptografar o token usando MICROSOFT_TOKEN_ENCRYPTION_KEY existente.
 *   3. Obter access token válido via getValidMicrosoftAccessToken.
 *   4. Consultar uma mensagem na caixa compartilhada via Microsoft Graph.
 *
 * Segurança:
 *   - NUNCA retorna tokens, secrets, refresh_token ou credenciais.
 *   - NUNCA loga tokens ou secrets nos logs da Vercel.
 *   - messageId é mascarado nos logs (apenas primeiros/últimos caracteres).
 *   - Protegido por header x-diagnostic-secret (ver diagnostic-auth.middleware.js).
 *
 * ⚠️  REMOVER após conclusão do diagnóstico.
 */

import { getValidMicrosoftAccessToken } from "../services/microsoft-oauth.service.js";

const SHARED_MAILBOX = "suporte@centaurotelecom.com.br";

/**
 * Mascara o messageId para logs: exibe os 8 primeiros e os 8 últimos caracteres.
 * Nunca imprime o ID completo, pois pode conter tokens codificados.
 */
function maskMessageId(id) {
  if (typeof id !== "string" || id.length === 0) return "(ausente)";
  if (id.length <= 20) return `[len=${id.length}]`;
  return `${id.slice(0, 8)}...[len=${id.length}]...${id.slice(-8)}`;
}

/**
 * Lê o body JSON da resposta Graph de forma segura.
 * Retorna o objeto parseado ou {} em caso de falha.
 */
async function safeReadJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

/**
 * Extrai informações de erro e requestId do body e headers da resposta Graph.
 * Recebe o body já parseado para evitar consumir o stream duas vezes.
 */
function extractGraphError(body, response) {
  const requestId =
    response.headers?.get?.("request-id") ||
    response.headers?.get?.("x-ms-request-id") ||
    null;

  const errObj = body?.error;
  let code = null;
  let message = null;

  if (errObj && typeof errObj === "object") {
    code =
      typeof errObj.code === "string" ? errObj.code.trim().slice(0, 100) : null;
    message =
      typeof errObj.message === "string"
        ? errObj.message.trim().slice(0, 500)
        : null;
  }

  return { code, message, requestId };
}

/**
 * Extrai campos públicos e seguros da mensagem (sem conteúdo do e-mail).
 */
function extractSafeMessageFields(body) {
  if (!body || typeof body !== "object") return null;
  return {
    id: typeof body.id === "string" ? body.id.slice(0, 200) : null,
    subject: typeof body.subject === "string" ? body.subject.slice(0, 300) : null,
    from:
      body.from?.emailAddress?.address
        ? String(body.from.emailAddress.address).slice(0, 200)
        : null,
    receivedDateTime:
      typeof body.receivedDateTime === "string"
        ? body.receivedDateTime.slice(0, 50)
        : null,
    conversationId:
      typeof body.conversationId === "string"
        ? body.conversationId.slice(0, 200)
        : null,
  };
}

/**
 * GET /api/diagnostics/microsoft/shared-mailbox-message
 *
 * Query params:
 *   - userId    (string, UUID do usuário com conexão Microsoft no Supabase)
 *   - messageId (string, ID da mensagem no Microsoft Graph)
 */
export async function diagSharedMailboxMessage(req, res) {
  const { userId, messageId } = req.query;

  // ── Validação de entrada ────────────────────────────────────────────────────
  if (typeof userId !== "string" || userId.trim().length === 0) {
    return res.status(400).json({
      success: false,
      message: "Parâmetro userId ausente ou inválido.",
    });
  }

  if (typeof messageId !== "string" || messageId.trim().length === 0) {
    return res.status(400).json({
      success: false,
      message: "Parâmetro messageId ausente ou inválido.",
    });
  }

  const safeUserId = userId.trim();
  const safeMessageId = messageId.trim();
  const maskedMessageId = maskMessageId(safeMessageId);

  // ── Estágio 1: Obter access token ──────────────────────────────────────────
  // Percorre exatamente a mesma cadeia do SmartDesk:
  //   connection.lookup → token.expiration → token.decrypt / token.refresh
  console.log(`[MICROSOFT_DIAG] stage=connection.lookup userId=${safeUserId}`);

  let accessToken;
  try {
    accessToken = await getValidMicrosoftAccessToken(safeUserId);
    // ⚠️  NUNCA imprimir accessToken
    console.log(
      `[MICROSOFT_DIAG] stage=token.obtained userId=${safeUserId} available=true`,
    );
  } catch (err) {
    const diagCode = err.diagnosticCode ?? null;
    const stage = err.microsoftAuthLog?.stage ?? "token.unknown";
    const connectionFound = err.microsoftAuthLog?.connectionFound ?? false;
    const accessTokenExpired = err.microsoftAuthLog?.accessTokenExpired ?? null;

    console.log(
      `[MICROSOFT_DIAG] stage=${stage} userId=${safeUserId}` +
        ` connectionFound=${connectionFound}` +
        ` code=${diagCode ?? "none"}` +
        ` errorMessage=${err.message?.slice(0, 200) ?? ""}`,
    );

    return res.status(200).json({
      success: false,
      failedAt: stage,
      connectionFound,
      token: {
        expired: accessTokenExpired,
        available: false,
      },
      graph: null,
      error: {
        code: diagCode,
        message: err.message?.slice(0, 300) ?? "Erro desconhecido.",
      },
    });
  }

  // ── Estágio 2: Consultar Microsoft Graph ────────────────────────────────────
  const graphUrl =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(SHARED_MAILBOX)}` +
    `/messages/${encodeURIComponent(safeMessageId)}` +
    `?$select=id,subject,from,receivedDateTime,conversationId`;

  console.log(
    `[MICROSOFT_DIAG] stage=graph.request userId=${safeUserId}` +
      ` messageId=${maskedMessageId} sharedMailbox=${SHARED_MAILBOX}`,
  );

  let graphResponse;
  try {
    graphResponse = await fetch(graphUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // Garantia: token não vaza após uso
    accessToken = null;

    console.log(
      `[MICROSOFT_DIAG] stage=graph.request userId=${safeUserId}` +
        ` messageId=${maskedMessageId} networkError=${err?.message?.slice(0, 200)}`,
    );

    return res.status(200).json({
      success: false,
      failedAt: "graph.request",
      connectionFound: true,
      token: { expired: false, available: true },
      graph: {
        status: null,
        success: false,
        code: "NETWORK_ERROR",
        message: err?.message?.slice(0, 200) ?? "Erro de rede ao contactar o Microsoft Graph.",
        requestId: null,
      },
    });
  }

  // Token não é mais necessário — descarta imediatamente
  accessToken = null;

  // ── Estágio 3: Processar resposta do Graph ──────────────────────────────────
  // Lê o body UMA única vez para evitar problemas de stream consumido
  const graphBody = await safeReadJson(graphResponse);
  const { code: graphCode, message: graphMessage, requestId } =
    extractGraphError(graphBody, graphResponse);

  console.log(
    `[MICROSOFT_DIAG] stage=graph.response userId=${safeUserId}` +
      ` messageId=${maskedMessageId}` +
      ` status=${graphResponse.status}` +
      ` code=${graphCode ?? "none"}` +
      ` requestId=${requestId ?? "none"}`,
  );

  if (graphResponse.status === 200) {
    const safeMessage = extractSafeMessageFields(graphBody);

    return res.status(200).json({
      success: true,
      connectionFound: true,
      token: { expired: false, available: true },
      graph: {
        status: 200,
        success: true,
        requestId: requestId ?? null,
        message: safeMessage,
      },
    });
  }

  // Qualquer status !== 200 é tratado como falha do Graph
  return res.status(200).json({
    success: false,
    failedAt: "graph.request",
    connectionFound: true,
    token: { expired: false, available: true },
    graph: {
      status: graphResponse.status,
      success: false,
      code: graphCode,
      message: graphMessage,
      requestId: requestId ?? null,
    },
  });
}
