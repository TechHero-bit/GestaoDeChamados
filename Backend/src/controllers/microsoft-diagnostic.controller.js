/**
 * CONTROLLER TEMPORÁRIO — Diagnóstico Microsoft Graph / Shared Mailbox
 * =====================================================================
 * Objetivo: Verificar, em produção na Vercel, se o backend consegue:
 *   1. Encontrar a conexão Microsoft do usuário no Supabase.
 *   2. Descriptografar o token usando MICROSOFT_TOKEN_ENCRYPTION_KEY existente.
 *   3. Obter access token válido via getValidMicrosoftAccessToken.
 *   4. Inspecionar claims do JWT em memória sem expor o token.
 *   5. Consultar /me (se token delegado) e a mensagem na caixa compartilhada.
 *
 * Segurança:
 *   - NUNCA retorna tokens, secrets, refresh_token ou credenciais.
 *   - NUNCA loga tokens ou secrets nos logs da Vercel.
 *   - messageId é mascarado nos logs (apenas primeiros/últimos caracteres).
 *   - Protegido por header x-diagnostic-secret (ver diagnostic-auth.middleware.js).
 *   - JWT é decodificado APENAS em memória; o payload bruto é descartado.
 *
 * ⚠️  REMOVER após conclusão do diagnóstico.
 */

import { getValidMicrosoftAccessToken } from "../services/microsoft-oauth.service.js";

const SHARED_MAILBOX = "suporte@centaurotelecom.com.br";

// Claims de audience que identificam o Microsoft Graph
const GRAPH_AUDIENCES = [
  "https://graph.microsoft.com",
  "https://graph.microsoft.com/",
  "00000003-0000-0000-c000-000000000000", // Graph app ID (app-only)
];

// Permissões de aplicativo reconhecidas
const APPLICATION_MAIL_ROLES = new Set([
  "Mail.Read",
  "Mail.ReadBasic",
  "Mail.ReadWrite",
  "Mail.Send",
  "Mail.ReadWrite.All",
  "Mail.Read.All",
]);

// ── Helpers ────────────────────────────────────────────────────────────────────

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

// ── JWT claim inspection ───────────────────────────────────────────────────────

/**
 * Decodifica APENAS o payload de um JWT em memória para inspeção diagnóstica.
 * Não valida assinatura — o token já foi obtido pelo serviço OAuth existente.
 * O token bruto nunca sai dessa função; apenas as claims selecionadas são retornadas.
 *
 * @param {string} token  Access token obtido pelo serviço OAuth.
 * @returns {{ claims: object|null, error: string|null }}
 */
export function decodeJwtPayloadSafely(token) {
  try {
    if (typeof token !== "string") return { claims: null, error: "token_not_string" };
    const parts = token.split(".");
    if (parts.length < 2) return { claims: null, error: "not_jwt_format" };

    // Decodifica o payload (índice 1) sem validar assinatura
    const payloadB64 = parts[1];
    // Buffer.from aceita base64url a partir do Node.js 14+
    const payloadJson = Buffer.from(payloadB64, "base64url").toString("utf8");
    const claims = JSON.parse(payloadJson);

    if (typeof claims !== "object" || claims === null) {
      return { claims: null, error: "payload_not_object" };
    }
    return { claims, error: null };
  } catch {
    return { claims: null, error: "decode_failed" };
  }
}

/**
 * Extrai somente as claims não-secretas relevantes e constrói o bloco tokenClaims.
 * NUNCA inclui o payload bruto completo na resposta.
 *
 * @param {object} claims  Objeto de claims decodificado do JWT.
 * @returns {object}  tokenClaims seguro para retornar ao diagnóstico.
 */
