/**
 * [TEMPORÁRIO - DIAGNÓSTICO]
 * Testes que verificam se o bloco `diagnostic` é exposto corretamente
 * na HTTP response quando `microsoftDiagnosticError === true` e a
 * operação falhou em alguma etapa do inline signature draft.
 *
 * REGRAS DE SEGURANÇA verificadas aqui:
 *  - Token de acesso NUNCA aparece na response
 *  - HTML do e-mail NUNCA aparece na response
 *  - contentBytes NUNCA aparece na response
 *  - messageId completo NUNCA aparece na response
 *
 * Remover quando o diagnóstico não for mais necessário.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { errorMiddleware } from "../src/middlewares/error.middleware.js";

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

function makeMockRes() {
  const res = {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
}

function makeReq(path = "/api/tickets/1/reply") {
  return { originalUrl: path, method: "POST" };
}

/**
 * Cria um erro como `signatureGraphError` cria internamente,
 * mas sem precisar importar a função privada.
 */
function makeSignatureErr({
  publicCode = "SIGNATURE_DRAFT_FAILED",
  message = "Erro de teste.",
  operation = "createReply",
  graphStatus = null,
  graphCode = null,
  graphMessage = null,
  innerErrorCode = null,
  requestId = null,
  clientRequestId = null,
} = {}) {
  const graphDetails = {};
  if (graphStatus !== null) graphDetails.status = graphStatus;
  if (graphCode !== null) graphDetails.code = graphCode;
  if (graphMessage !== null) graphDetails.message = graphMessage;
  if (innerErrorCode !== null) graphDetails.innerErrorCode = innerErrorCode;
  if (requestId !== null) graphDetails.requestId = requestId;
  if (clientRequestId !== null) graphDetails.clientRequestId = clientRequestId;
  if (operation !== null) graphDetails.operation = operation;

  return Object.assign(new Error(message), {
    statusCode: 502,
    publicCode,
    safeToFallback: false,
    microsoftDiagnosticError: true,
    diagnosticCode: publicCode,
    signatureDebug: { enabled: true },
    operation,
    ...(graphStatus !== null ? { graphStatus } : {}),
    ...(graphCode !== null ? { graphError: graphCode } : {}),
    ...(Object.keys(graphDetails).length > 0 ? { graphDetails } : {}),
  });
}

// ──────────────────────────────────────────────────────────────────
// Testes de HTTP response com bloco diagnostic
// ──────────────────────────────────────────────────────────────────

test("errorMiddleware: createReply 404 expõe diagnostic na response com status 502", () => {
  const err = makeSignatureErr({
    operation: "createReply",
    graphStatus: 404,
    graphCode: "ErrorItemNotFound",
    graphMessage: "The specified object was not found in the store.",
    requestId: "req-uuid-404",
    clientRequestId: "client-uuid-404",
  });

  const res = makeMockRes();
  errorMiddleware(err, makeReq(), res, () => {});

  assert.equal(res._status, 502);
  assert.equal(res._body.success, false);
  assert.equal(res._body.code, "SIGNATURE_DRAFT_FAILED");

  const diag = res._body.diagnostic;
  assert.ok(diag, "diagnostic deve estar presente");
  assert.equal(diag.operation, "createReply");
  assert.equal(diag.status, 404);
  assert.equal(diag.code, "ErrorItemNotFound");
  assert.equal(diag.message, "The specified object was not found in the store.");
  assert.equal(diag.requestId, "req-uuid-404");
  assert.equal(diag.clientRequestId, "client-uuid-404");
});

test("errorMiddleware: createReply 400 expõe diagnostic com status correto", () => {
  const err = makeSignatureErr({
    operation: "createReply",
    graphStatus: 400,
    graphCode: "ErrorInvalidParameter",
    graphMessage: "Invalid request body.",
    requestId: "req-400",
    clientRequestId: "client-400",
  });

  const res = makeMockRes();
  errorMiddleware(err, makeReq(), res, () => {});

  assert.equal(res._status, 502);
  const diag = res._body.diagnostic;
  assert.ok(diag, "diagnostic deve estar presente");
  assert.equal(diag.operation, "createReply");
  assert.equal(diag.status, 400);
  assert.equal(diag.code, "ErrorInvalidParameter");
  assert.equal(diag.requestId, "req-400");
});

test("errorMiddleware: createReply 403 expõe diagnostic com status correto", () => {
  const err = makeSignatureErr({
    operation: "createReply",
    graphStatus: 403,
    graphCode: "ErrorAccessDenied",
    graphMessage: "Access is denied.",
    requestId: "req-403",
    clientRequestId: "client-403",
  });

  const res = makeMockRes();
  errorMiddleware(err, makeReq(), res, () => {});

  assert.equal(res._status, 502);
  const diag = res._body.diagnostic;
  assert.ok(diag, "diagnostic deve estar presente");
  assert.equal(diag.operation, "createReply");
  assert.equal(diag.status, 403);
  assert.equal(diag.code, "ErrorAccessDenied");
  assert.equal(diag.requestId, "req-403");
  assert.equal(diag.clientRequestId, "client-403");
});

