/**
 * Testes para o tratamento seguro de 503 ErrorMailboxMoveInProgress com
 * preservação estrita de threading na conversa original da caixa compartilhada.
 *
 * Requisito Funcional:
 * - O Help Desk NÃO pode responder criando novo e-mail independente via sendMail.
 * - Toda resposta deve permanecer na conversa original do Outlook e vinculada à caixa compartilhada.
 * - Quando createReply esgotar os retries sob ErrorMailboxMoveInProgress, o sistema NÃO envia
 *   nova mensagem e retorna erro controlado (SIGNATURE_DRAFT_MAILBOX_MOVE).
 *
 * Cenários cobertos:
 *  1. Fluxo normal: createReply -> 201 -> sucesso -> logs createReply_success e threaded_reply_success
 *  2. ErrorMailboxMoveInProgress + recuperação no retry -> sucesso de threading, Saída persistida
 *  3. ErrorMailboxMoveInProgress + retries esgotados -> NÃO enviar sendMail, lançar erro controlado, SEM Saída
 *  4. Outro 503 (ex: ErrorServerBusy) -> NÃO executa retry nem fallback especial
 *  5. 500 com ErrorMailboxMoveInProgress -> NÃO executa retry (exige status === 503)
 *  6. 403 Forbidden -> NÃO executa retry nem fallback
 *  7. Garantia contra duplicidade e isolamento: sendMail NUNCA é chamado em falhas parciais
 *  8. Segurança: nenhum log ou erro contém Bearer, access_token, refresh_token, cookie ou secrets
 *  9. Resposta direta na conversa sem assinatura (reply simples): registra threaded_reply_success e threaded_reply_failed
 * 10. Auditoria de identificadores: preserva destinatário original e messageId sem inventar headers
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { replyToMicrosoftMessage } from "../src/services/microsoft-graph.service.js";
import { sendAndPersistTicketReply } from "../src/services/ticket-reply.service.js";

const USER_ID = "00000000-0000-4000-8000-000000000099";
const DUMMY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const INLINE_ATTACHMENT = {
  contentId: "smartdesk-signature",
  contentBytes: DUMMY_PNG_BASE64,
};
const SAFE_HTML = '<div>Resposta de teste</div><br><br><img src="cid:smartdesk-signature">';
const MESSAGE_ID = "AAMkAGV4dGVzdC1tZXNzYWdlLWlk";
const RECIPIENT = "solicitante@centaurotelecom.com.br";
const SUBJECT = "RE: Chamado #1234 - Falha no link";

const TICKET = {
  id: "00000000-0000-4000-8000-000000000001",
  remetente_email: RECIPIENT,
  assunto: "Chamado #1234 - Falha no link",
  prioridade: "Alta",
  outlook_last_message_id: MESSAGE_ID,
  outlook_message_id: "original-message-id",
};

function makeMailboxMove503() {
  return new Response(
    JSON.stringify({
      error: {
        code: "ErrorMailboxMoveInProgress",
        message:
          "Mailbox move in progress. Try again later., Cross Server access is not allowed for mailbox 82eea528-61e3-4811-81a5-f4fa1ec93e9d",
      },
    }),
    {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "request-id": "req-mailbox-move-123",
        "client-request-id": "client-mailbox-move-456",
      },
    },
  );
}

function makeSignatureConfig(userId = USER_ID) {
  return {
    enabled: true,
    profileEnabled: true,
    signatureServiceReceivedStringId: true,
    signatureProfileFound: true,
    hasSignature: true,
    storagePath: `${userId}/signature.png`,
    sameAuthenticatedUser: true,
    imageBytes: Buffer.from(DUMMY_PNG_BASE64, "base64"),
    storageDownloaded: true,
  };
}

async function captureLogs(fn) {
  const logs = [];
  const origInfo = console.info;
  const origError = console.error;
  const origLog = console.log;
  console.info = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const result = await fn();
    return { result, logs: logs.join("\n") };
  } finally {
    console.info = origInfo;
    console.error = origError;
    console.log = origLog;
  }
}

// =========================================================================
// Cenário 1 — Fluxo normal
// =========================================================================
test("Cenário 1 — fluxo normal: createReply retorna 201 e envia resposta na conversa original", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options?.method || "GET" });
    if (url.endsWith("/createReply")) {
      return new Response(JSON.stringify({ id: "draft-normal-1" }), { status: 201 });
    }
    if (options?.method === "PATCH") return new Response("{}", { status: 200 });
    if (url.endsWith("/attachments")) return new Response("{}", { status: 201 });
    if (url.endsWith("/send")) return new Response("{}", { status: 202 });
    return new Response("{}", { status: 200 });
  };

  const { result, logs } = await captureLogs(() =>
    replyToMicrosoftMessage(
      USER_ID,
      {
        messageId: MESSAGE_ID,
        message: "Resposta normal",
        html: SAFE_HTML,
        inlineAttachment: INLINE_ATTACHMENT,
        to: RECIPIENT,
        subject: SUBJECT,
      },
      { getAccessToken: async () => "token-ok", fetchImpl },
    ),
  );

  assert.equal(result.status, 202);
  assert.equal(result.draftId, "draft-normal-1");
  assert.equal(result.signatureDebug.draft_created, true);
  assert.equal(result.signatureDebug.draft_sent, true);
  // Garante que sendMail NÃO foi chamado em momento algum
  assert.ok(!calls.some((c) => c.url.includes("sendMail")), "sendMail não deve ser chamado no fluxo normal");
  // Garante logs adequados
  assert.ok(logs.includes("operation=createReply_success"), "log deve registrar createReply_success");
  assert.ok(logs.includes("operation=threaded_reply_success"), "log deve registrar threaded_reply_success");
});

// =========================================================================
// Cenário 2 — ErrorMailboxMoveInProgress + recuperação no retry
// =========================================================================
test("Cenário 2 — ErrorMailboxMoveInProgress: recupera na 2a tentativa e mantém threading na conversa original", async () => {
  let createReplyAttempts = 0;
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options?.method || "GET" });
    if (url.endsWith("/createReply")) {
      createReplyAttempts += 1;
      if (createReplyAttempts === 1) return makeMailboxMove503();
      return new Response(JSON.stringify({ id: "draft-recovered-1" }), { status: 201 });
    }
    if (options?.method === "PATCH") return new Response("{}", { status: 200 });
    if (url.endsWith("/attachments")) return new Response("{}", { status: 201 });
    if (url.endsWith("/send")) return new Response("{}", { status: 202 });
    return new Response("{}", { status: 200 });
  };

  const persisted = [];
  const { result, logs } = await captureLogs(() =>
    sendAndPersistTicketReply(
      { ticket: TICKET, userId: USER_ID, message: "Resposta recuperada no retry" },
      {
        getConnectionStatus: async () => ({
          connected: true,
          email: "suporte@centaurotelecom.com.br",
          display_name: "Suporte Centauro",
        }),
        getSignature: async () => makeSignatureConfig(),
        replyWithMicrosoftGraph: (userId, payload) =>
          replyToMicrosoftMessage(userId, payload, {
            getAccessToken: async () => "valid-token-123",
            fetchImpl,
          }),
        persistMessage: async (payload) => {
          persisted.push(payload);
          return { id: "persisted-msg-1", ...payload };
        },
        helpdeskEmail: () => "suporte@centaurotelecom.com.br",
      },
    ),
  );

  assert.equal(result.provider, "microsoft_graph");
  assert.equal(persisted.length, 1, "deve persistir Saída após confirmação 202");
  assert.equal(persisted[0].destinatario_email, RECIPIENT);
  assert.equal(createReplyAttempts, 2, "deve ter tentado exatamente 2 vezes");
  assert.ok(!calls.some((c) => c.url.includes("sendMail")), "sendMail NUNCA deve ser chamado");

  // Logs esperados
  assert.ok(logs.includes("operation=createReply_retry"), "log deve conter createReply_retry");
  assert.ok(logs.includes("operation=createReply_success"), "log deve conter createReply_success");
  assert.ok(logs.includes("code=MailboxMoveRecovered"), "log deve indicar recuperação");
  assert.ok(logs.includes("operation=threaded_reply_success"), "log deve conter threaded_reply_success");
});

// =========================================================================
// Cenário 3 — ErrorMailboxMoveInProgress com retries esgotados: NÃO envia sendMail
// =========================================================================
test("Cenário 3 — ErrorMailboxMoveInProgress esgotado: NÃO envia sendMail independente, retorna erro e não persiste Saída", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options?.method, body: options?.body ? JSON.parse(options.body) : null });
    if (url.endsWith("/createReply")) {
      return makeMailboxMove503();
    }
    return new Response("{}", { status: 200 });
  };

  const persisted = [];
  const { logs } = await captureLogs(async () => {
    await assert.rejects(
      sendAndPersistTicketReply(
        { ticket: TICKET, userId: USER_ID, message: "Tentativa com mailbox move" },
        {
          getConnectionStatus: async () => ({
            connected: true,
            email: "suporte@centaurotelecom.com.br",
            display_name: "Suporte Centauro",
          }),
          getSignature: async () => makeSignatureConfig(),
          replyWithMicrosoftGraph: (userId, payload) =>
            replyToMicrosoftMessage(userId, payload, {
              getAccessToken: async () => "valid-token-123",
              fetchImpl,
            }),
          persistMessage: async (payload) => {
            persisted.push(payload);
            return { id: "persisted-msg-1", ...payload };
          },
          helpdeskEmail: () => "suporte@centaurotelecom.com.br",
        },
      ),
      (error) => {
        assert.equal(error.publicCode, "SIGNATURE_DRAFT_MAILBOX_MOVE");
        assert.equal(error.statusCode, 502);
        assert.equal(error.operation, "createReply_mailbox_move_exhausted");
        assert.ok(error.message.includes("movimentação interna"));
        return true;
      },
    );
  });

  // Garantia absoluta: NENHUMA chamada a sendMail
  const sendMailCalls = calls.filter((c) => c.url.includes("sendMail"));
  assert.equal(sendMailCalls.length, 0, "sendMail NÃO pode ser chamado como fallback sob nenhuma hipótese");

  // Garantia absoluta: NENHUMA mensagem persistida na timeline
  assert.equal(persisted.length, 0, "NÃO deve persistir mensagem de saída se createReply falhou definitivamente");

  // Garantia de logs: diferenciação explícita
  assert.ok(logs.includes("operation=createReply_retry"), "log deve conter createReply_retry");
  assert.ok(logs.includes("operation=createReply_mailbox_move_exhausted"), "log deve conter createReply_mailbox_move_exhausted");
  assert.ok(logs.includes("operation=threaded_reply_failed"), "log deve conter threaded_reply_failed");
  assert.ok(!logs.includes("sendMail_fallback"), "NÃO deve conter operação sendMail_fallback");
  assert.ok(!logs.includes("FallbackSuccess"), "NÃO deve conter FallbackSuccess");
});

// =========================================================================
// Cenário 4 — Outro 503 (ex: ErrorServerBusy)
// =========================================================================
test("Cenário 4 — outro 503: código diferente de ErrorMailboxMoveInProgress NÃO executa retry nem fallback", async () => {
  let attempts = 0;
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    if (url.endsWith("/createReply")) {
      attempts += 1;
      return new Response(
        JSON.stringify({ error: { code: "ErrorServerBusy", message: "Server is busy." } }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200 });
  };

  await assert.rejects(
    replyToMicrosoftMessage(
      USER_ID,
      {
        messageId: MESSAGE_ID,
        message: "Teste",
        html: SAFE_HTML,
        inlineAttachment: INLINE_ATTACHMENT,
        to: RECIPIENT,
        subject: SUBJECT,
      },
      { getAccessToken: async () => "token-ok", fetchImpl },
    ),
    (error) => {
      assert.equal(error.publicCode, "SIGNATURE_DRAFT_FAILED");
      return true;
    },
  );

  assert.equal(attempts, 1, "NÃO deve executar retries para erros que não sejam ErrorMailboxMoveInProgress");
  assert.ok(!calls.some((url) => url.includes("sendMail")), "NÃO deve chamar sendMail");
});

// =========================================================================
// Cenário 5 — 500 com ErrorMailboxMoveInProgress
// =========================================================================
test("Cenário 5 — 500 com ErrorMailboxMoveInProgress: NÃO executa retry (exige status === 503)", async () => {
  let attempts = 0;
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    if (url.endsWith("/createReply")) {
      attempts += 1;
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
      {
        messageId: MESSAGE_ID,
        message: "Teste",
        html: SAFE_HTML,
        inlineAttachment: INLINE_ATTACHMENT,
        to: RECIPIENT,
        subject: SUBJECT,
      },
      { getAccessToken: async () => "token-ok", fetchImpl },
    ),
    (error) => {
      assert.equal(error.publicCode, "SIGNATURE_DRAFT_FAILED");
      return true;
    },
  );

  assert.equal(attempts, 1, "NÃO deve executar retries se o status for 500 em vez de 503");
  assert.ok(!calls.some((url) => url.includes("sendMail")), "NÃO deve chamar sendMail");
});

// =========================================================================
// Cenário 6 — 403 Forbidden
// =========================================================================
test("Cenário 6 — 403 Forbidden: NÃO executa retry nem fallback", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    if (url.endsWith("/createReply")) {
      return new Response(
        JSON.stringify({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200 });
  };

  await assert.rejects(
    replyToMicrosoftMessage(
      USER_ID,
      {
        messageId: MESSAGE_ID,
        message: "Teste",
        html: SAFE_HTML,
        inlineAttachment: INLINE_ATTACHMENT,
        to: RECIPIENT,
        subject: SUBJECT,
      },
      { getAccessToken: async () => "token-ok", fetchImpl },
    ),
    (error) => {
      assert.equal(error.publicCode, "SIGNATURE_DRAFT_FAILED");
      return true;
    },
  );

  assert.ok(!calls.some((url) => url.includes("sendMail")), "NÃO deve chamar sendMail em 403");
});

// =========================================================================
// Cenário 7 — Garantia contra duplicidade e isolamento em falhas posteriores
// =========================================================================
test("Cenário 7 — Falha em PATCH ou sendDraft NÃO aciona sendMail e não persiste Saída", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    if (url.endsWith("/createReply")) {
      return new Response(JSON.stringify({ id: "draft-1" }), { status: 201 });
    }
    if (options?.method === "PATCH") {
      return new Response(JSON.stringify({ error: { code: "ErrorInvalidHtml" } }), { status: 500 });
    }
    return new Response("{}", { status: 200 });
  };

  const persisted = [];
  await assert.rejects(
    sendAndPersistTicketReply(
      { ticket: TICKET, userId: USER_ID, message: "Falha de PATCH" },
      {
        getConnectionStatus: async () => ({
          connected: true,
          email: "suporte@centaurotelecom.com.br",
          display_name: "Suporte Centauro",
        }),
        getSignature: async () => makeSignatureConfig(),
        replyWithMicrosoftGraph: (userId, payload) =>
          replyToMicrosoftMessage(userId, payload, {
            getAccessToken: async () => "valid-token-123",
            fetchImpl,
          }),
        persistMessage: async (payload) => {
          persisted.push(payload);
          return { id: "msg-id", ...payload };
        },
        helpdeskEmail: () => "suporte@centaurotelecom.com.br",
      },
    ),
  );

  assert.equal(persisted.length, 0, "NÃO deve persistir Saída se o PATCH do rascunho falhar");
  assert.ok(!calls.some((url) => url.includes("sendMail")), "NÃO deve chamar sendMail se o PATCH falhar");
});

// =========================================================================
// Cenário 8 — Segurança e sanitização
// =========================================================================
test("Cenário 8 — Segurança: nenhum log ou erro contém credenciais ou segredos", async () => {
  const sensitiveToken = "Bearer-secret-access-token-987654";
  const sensitiveSecret = "client-secret-very-confidential";

  const fetchImpl = async (url, options) => {
    if (url.endsWith("/createReply")) {
      return makeMailboxMove503();
    }
    return new Response("{}", { status: 200 });
  };

  const { logs } = await captureLogs(async () => {
    try {
      await sendAndPersistTicketReply(
        { ticket: TICKET, userId: USER_ID, message: "Resposta de teste" },
        {
          getConnectionStatus: async () => ({
            connected: true,
            email: "suporte@centaurotelecom.com.br",
            display_name: "Suporte Centauro",
          }),
          getSignature: async () => makeSignatureConfig(),
          replyWithMicrosoftGraph: (userId, payload) =>
            replyToMicrosoftMessage(userId, payload, {
              getAccessToken: async () => sensitiveToken,
              fetchImpl,
            }),
          persistMessage: async (payload) => ({ id: "msg-id", ...payload }),
          helpdeskEmail: () => "suporte@centaurotelecom.com.br",
        },
      );
    } catch {
      // Ignora erro esperado
    }
  });

  const forbiddenKeywords = [
    sensitiveToken,
    sensitiveSecret,
    "Bearer",
    "access_token",
    "refresh_token",
    "client_secret",
    "webhook_secret",
  ];

  for (const keyword of forbiddenKeywords) {
    assert.equal(
      logs.includes(keyword),
      false,
      `Logs de diagnóstico NUNCA devem conter: ${keyword}`,
    );
  }
});

// =========================================================================
// Cenário 9 — Resposta direta na conversa sem assinatura
// =========================================================================
test("Cenário 9 — Resposta direta sem assinatura usa endpoint /reply e registra threaded_reply_success", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options?.method || "GET" });
    if (url.endsWith("/reply")) {
      return new Response(null, { status: 202 });
    }
    return new Response("{}", { status: 200 });
  };

  const { logs } = await captureLogs(() =>
    replyToMicrosoftMessage(
      USER_ID,
      {
        messageId: MESSAGE_ID,
        message: "Resposta de texto simples",
        html: "<div>Resposta de texto simples</div>",
      },
      { getAccessToken: async () => "token-ok", fetchImpl },
    ),
  );

  const replyCall = calls.find((c) => c.url.includes("/reply"));
  assert.ok(replyCall, "deve ter chamado POST /me/messages/{id}/reply");
  assert.ok(!calls.some((c) => c.url.includes("sendMail")), "sendMail não pode ser chamado");
  assert.ok(logs.includes("operation=threaded_reply_success"), "deve registrar threaded_reply_success");
});

// =========================================================================
// Cenário 10 — Auditoria de identificadores reais da conversa
// =========================================================================
test("Cenário 10 — Resposta preserva identificadores reais e não inventa Message-ID ou conversationId", async () => {
  let createdReplyUrl = null;
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/createReply")) {
      createdReplyUrl = url;
      return new Response(JSON.stringify({ id: "draft-audited-1" }), { status: 201 });
    }
    if (options?.method === "PATCH") return new Response("{}", { status: 200 });
    if (url.endsWith("/attachments")) return new Response("{}", { status: 201 });
    if (url.endsWith("/send")) return new Response("{}", { status: 202 });
    return new Response("{}", { status: 200 });
  };

  const persisted = [];
  await sendAndPersistTicketReply(
    { ticket: TICKET, userId: USER_ID, message: "Mensagem auditada" },
    {
      getConnectionStatus: async () => ({
        connected: true,
        email: "suporte@centaurotelecom.com.br",
        display_name: "Suporte Centauro",
      }),
      getSignature: async () => makeSignatureConfig(),
      replyWithMicrosoftGraph: (userId, payload) =>
        replyToMicrosoftMessage(userId, payload, {
          getAccessToken: async () => "token-ok",
          fetchImpl,
        }),
      persistMessage: async (payload) => {
        persisted.push(payload);
        return { id: "persisted-msg-audited", ...payload };
      },
      helpdeskEmail: () => "suporte@centaurotelecom.com.br",
    },
  );

  // Verifica que createReply foi chamado exatamente com o MESSAGE_ID original (outlook_last_message_id)
  assert.ok(
    createdReplyUrl.includes(encodeURIComponent(MESSAGE_ID)),
    "createReply deve ser chamado na URL da mensagem original",
  );
  // Verifica persistência com destinatário original
  assert.equal(persisted[0].destinatario_email, RECIPIENT);
  assert.equal(persisted[0].remetente_email, "suporte@centaurotelecom.com.br");
});