export function buildTokenClaims(claims) {
  if (!claims || typeof claims !== "object") {
    return { tokenType: "unknown", hasScopes: false, hasRoles: false };
  }

  const rawScp = claims.scp;
  const rawRoles = claims.roles;

  const hasScopes = typeof rawScp === "string" && rawScp.trim().length > 0;
  const hasRoles = Array.isArray(rawRoles) && rawRoles.length > 0;

  // Determinar tipo de token
  let tokenType;
  if (hasScopes && !hasRoles) tokenType = "delegated";
  else if (hasRoles && !hasScopes) tokenType = "application";
  else if (hasScopes && hasRoles) tokenType = "delegated_with_roles";
  else tokenType = "unknown";

  // Scopes: string separada por espaço → array sanitizado
  const scopes = hasScopes
    ? rawScp.split(" ").map((s) => s.trim()).filter(Boolean)
    : [];

  // Roles: já é array; filtra apenas strings
  const roles = hasRoles
    ? rawRoles.filter((r) => typeof r === "string").map((r) => r.trim())
    : [];

  // Audience
  const aud =
    typeof claims.aud === "string"
      ? claims.aud.slice(0, 200)
      : Array.isArray(claims.aud)
        ? claims.aud.filter((a) => typeof a === "string").join(",").slice(0, 200)
        : null;

  const result = {
    tokenType,
    aud: aud ?? null,
    tenantId: typeof claims.tid === "string" ? claims.tid : null,
    appId:
      typeof claims.appid === "string"
        ? claims.appid
        : typeof claims.azp === "string"
          ? claims.azp
          : null,
    scopes,
    roles,
  };

  // Dados de identidade do usuário (apenas se delegado)
  if (tokenType === "delegated" || tokenType === "delegated_with_roles") {
    result.user = {
      oid: typeof claims.oid === "string" ? claims.oid : null,
      upn: typeof claims.upn === "string" ? claims.upn : null,
      preferredUsername:
        typeof claims.preferred_username === "string"
          ? claims.preferred_username
          : null,
    };
  }

  return result;
}

/**
 * Analisa as permissões presentes no token e verifica o audience.
 *
 * @param {object} tokenClaims  Resultado de buildTokenClaims.
 * @returns {object}  permissionAnalysis seguro para retornar ao diagnóstico.
 */
export function buildPermissionAnalysis(tokenClaims) {
  const { tokenType, aud, scopes, roles } = tokenClaims;

  // Verificar se audience parece ser o Microsoft Graph
  const audienceLooksLikeGraph =
    typeof aud === "string" &&
    GRAPH_AUDIENCES.some((g) => aud.includes(g));

  const analysis = {
    tokenType,
    audienceLooksLikeGraph,
  };

  if (tokenType === "delegated" || tokenType === "delegated_with_roles") {
    const scopeSet = new Set(scopes);
    analysis.hasMailRead = scopeSet.has("Mail.Read");
    analysis.hasMailReadBasic = scopeSet.has("Mail.ReadBasic");
    analysis.hasMailReadWrite = scopeSet.has("Mail.ReadWrite");
    analysis.hasMailSend = scopeSet.has("Mail.Send");
    analysis.hasApplicationMailPermissions = false;
  }

  if (tokenType === "application" || tokenType === "delegated_with_roles") {
    const roleSet = new Set(roles);
    const hasAnyAppMailRole = [...APPLICATION_MAIL_ROLES].some((r) => roleSet.has(r));
    analysis.hasApplicationMailPermissions = hasAnyAppMailRole;
    if (tokenType === "application") {
      analysis.hasMailRead =
        roleSet.has("Mail.Read") || roleSet.has("Mail.Read.All");
      analysis.hasMailReadBasic = roleSet.has("Mail.ReadBasic");
      analysis.hasMailReadWrite =
        roleSet.has("Mail.ReadWrite") || roleSet.has("Mail.ReadWrite.All");
      analysis.hasMailSend = roleSet.has("Mail.Send");
    }
  }

  return analysis;
}

// ── /me query ─────────────────────────────────────────────────────────────────

/**
 * Consulta GET /me no Microsoft Graph e retorna apenas campos seguros.
 * Só deve ser chamado para tokens delegados.
 *
 * @param {string} accessToken  Token de acesso (usado e descartado internamente).
 * @returns {object}  Resultado seguro da consulta /me.
 */