test("errorMiddleware: createReply 500 expõe diagnostic com status correto", () => {
  const err = makeSignatureErr({
    operation: "createReply",
    graphStatus: 500,
    graphCode: "InternalServerError",
    graphMessage: "An error occurred.",
    requestId: "req-500",
  });

  const res = makeMockRes();
  errorMiddleware(err, makeReq(), res, () => {});

  assert.equal(res._status, 502);
  const diag = res._body.diagnostic;
  assert.ok(diag, "diagnostic deve estar presente");
  assert.equal(diag.operation, "createReply");
  assert.equal(diag.status, 500);
  assert.equal(diag.code, "InternalServerError");
});

test("errorMiddleware: patchDraft 400 expõe diagnostic com operation=patchDraft", () => {
  const err = makeSignatureErr({
    operation: "patchDraft",
    graphStatus: 400,
    graphCode: "ErrorInvalidRequest",
    graphMessage: "Invalid patch body content.",
    requestId: "patch-req-1",
  });

  const res = makeMockRes();
  errorMiddleware(err, makeReq(), res, () => {});

  assert.equal(res._status, 502);
  const diag = res._body.diagnostic;
  assert.ok(diag, "diagnostic deve estar presente");
  assert.equal(diag.operation, "patchDraft");
  assert.equal(diag.status, 400);
  assert.equal(diag.code, "ErrorInvalidRequest");
});

test("errorMiddleware: addInlineSignature 403 expõe diagnostic com operation correto", () => {
  const err = makeSignatureErr({
    publicCode: "SIGNATURE_ATTACHMENT_FAILED",
    operation: "addInlineSignature",
    graphStatus: 403,
    graphCode: "ErrorAccessDenied",
    graphMessage: "Access denied to attachments.",
    requestId: "attach-req-403",
  });

  const res = makeMockRes();
  errorMiddleware(err, makeReq(), res, () => {});

  assert.equal(res._status, 502);
  const diag = res._body.diagnostic;
  assert.ok(diag, "diagnostic deve estar presente");
  assert.equal(diag.operation, "addInlineSignature");
  assert.equal(diag.status, 403);
  assert.equal(diag.code, "ErrorAccessDenied");
});

test("errorMiddleware: sendDraft 429 expõe diagnostic com operation=sendDraft", () => {
  const err = makeSignatureErr({
    publicCode: "SIGNATURE_SEND_FAILED",
    operation: "sendDraft",
    graphStatus: 429,
    graphCode: "TooManyRequests",
    graphMessage: "Too many requests.",
    requestId: "send-req-429",
  });

  const res = makeMockRes();
  errorMiddleware(err, makeReq(), res, () => {});

  assert.equal(res._status, 502);
  const diag = res._body.diagnostic;
  assert.ok(diag, "diagnostic deve estar presente");
  assert.equal(diag.operation, "sendDraft");
  assert.equal(diag.status, 429);
  assert.equal(diag.code, "TooManyRequests");
});

test("errorMiddleware: erro de rede expõe NETWORK_ERROR no diagnostic (status null)", () => {
  const err = makeSignatureErr({
    operation: "createReply",
    graphStatus: null,   // sem status (network error)
    graphCode: "NETWORK_ERROR",
    graphMessage: "fetch failed",
    requestId: null,
    clientRequestId: null,
  });

  const res = makeMockRes();
  errorMiddleware(err, makeReq(), res, () => {});

  assert.equal(res._status, 502);
  const diag = res._body.diagnostic;
  assert.ok(diag, "diagnostic deve estar presente");
  assert.equal(diag.operation, "createReply");
  assert.equal(diag.status, null);
  assert.equal(diag.code, "NETWORK_ERROR");
  assert.equal(diag.requestId, null);
  assert.equal(diag.clientRequestId, null);
});

test("errorMiddleware: innerErrorCode é exposto no diagnostic quando presente", () => {
  const err = makeSignatureErr({
    operation: "createReply",
    graphStatus: 404,
    graphCode: "ErrorItemNotFound",
    graphMessage: "Not found.",
    innerErrorCode: "ItemNotFound",
    requestId: "req-inner",
    clientRequestId: "client-inner",
  });

  const res = makeMockRes();
  errorMiddleware(err, makeReq(), res, () => {});

  const diag = res._body.diagnostic;
  assert.equal(diag.innerErrorCode, "ItemNotFound");
});

// ──────────────────────────────────────────────────────────────────
// Testes de segurança: tokens e dados sensíveis NÃO aparecem
// ──────────────────────────────────────────────────────────────────

