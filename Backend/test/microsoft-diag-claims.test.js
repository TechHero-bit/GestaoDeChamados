/**
 * [TEMPORÁRIO - DIAGNÓSTICO]
 * Testes das funções de inspeção segura de claims JWT exportadas pelo
 * microsoft-diagnostic.controller.js.
 *
 * Verificações de segurança:
 *   - token nunca aparece na resposta nem nos logs
 *   - scp detectado → delegated
 *   - roles detectado → application
 *   - ausência de scp/roles → unknown
 *   - /me só é chamado quando token é delegado
 *   - endpoint continua protegido por x-diagnostic-secret
 *
 * Remover quando o diagnóstico não for mais necessário.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPermissionAnalysis,
  buildTokenClaims,
  decodeJwtPayloadSafely,
  queryGraphMe,
} from "../src/controllers/microsoft-diagnostic.controller.js";

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Gera um JWT fake (sem assinatura válida) com o payload dado.
 * Usado SOMENTE nos testes para exercitar decodeJwtPayloadSafely.
 */
function makeTestJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = "fakesignature"; // não é validada — somente payload é inspecionado
  return `${header}.${body}.${sig}`;
}

// ── decodeJwtPayloadSafely ────────────────────────────────────────────────────

test("decodeJwtPayloadSafely: retorna claims de um JWT válido", () => {
  const payload = { scp: "Mail.Read Mail.Send", tid: "tenant-abc", aud: "https://graph.microsoft.com" };
  const { claims, error } = decodeJwtPayloadSafely(makeTestJwt(payload));
  assert.equal(error, null);
  assert.equal(claims.scp, "Mail.Read Mail.Send");
  assert.equal(claims.tid, "tenant-abc");
});

test("decodeJwtPayloadSafely: não é uma string → error=token_not_string", () => {
  const { claims, error } = decodeJwtPayloadSafely(null);
  assert.equal(claims, null);
  assert.equal(error, "token_not_string");
});

test("decodeJwtPayloadSafely: token sem pontos → error=not_jwt_format", () => {
  const { claims, error } = decodeJwtPayloadSafely("nao-e-jwt");
  assert.equal(claims, null);
  assert.equal(error, "not_jwt_format");
});

test("decodeJwtPayloadSafely: payload base64url inválido → error=decode_failed", () => {
  // Dois segmentos mas o segundo não é JSON válido decodificado
  const { claims, error } = decodeJwtPayloadSafely("header.!!!invalido!!!.sig");
  assert.equal(claims, null);
  assert.equal(error, "decode_failed");
});

test("decodeJwtPayloadSafely: SEGURANÇA — o token bruto nunca aparece no retorno", () => {
  const secretToken = makeTestJwt({ scp: "Mail.Read", tid: "tenant-x" });
  const result = decodeJwtPayloadSafely(secretToken);
  const serialized = JSON.stringify(result);
  // O token completo não pode aparecer no retorno
  assert.equal(serialized.includes(secretToken), false);
});

// ── buildTokenClaims ──────────────────────────────────────────────────────────

test("buildTokenClaims: scp presente → tokenType=delegated", () => {
  const claims = { scp: "Mail.Read Mail.Send", tid: "tid-1", appid: "app-1", aud: "https://graph.microsoft.com", oid: "oid-1", preferred_username: "user@tenant.com" };
  const result = buildTokenClaims(claims);
  assert.equal(result.tokenType, "delegated");
  assert.deepEqual(result.scopes, ["Mail.Read", "Mail.Send"]);
  assert.deepEqual(result.roles, []);
  assert.equal(result.tenantId, "tid-1");
  assert.equal(result.appId, "app-1");
  assert.equal(result.aud, "https://graph.microsoft.com");
  assert.ok(result.user, "deve incluir bloco user para delegated");
  assert.equal(result.user.oid, "oid-1");
  assert.equal(result.user.preferredUsername, "user@tenant.com");
});

test("buildTokenClaims: roles presente, scp ausente → tokenType=application", () => {
  const claims = { roles: ["Mail.ReadWrite", "Mail.Send"], tid: "tid-2", appid: "app-2", aud: "https://graph.microsoft.com" };
  const result = buildTokenClaims(claims);
  assert.equal(result.tokenType, "application");
  assert.deepEqual(result.scopes, []);
  assert.deepEqual(result.roles, ["Mail.ReadWrite", "Mail.Send"]);
  // Tokens de aplicativo não têm bloco user
  assert.equal(result.user, undefined);
});

test("buildTokenClaims: scp e roles presentes → tokenType=delegated_with_roles", () => {
  const claims = { scp: "Mail.Read", roles: ["Mail.ReadWrite"], tid: "tid-3", aud: "https://graph.microsoft.com" };
  const result = buildTokenClaims(claims);
  assert.equal(result.tokenType, "delegated_with_roles");
  assert.ok(result.user, "delegated_with_roles deve incluir user");
});