export async function queryGraphMe(accessToken, { fetchImpl = globalThis.fetch } = {}) {
  const meUrl =
    "https://graph.microsoft.com/v1.0/me?$select=id,displayName,userPrincipalName,mail";

  let meResponse;
  try {
    meResponse = await fetchImpl(meUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return {
      attempted: true,
      success: false,
      status: null,
      code: "NETWORK_ERROR",
      message: err?.message?.slice(0, 200) ?? "Erro de rede.",
      requestId: null,
    };
  }

  const meBody = await safeReadJson(meResponse);
  const { code, message, requestId } = extractGraphError(meBody, meResponse);

  if (meResponse.status === 200) {
    return {
      attempted: true,
      success: true,
      status: 200,
      requestId: requestId ?? null,
      user: {
        id: typeof meBody.id === "string" ? meBody.id : null,
        displayName:
          typeof meBody.displayName === "string"
            ? meBody.displayName.slice(0, 200)
            : null,
        userPrincipalName:
          typeof meBody.userPrincipalName === "string"
            ? meBody.userPrincipalName.slice(0, 200)
            : null,
        mail:
          typeof meBody.mail === "string" ? meBody.mail.slice(0, 200) : null,
      },
    };
  }

  return {
    attempted: true,
    success: false,
    status: meResponse.status,
    code: code ?? null,
    message: message ?? null,
    requestId: requestId ?? null,
  };
}

// ── Controller principal ───────────────────────────────────────────────────────

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

  // ── Estágio 2: Inspecionar claims do JWT em memória ─────────────────────────
  console.log(`[MICROSOFT_DIAG] stage=token.claims`);

  const { claims, error: decodeError } = decodeJwtPayloadSafely(accessToken);

  let tokenClaims;
  let permissionAnalysis;

  if (claims) {
    tokenClaims = buildTokenClaims(claims);
    permissionAnalysis = buildPermissionAnalysis(tokenClaims);

    // Logs seguros — NUNCA inclui token, access_token, Bearer, refresh_token, clientSecret
    console.log(`[MICROSOFT_DIAG] tokenType=${tokenClaims.tokenType}`);
    console.log(`[MICROSOFT_DIAG] hasScopes=${tokenClaims.scopes.length > 0}`);
    console.log(`[MICROSOFT_DIAG] hasRoles=${tokenClaims.roles.length > 0}`);
    console.log(
      `[MICROSOFT_DIAG] graphAudience=${permissionAnalysis.audienceLooksLikeGraph}`,
    );
  } else {
    // Token opaco ou formato inesperado — raro para Microsoft Graph mas possível
    console.log(`[MICROSOFT_DIAG] tokenClaims=undecodable reason=${decodeError}`);
    tokenClaims = { tokenType: "unknown", hasScopes: false, hasRoles: false, decodeError };
    permissionAnalysis = { tokenType: "unknown", audienceLooksLikeGraph: null };
  }

  // ── Estágio 3: Consultar /me (somente para tokens delegados) ────────────────
  let meResult = null;
  const isDelegated =
    tokenClaims.tokenType === "delegated" ||
    tokenClaims.tokenType === "delegated_with_roles";

  if (isDelegated) {
    console.log(`[MICROSOFT_DIAG] stage=me.request`);
    meResult = await queryGraphMe(accessToken);
    console.log(
      `[MICROSOFT_DIAG] stage=me.response status=${meResult.status ?? "null"}` +
        ` success=${meResult.success}`,
    );
  } else {
    console.log(
      `[MICROSOFT_DIAG] stage=me.skipped reason=tokenType=${tokenClaims.tokenType}`,
    );
  }

  // ── Estágio 4: Consultar Microsoft Graph (shared mailbox) ───────────────────
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
      tokenClaims,
      permissionAnalysis,
      me: meResult,
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

  // ── Estágio 5: Processar resposta do Graph ──────────────────────────────────
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
      tokenClaims,
      permissionAnalysis,
      me: meResult,
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
    tokenClaims,
    permissionAnalysis,
    me: meResult,
    graph: {
      status: graphResponse.status,
      success: false,
      code: graphCode,
      message: graphMessage,
      requestId: requestId ?? null,
    },
  });
}