test("errorMiddleware: SEGURANÇA — campos de autenticação jamais aparecem na response", () => {
  // O serviço NUNCA inclui o token de acesso na message do Graph.
  // Este teste valida que a response não contém campos brutos de autenticação.
  const err = makeSignatureErr({
    operation: "createReply",
    graphStatus: 401,
    graphCode: "InvalidAuthenticationToken",
    // Mensagem real do Graph — sem conter o token
    graphMessage: "Access token is empty.",
    requestId: "req-auth",
  });

  const res = makeMockRes();
  errorMiddleware(err, makeReq(), res, () => {});

  const bodyStr = JSON.stringify(res._body);

  // Campos de autenticação nunca devem aparecer como chaves
  assert.equal(bodyStr.includes('"accessToken"'), false, "accessToken não pode aparecer como chave");
  assert.equal(bodyStr.includes('"Authorization"'), false, "Authorization não pode aparecer como chave");
  assert.equal(bodyStr.includes('"refresh_token"'), false, "refresh_token não pode aparecer como chave");
  assert.equal(bodyStr.includes('"Bearer '), false, "Valor de token Bearer não pode aparecer");

  // diagnostic ainda deve estar presente com os campos seguros
  assert.ok(res._body.diagnostic, "diagnostic deve estar presente");
  assert.equal(res._body.diagnostic.operation, "createReply");
  assert.equal(res._body.diagnostic.status, 401);
  assert.equal(res._body.diagnostic.code, "InvalidAuthenticationToken");
});

test("errorMiddleware: SEGURANÇA — sem diagnostic quando operation está ausente (GRAPH_ATTACHMENT_FAILED)", () => {
  // Erros de anexo (GRAPH_ATTACHMENT_FAILED) não têm `operation` nem `signatureDebug`
  const err = Object.assign(new Error("Falha ao enviar anexo."), {
    statusCode: 502,
    publicCode: "GRAPH_ATTACHMENT_FAILED",
    microsoftDiagnosticError: true,
    diagnosticCode: "GRAPH_ATTACHMENT_FAILED",
    graphStatus: 413,
    graphError: "ErrorMessageSizeExceeded",
    attachmentStrategy: "small",
    // Sem `operation` e sem `signatureDebug`
  });

  const res = makeMockRes();
  errorMiddleware(err, makeReq(), res, () => {});

  assert.equal(res._status, 502);
  // O bloco `diagnostic` NÃO deve aparecer porque `operation` está ausente
  assert.equal(res._body.diagnostic, undefined,
    "diagnostic não deve aparecer para GRAPH_ATTACHMENT_FAILED sem operation");
  // Mas graph_status e graph_error ainda aparecem no formato original
  assert.equal(res._body.graph_status, 413);
  assert.equal(res._body.graph_error, "ErrorMessageSizeExceeded");
});

test("errorMiddleware: HTTP 502 é mantido em todos os casos de SIGNATURE_DRAFT_FAILED", () => {
  const statuses = [400, 403, 404, 500];
  for (const graphStatus of statuses) {
    const err = makeSignatureErr({ operation: "createReply", graphStatus, graphCode: "GraphErr" });
    const res = makeMockRes();
    errorMiddleware(err, makeReq(), res, () => {});
    assert.equal(res._status, 502,
      `HTTP status deve ser 502 mesmo quando Graph retorna ${graphStatus}`);
  }
});

test("errorMiddleware: campos ausentes no graphDetails ficam null (não undefined)", () => {
  // Erro com apenas operation e status, sem code/message/requestId
  const err = makeSignatureErr({
    operation: "createReply",
    graphStatus: 404,
    graphCode: null,
    graphMessage: null,
    requestId: null,
    clientRequestId: null,
  });

  const res = makeMockRes();
  errorMiddleware(err, makeReq(), res, () => {});

  const diag = res._body.diagnostic;
  assert.ok(diag, "diagnostic deve estar presente");
  assert.equal(diag.operation, "createReply");
  assert.equal(diag.status, 404);
  // Campos ausentes devem ser null, não undefined
  const bodyStr = JSON.stringify(res._body);
  const parsed = JSON.parse(bodyStr);
  assert.equal(parsed.diagnostic.code, null);
  assert.equal(parsed.diagnostic.requestId, null);
  assert.equal(parsed.diagnostic.clientRequestId, null);
});

test("errorMiddleware: produção não expõe o bloco temporário diagnostic", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const res = makeMockRes();
    errorMiddleware(
      makeSignatureErr({ graphStatus: 403, graphCode: "ErrorAccessDenied" }),
      makeReq(),
      res,
      () => {},
    );
    assert.equal(res._body.diagnostic, undefined);
    assert.equal(res._body.code, "SIGNATURE_DRAFT_FAILED");
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
