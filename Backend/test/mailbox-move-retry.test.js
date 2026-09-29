/**
 * Testes para o tratamento especifico de 503 ErrorMailboxMoveInProgress
 * na operacao createReply do Microsoft Graph.
 *
 * Cobre:
 *  1. Retry com backoff e recuperacao na 2a tentativa
 *  2. Retry com backoff e recuperacao na ultima tentativa
 *  3. Falha em todos os retries -> publicCode SIGNATURE_DRAFT_MAILBOX_MOVE
 *  4. 503 com outro codigo -> NAO usa retry, retorna SIGNATURE_DRAFT_FAILED
 *  5. 500 + ErrorMailboxMoveInProgress -> sem retry (status deve ser 503)
 *  6. Seguranca: token nunca aparece nos logs
 *  7. MICROSOFT_GRAPH_DIAGNOSTIC emitido para cada tentativa
 *  8. Sem retry na rota /reply simples (sem inlineAttachment)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { replyToMicrosoftMessage } from "../src/services/microsoft-graph.service.js";

const USER_ID = "00000000-0000-4000-8000-000000000099";
const DUMMY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const INLINE_ATTACHMENT = {
  contentId: "smartdesk-signature",
  contentBytes: DUMMY_PNG_BASE64,
};
const SAFE_HTML = '<div>Resposta</div><br><br><img src="cid:smartdesk-signature">';
const MESSAGE_ID = "AAMkAGV4dGVzdC1tZXNzYWdlLWlk";

function makeMailboxMove503() {
  return new Response(
    JSON.stringify({
      error: {
        code: "ErrorMailboxMoveInProgress",
        message: "Mailbox move in progress. Try again later., Cross Server access is not allowed for mailbox ...",
      },
    }),
    {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "request-id": "req-mailbox-move",
        "client-request-id": "client-mailbox-move",
      },
    },
  );
}

function makeRetryFetch({ failCount = 1, draftId = "draft-retry" } = {}) {
  let createReplyCalls = 0;
  return async (url, options) => {
    if (url.endsWith("/createReply")) {
      createReplyCalls += 1;
      if (createReplyCalls <= failCount) return makeMailboxMove503();
      return new Response(JSON.stringify({ id: draftId }), { status: 201 });
    }
    if (options?.method === "PATCH") return new Response("{}", { status: 200 });
    if (url.endsWith("/attachments")) return new Response("{}", { status: 201 });
    if (url.endsWith("/send")) return new Response("{}", { status: 202 });
    return new Response("{}", { status: 200 });
  };
}

async function withLogs(fn) {
  const logs = [];
  const origInfo = console.info;
  const origError = console.error;
  console.info = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  try {
    const result = await fn();
    return { result, logs: logs.join("\n") };
  } finally {
    console.info = origInfo;
    console.error = origError;
  }
}

test("createReply: recupera na 1a retry apos 503 ErrorMailboxMoveInProgress", async () => {
  const fetchImpl = makeRetryFetch({ failCount: 1 });

  const { result, logs } = await withLogs(() =>
    replyToMicrosoftMessage(
      USER_ID,
      { messageId: MESSAGE_ID, message: "Teste", html: SAFE_HTML, inlineAttachment: INLINE_ATTACHMENT },
      { getAccessToken: async () => "token-ok", fetchImpl },
    ),
  );

  assert.ok(result, "deve retornar resultado");
  assert.ok(logs.includes("ErrorMailboxMoveInProgress"), "log deve mencionar ErrorMailboxMoveInProgress");
  assert.ok(logs.includes("MICROSOFT_GRAPH_DIAGNOSTIC"), "log deve emitir MICROSOFT_GRAPH_DIAGNOSTIC");
  assert.ok(logs.includes("createReply_retry1"), "log deve mencionar retry1");
  assert.ok(logs.includes("MailboxMoveRecovered"), "log deve mencionar recuperacao");
});

test("createReply: recupera na 3a retry apos 3 falhas por ErrorMailboxMoveInProgress", async () => {
  const fetchImpl = makeRetryFetch({ failCount: 3 });

  const { result } = await withLogs(() =>
    replyToMicrosoftMessage(
      USER_ID,
      { messageId: MESSAGE_ID, message: "Teste", html: SAFE_HTML, inlineAttachment: INLINE_ATTACHMENT },
      { getAccessToken: async () => "token-ok", fetchImpl },
    ),
  );

  assert.ok(result, "deve completar com sucesso na 3a retry");
});

test("createReply: retorna SIGNATURE_DRAFT_MAILBOX_MOVE apos esgotar todos os retries", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/createReply")) return makeMailboxMove503();
    return new Response("{}", { status: 200 });
  };

  const { logs } = await withLogs(() =>
    assert.rejects(
      replyToMicrosoftMessage(
        USER_ID,
        { messageId: MESSAGE_ID, message: "Teste", html: SAFE_HTML, inlineAttachment: INLINE_ATTACHMENT },
        { getAccessToken: async () => "token-ok", fetchImpl },
      ),
      (error) => {
        assert.equal(error.publicCode, "SIGNATURE_DRAFT_MAILBOX_MOVE", "deve usar publicCode especifico");
        assert.ok(error.message.includes("movimentação interna"), "mensagem deve mencionar movimentacao interna");
        assert.ok(error.message.includes("alguns minutos"), "mensagem deve sugerir tentar novamente");
        assert.equal(error.graphStatus, 503);
        assert.equal(error.graphError, "ErrorMailboxMoveInProgress");
        assert.equal(error.microsoftDiagnosticError, true);
        assert.equal(error.statusCode, 502);
        return true;
      },
    ),
  );

  assert.ok(logs.includes("createReply_retry1"), "log deve incluir retry 1");
  assert.ok(logs.includes("createReply_retry2"), "log deve incluir retry 2");
  assert.ok(logs.includes("createReply_retry3"), "log deve incluir retry 3");
});

test("createReply: 503 com codigo diferente NAO faz retry e retorna SIGNATURE_DRAFT_FAILED", async () => {
  let createReplyCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/createReply")) {
      createReplyCalls += 1;
      return new Response(
        JSON.stringify({ error: { code: "ServiceUnavailable", message: "Service temporarily unavailable." } }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200 });
  };

  await assert.rejects(
    replyToMicrosoftMessage(
      USER_ID,
      { messageId: MESSAGE_ID, message: "Teste", html: SAFE_HTML, inlineAttachment: INLINE_ATTACHMENT },
      { getAccessToken: async () => "token-ok", fetchImpl },
    ),
    (error) => {
      assert.equal(error.publicCode, "SIGNATURE_DRAFT_FAILED");
      assert.notEqual(error.publicCode, "SIGNATURE_DRAFT_MAILBOX_MOVE");
      return true;
    },
  );

  assert.equal(createReplyCalls, 1, "sem retry para 503 com codigo diferente");
});

test("createReply: 500 + ErrorMailboxMoveInProgress NAO faz retry (status deve ser exatamente 503)", async () => {
  let createReplyCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/createReply")) {
      createReplyCalls += 1;
      return new Response(
        JSON.stringify({ error: { code: "ErrorMailboxMoveInProgress", message: "Mailbox move in progress." } }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200 });
  };

  await assert.rejects(
    replyToMicrosoftMessage(
      USER_ID,
      { messageId: MESSAGE_ID, message: "Teste", html: SAFE_HTML, inlineAttachment: INLINE_ATTACHMENT },
      { getAccessToken: async () => "token-ok", fetchImpl },
    ),
    (error) => {
      assert.equal(error.publicCode, "SIGNATURE_DRAFT_FAILED");
      return true;
    },
  );

  assert.equal(createReplyCalls, 1, "sem retry quando status nao e 503");
});

test("createReply: token de acesso NUNCA aparece nos logs durante retries", async () => {
  const sensitiveToken = "Bearer-super-secret-token-xyz-789";
  const fetchImpl = async (url) => {
    if (url.endsWith("/createReply")) return makeMailboxMove503();
    return new Response("{}", { status: 200 });
  };

  const { logs } = await withLogs(() =>
    assert.rejects(
      replyToMicrosoftMessage(
        USER_ID,
        { messageId: MESSAGE_ID, message: "Teste", html: SAFE_HTML, inlineAttachment: INLINE_ATTACHMENT },
        { getAccessToken: async () => sensitiveToken, fetchImpl },
      ),
    ),
  );

  assert.equal(logs.includes(sensitiveToken), false, "token NUNCA deve aparecer nos logs");
  assert.equal(logs.includes("Bearer-super"), false, "prefixo do token nao deve aparecer nos logs");
});

test("rota /reply simples (sem inlineAttachment): NAO usa retry da assinatura", async () => {
  let replyCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/reply")) {
      replyCalls += 1;
      return new Response(
        JSON.stringify({ error: { code: "ErrorMailboxMoveInProgress", message: "Mailbox move in progress." } }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200 });
  };

  await assert.rejects(
    replyToMicrosoftMessage(
      USER_ID,
      { messageId: MESSAGE_ID, message: "Teste sem assinatura", html: "<div>Sem assinatura</div>" },
      { getAccessToken: async () => "token-ok", fetchImpl },
    ),
    (error) => {
      assert.ok(error, "deve lancar erro");
      return true;
    },
  );

  assert.equal(replyCalls, 1, "rota /reply simples nao deve ter retries");
});

test("createReply: MICROSOFT_GRAPH_DIAGNOSTIC emitido para cada tentativa", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/createReply")) return makeMailboxMove503();
    return new Response("{}", { status: 200 });
  };

  const { logs } = await withLogs(() =>
    assert.rejects(
      replyToMicrosoftMessage(
        USER_ID,
        { messageId: MESSAGE_ID, message: "Teste", html: SAFE_HTML, inlineAttachment: INLINE_ATTACHMENT },
        { getAccessToken: async () => "token-ok", fetchImpl },
      ),
    ),
  );

  const diagnosticCount = (logs.match(/MICROSOFT_GRAPH_DIAGNOSTIC/g) || []).length;
  // tentativa inicial + 3 retries = 4 logs
  assert.ok(diagnosticCount >= 4, `esperado >=4 logs MICROSOFT_GRAPH_DIAGNOSTIC, recebido: ${diagnosticCount}`);

  const status503Count = (logs.match(/status=503/g) || []).length;
  assert.ok(status503Count >= 4, `esperado >=4 linhas com status=503, recebido: ${status503Count}`);
});