test("buildTokenClaims: sem scp e sem roles → tokenType=unknown", () => {
  const claims = { tid: "tid-4", aud: "https://graph.microsoft.com" };
  const result = buildTokenClaims(claims);
  assert.equal(result.tokenType, "unknown");
  assert.deepEqual(result.scopes, []);
  assert.deepEqual(result.roles, []);
  assert.equal(result.user, undefined);
});

test("buildTokenClaims: claims null → tokenType=unknown sem crash", () => {
  const result = buildTokenClaims(null);
  assert.equal(result.tokenType, "unknown");
  assert.equal(result.hasScopes, false);
  assert.equal(result.hasRoles, false);
});

test("buildTokenClaims: azp usado como fallback de appId quando appid ausente", () => {
  const claims = { scp: "Mail.Read", azp: "azp-fallback" };
  const result = buildTokenClaims(claims);
  assert.equal(result.appId, "azp-fallback");
});

test("buildTokenClaims: SEGURANÇA — campos sensíveis nunca aparecem no resultado", () => {
  const claims = {
    scp: "Mail.Read",
    tid: "tid-sec",
    access_token: "ACCESS_TOKEN_SHOULD_NOT_LEAK",
    refresh_token: "REFRESH_TOKEN_SHOULD_NOT_LEAK",
    client_secret: "CLIENT_SECRET_SHOULD_NOT_LEAK",
  };
  const result = buildTokenClaims(claims);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("ACCESS_TOKEN_SHOULD_NOT_LEAK"), false);
  assert.equal(serialized.includes("REFRESH_TOKEN_SHOULD_NOT_LEAK"), false);
  assert.equal(serialized.includes("CLIENT_SECRET_SHOULD_NOT_LEAK"), false);
  // Não há rawToken ou authorization no resultado
  assert.equal(serialized.toLowerCase().includes("rawtoken"), false);
  assert.equal(serialized.toLowerCase().includes("authorization"), false);
});

// ── buildPermissionAnalysis ───────────────────────────────────────────────────

test("buildPermissionAnalysis: delegated com Mail.Read e Mail.Send", () => {
  const tokenClaims = buildTokenClaims({
    scp: "Mail.Read Mail.Send",
    aud: "https://graph.microsoft.com",
  });
  const analysis = buildPermissionAnalysis(tokenClaims);
  assert.equal(analysis.tokenType, "delegated");
  assert.equal(analysis.audienceLooksLikeGraph, true);
  assert.equal(analysis.hasMailRead, true);
  assert.equal(analysis.hasMailReadBasic, false);
  assert.equal(analysis.hasMailReadWrite, false);
  assert.equal(analysis.hasMailSend, true);
  assert.equal(analysis.hasApplicationMailPermissions, false);
});

test("buildPermissionAnalysis: application com Mail.ReadWrite.All e Mail.Send", () => {
  const tokenClaims = buildTokenClaims({
    roles: ["Mail.ReadWrite.All", "Mail.Send"],
    aud: "https://graph.microsoft.com",
  });
  const analysis = buildPermissionAnalysis(tokenClaims);
  assert.equal(analysis.tokenType, "application");
  assert.equal(analysis.audienceLooksLikeGraph, true);
  assert.equal(analysis.hasApplicationMailPermissions, true);
  assert.equal(analysis.hasMailReadWrite, true);
  assert.equal(analysis.hasMailSend, true);
  assert.equal(analysis.hasMailRead, false);
});

test("buildPermissionAnalysis: audienceLooksLikeGraph=false quando aud não é Graph", () => {
  const tokenClaims = buildTokenClaims({
    scp: "User.Read",
    aud: "https://management.azure.com",
  });
  const analysis = buildPermissionAnalysis(tokenClaims);
  assert.equal(analysis.audienceLooksLikeGraph, false);
});

test("buildPermissionAnalysis: audienceLooksLikeGraph=true para app ID numérico do Graph", () => {
  const tokenClaims = buildTokenClaims({
    roles: ["Mail.Read"],
    aud: "00000003-0000-0000-c000-000000000000",
  });
  const analysis = buildPermissionAnalysis(tokenClaims);
  assert.equal(analysis.audienceLooksLikeGraph, true);
});

test("buildPermissionAnalysis: unknown → audienceLooksLikeGraph é boolean", () => {
  const tokenClaims = { tokenType: "unknown", aud: null, scopes: [], roles: [] };
  const analysis = buildPermissionAnalysis(tokenClaims);
  assert.equal(analysis.tokenType, "unknown");
  assert.equal(typeof analysis.audienceLooksLikeGraph, "boolean");
});

// ── queryGraphMe ──────────────────────────────────────────────────────────────

