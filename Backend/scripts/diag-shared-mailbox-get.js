/**
 * SCRIPT DE DIAGNÓSTICO — GET shared mailbox message
 * =====================================================
 * Objetivo: Testar se o token OAuth atual consegue ler
 * uma mensagem na shared mailbox via:
 *   GET /users/suporte@centaurotelecom.com.br/messages/{messageId}
 *
 * Uso:
 *   DIAG_USER_ID=<uuid-do-usuario>  \
 *   DIAG_MESSAGE_ID=<messageId>     \
 *   node scripts/diag-shared-mailbox-get.js
 *
 * Segurança:
 *   - O access_token NUNCA é impresso.
 *   - Apenas status HTTP, código de erro Graph e requestId são registrados.
 *   - Nenhum dado é persistido, alterado ou enviado para terceiros.
 *   - Nenhum token é renovado ou modificado.
 *   - Este script é somente-leitura e não altera produção.
 */

import "dotenv/config";
import { getValidMicrosoftAccessToken } from "../src/services/microsoft-oauth.service.js";

const SHARED_MAILBOX = "suporte@centaurotelecom.com.br";

// ── Parâmetros obrigatórios ──────────────────────────────────────────────────
const userId    = process.env.DIAG_USER_ID?.trim();
const messageId = process.env.DIAG_MESSAGE_ID?.trim();

if (!userId || !messageId) {
  console.error("Uso: DIAG_USER_ID=<uuid> DIAG_MESSAGE_ID=<id> node scripts/diag-shared-mailbox-get.js");
  process.exit(1);
}

// ── Helpers de log seguro ────────────────────────────────────────────────────
function safeField(value, maxLen = 120) {
  if (value == null) return "(ausente)";
  return String(value).replace(/[^\w\s.,;:@\-()[\]{}=]/g, "_").slice(0, maxLen);
}

function logDiag(fields) {
  const line = Object.entries(fields)
    .map(([k, v]) => `${k}=${safeField(v)}`)
    .join("\n");
  console.log(`\nMICROSOFT_GRAPH_DIAGNOSTIC\n${line}`);
}

// ── Leitura do error body do Graph ──────────────────────────────────────────
async function readGraphError(response) {
  const requestId = response.headers?.get?.("request-id") ||
                    response.headers?.get?.("x-ms-request-id") || null;
  let code, message;
  try {
    const clone  = typeof response.clone === "function" ? response.clone() : response;
    const body   = await clone.json();
    const errObj = body?.error;
    if (errObj && typeof errObj === "object") {
      code    = typeof errObj.code    === "string" ? errObj.code.trim()    : undefined;
      message = typeof errObj.message === "string" ? errObj.message.trim() : undefined;
    }
  } catch {
    // body não era JSON
  }
  return { code, message, requestId };
}

// ── Diagnóstico principal ────────────────────────────────────────────────────
async function main() {
  console.log("=".repeat(60));
  console.log("  SmartDesk — Diagnóstico GET shared mailbox message");
  console.log("=".repeat(60));
  console.log(`  shared_mailbox : ${SHARED_MAILBOX}`);
  console.log(`  userId         : ${userId}`);
  // messageId pode ser longo — exibe parcialmente para segurança
  const safeMessageId = messageId.length > 30
    ? `${messageId.slice(0, 15)}...[len=${messageId.length}]`
    : messageId;
  console.log(`  messageId      : ${safeMessageId}`);
  console.log("=".repeat(60));

  // 1. Obter o access token EXATAMENTE como o fluxo de reply faz
  let accessToken;
  try {
    accessToken = await getValidMicrosoftAccessToken(userId);
    // ⚠️  NÃO imprimir accessToken — apenas confirmar obtenção
    console.log("\n[token] Obtido com sucesso. NÃO será impresso.");
  } catch (err) {
    console.error(`\n[ERRO] Falha ao obter access token: ${err.message}`);
    console.error(`       statusCode=${err.statusCode ?? "?"} diagnosticCode=${err.diagnosticCode ?? "?"}`);
    process.exit(1);
  }

  // 2. GET /users/{shared-mailbox}/messages/{messageId}
  const url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(SHARED_MAILBOX)}` +
    `/messages/${encodeURIComponent(messageId)}` +
    `?$select=id,subject,from,receivedDateTime,conversationId`;

  console.log("\n[GET] Iniciando chamada ao Microsoft Graph...");

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    logDiag({
      operation : "diagnostic_get_shared_message",
      status    : "network_error",
      message   : err?.message || "Erro de rede",
    });
    process.exit(1);
  } finally {
    // Garantia: accessToken não pode vazar após uso
    accessToken = null;
  }

  // 3. Processar resultado
  const { code, message, requestId } = await readGraphError(response);

  logDiag({
    operation : "diagnostic_get_shared_message",
    status    : response.status,
    ...(code      ? { code }      : {}),
    ...(message   ? { message }   : {}),
    ...(requestId ? { requestId } : {}),
  });

  // 4. Resumo comparativo
  console.log("\n" + "─".repeat(60));
  console.log("  COMPARAÇÃO");
  console.log("─".repeat(60));

  if (response.status === 200) {
    console.log("  GET /users/.../messages/{id}   → ✅ 200 OK  (mensagem acessível)");
    console.log("  POST createReply               → ❌ 403 ErrorAccessDenied");
    console.log("\n  CONCLUSÃO: O token lê a mensagem mas não pode criar reply.");
    console.log("  Isso indica que Mail.ReadWrite (ou .Shared) é necessário para WRITE,");
    console.log("  enquanto apenas Mail.Read (ou acesso Exchange direto) bastou para GET.");
    console.log("  Ação: adicionar Mail.ReadWrite.Shared e reconsentir o OAuth.");
  } else if (response.status === 403) {
    console.log("  GET /users/.../messages/{id}   → ❌ 403 " + (code ?? "ErrorAccessDenied"));
    console.log("  POST createReply               → ❌ 403 ErrorAccessDenied");
    console.log("\n  CONCLUSÃO: O token NÃO tem acesso nem para leitura na shared mailbox.");
    console.log("  Isso confirma que o scope Mail.ReadWrite.Shared está ausente,");
    console.log("  afetando tanto GET quanto POST via /users/suporte@.../.");
    console.log("  Ação: adicionar Mail.ReadWrite.Shared e forçar novo consentimento.");
  } else if (response.status === 404) {
    console.log("  GET /users/.../messages/{id}   → ⚠️  404 Not Found");
    console.log("  POST createReply               → ❌ 403 ErrorAccessDenied");
    console.log("\n  CONCLUSÃO: O token acessa a shared mailbox (sem 403),");
    console.log("  mas o messageId não foi encontrado lá.");
    console.log("  Possível causa: a mensagem existe em /me/ (caixa do OAuth user),");
    console.log("  não em /users/suporte@.../. Verificar origem do messageId.");
  } else {
    console.log(`  GET /users/.../messages/{id}   → ⚠️  ${response.status} ${code ?? ""}`);
    console.log("  POST createReply               → ❌ 403 ErrorAccessDenied");
    console.log("\n  CONCLUSÃO: Resultado inesperado — analisar detalhes acima.");
  }

  console.log("─".repeat(60));
  console.log("  Diagnóstico concluído. Nenhum dado foi alterado.");
  console.log("─".repeat(60) + "\n");
}

main().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