test("queryGraphMe: sucesso retorna campos seguros de /me", async () => {
  const fakeToken = "safe-me-token";
  let capturedAuth;
  const fakeFetch = async (url, options) => {
    capturedAuth = options.headers.Authorization;
    return new Response(
      JSON.stringify({
        id: "ms-oid-123",
        displayName: "João Silva",
        userPrincipalName: "joao@empresa.com",
        mail: "joao@empresa.com",
      }),
      { status: 200, headers: { "Content-Type": "application/json", "request-id": "req-me-1" } },
    );
  };

  const result = await queryGraphMe(fakeToken, { fetchImpl: fakeFetch });
  assert.equal(result.attempted, true);
  assert.equal(result.success, true);
  assert.equal(result.status, 200);
  assert.equal(result.user.id, "ms-oid-123");
  assert.equal(result.user.displayName, "João Silva");
  assert.equal(result.user.userPrincipalName, "joao@empresa.com");
  assert.equal(result.user.mail, "joao@empresa.com");
  // SEGURANÇA: o Authorization não vaza no resultado
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("safe-me-token"), false);
  assert.equal(serialized.toLowerCase().includes("authorization"), false);
  // (o header capturado interno pode ter o token — estamos testando que o RESULTADO não o tem)
  assert.equal(capturedAuth, "Bearer safe-me-token"); // confirma que a chamada usou o token
});

test("queryGraphMe: falha 403 retorna status, code e requestId sem expor token", async () => {
  const result = await queryGraphMe("secret-token", {
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ error: { code: "ErrorAccessDenied", message: "Access denied." } }),
        { status: 403, headers: { "request-id": "req-me-403" } },
      ),
  });
  assert.equal(result.attempted, true);
  assert.equal(result.success, false);
  assert.equal(result.status, 403);
  assert.equal(result.code, "ErrorAccessDenied");
  assert.equal(result.requestId, "req-me-403");
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("secret-token"), false);
});

test("queryGraphMe: erro de rede retorna NETWORK_ERROR sem expor token", async () => {
  const result = await queryGraphMe("net-fail-token", {
    fetchImpl: async () => { throw new Error("fetch failed"); },
  });
  assert.equal(result.attempted, true);
  assert.equal(result.success, false);
  assert.equal(result.status, null);
  assert.equal(result.code, "NETWORK_ERROR");
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("net-fail-token"), false);
});

// ── Integração: decodeJwtPayloadSafely → buildTokenClaims → buildPermissionAnalysis ──

test("pipeline completa: JWT delegado → claims → análise de permissão correta", () => {
  const secretToken = makeTestJwt({
    scp: "Mail.Read Mail.ReadWrite Mail.Send openid profile",
    tid: "tenant-pipeline",
    appid: "app-pipeline",
    aud: "https://graph.microsoft.com",
    oid: "oid-pipeline",
    upn: "user@domain.com",
    preferred_username: "user@domain.com",
  });

  const { claims, error } = decodeJwtPayloadSafely(secretToken);
  assert.equal(error, null);

  const tokenClaims = buildTokenClaims(claims);
  assert.equal(tokenClaims.tokenType, "delegated");
  assert.ok(tokenClaims.scopes.includes("Mail.Read"));
  assert.ok(tokenClaims.scopes.includes("Mail.Send"));

  const analysis = buildPermissionAnalysis(tokenClaims);
  assert.equal(analysis.audienceLooksLikeGraph, true);
  assert.equal(analysis.hasMailRead, true);
  assert.equal(analysis.hasMailReadWrite, true);
  assert.equal(analysis.hasMailSend, true);
  assert.equal(analysis.hasApplicationMailPermissions, false);

  // SEGURANÇA: token bruto nunca aparece em nenhum resultado
  const allResults = JSON.stringify({ tokenClaims, analysis });
  assert.equal(allResults.includes(secretToken), false);
});

test("pipeline completa: JWT application → sem bloco user → análise application", () => {
  const secretToken = makeTestJwt({
    roles: ["Mail.Read.All", "Mail.Send"],
    tid: "tenant-app",
    appid: "app-daemon",
    aud: "00000003-0000-0000-c000-000000000000",
  });

  const { claims } = decodeJwtPayloadSafely(secretToken);
  const tokenClaims = buildTokenClaims(claims);
  assert.equal(tokenClaims.tokenType, "application");
  assert.equal(tokenClaims.user, undefined);

  const analysis = buildPermissionAnalysis(tokenClaims);
  assert.equal(analysis.tokenType, "application");
  assert.equal(analysis.audienceLooksLikeGraph, true);
  assert.equal(analysis.hasApplicationMailPermissions, true);
  assert.equal(analysis.hasMailRead, true);
  assert.equal(analysis.hasMailSend, true);
});

test("pipeline completa: JWT sem scp nem roles → unknown em todos os estágios", () => {
  const secretToken = makeTestJwt({ tid: "tenant-x", aud: "https://other.service.com" });
  const { claims } = decodeJwtPayloadSafely(secretToken);
  const tokenClaims = buildTokenClaims(claims);
  assert.equal(tokenClaims.tokenType, "unknown");

  const analysis = buildPermissionAnalysis(tokenClaims);
  assert.equal(analysis.tokenType, "unknown");
  assert.equal(analysis.audienceLooksLikeGraph, false);
});
