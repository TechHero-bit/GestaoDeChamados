/**
 * Testes para o fallback seguro de 503 ErrorMailboxMoveInProgress via POST /me/sendMail.
 *
 * Cobre os 8 cenarios obrigatorios:
 *  1. Fluxo normal: createReply -> 201 -> sem fallback
 *  2. ErrorMailboxMoveInProgress + fallback funcionando:
 *     createReply -> 503 ErrorMailboxMoveInProgress -> retries esgotados -> sendMail fallback -> 202 -> fallbackUsed = true, Saida persistida
 *  3. Outro 503: 503 + ErrorSomethingElse -> NAO usar fallback
 *  4. 500 + ErrorMailboxMoveInProgress -> NAO usar fallback (status deve ser 503)
 *  5. 403 Forbidden -> NAO usar fallback
 *  6. Fallback falha: createReply -> ErrorMailboxMoveInProgress -> sendMail -> 500 -> erro específico, SEM registro de Saida
 *  7. Retry do createReply preservado (recuperacao antes de esgotar)
 *  8. Seguranca: nenhum log ou erro contem Bearer, access_token, refresh_token, cookie, client_secret, webhook_secret
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { replyToMicrosoftMessage, sendFallbackReply } from "../src/services/microsoft-graph.service.js";
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
        message: "Mailbox move in progress. Try again later., Cross Server access is not allowed for mailbox 82eea528-61e3-4811-81a5-f4fa1ec93e9d",
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
test("Cenário 1 — fluxo normal: createReply retorna 201 e não aciona fallback", async () => {
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

  const result = await replyToMicrosoftMessage(
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
  );

  assert.equal(result.status, 202);
  assert.equal(result.draftId, "draft-normal-1");
  assert.equal(result.fallbackUsed, undefined);
  assert.equal(result.signatureDebug.draft_created, true);
  assert.equal(result.signatureDebug.draft_sent, true);
  // Garante que sendMail NÃO foi chamado
  assert.ok(!calls.some((c) => c.url.includes("sendMail")), "sendMail não deve ser chamado no fluxo normal");
});

// =========================================================================
// Cenário 2 — ErrorMailboxMoveInProgress + fallback funcionando
// =========================================================================
test("Cenário 2 — ErrorMailboxMoveInProgress + fallback funcionando: envia via sendMail e persiste Saída", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options?.method, body: options?.body ? JSON.parse(options.body) : null });
    if (url.endsWith("/createReply")) {
      return makeMailboxMove503();
    }
    if (url.endsWith("/sendMail")) {
      return new Response(null, { status: 202 });
    }
    return new Response("{}", { status: 200 });
  };

  const persisted = [];
  const { result, logs } = await captureLogs(() =>
    sendAndPersistTicketReply(
      { ticket: TICKET, userId: USER_ID, message: "Resposta via fallback" },
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

  // Verificações do resultado
  assert.equal(result.provider, "microsoft_graph");
  assert.equal(result.fallbackUsed, true, "deve indicar fallbackUsed = true");
  assert.equal(result.message.direcao, "Saida");
  assert.equal(result.message.remetente_email, "suporte@centaurotelecom.com.br");
  assert.equal(result.message.destinatario_email, RECIPIENT);

  // Verificação de persistência única
  assert.equal(persisted.length, 1, "deve persistir exatamente uma mensagem");
  assert.equal(persisted[0].direcao, "Saida");

  // Verificação da chamada ao Graph sendMail
  const sendMailCall = calls.find((c) => c.url.includes("sendMail"));
  assert.ok(sendMailCall, "sendMail deve ter sido chamado como fallback");
  assert.equal(sendMailCall.body.message.subject, "RE: Chamado #1234 - Falha no link");
  assert.equal(sendMailCall.body.message.toRecipients[0].emailAddress.address, RECIPIENT);
  assert.ok(sendMailCall.body.message.body.content.includes("cid:smartdesk-signature"));
  assert.equal(sendMailCall.body.message.attachments.length, 1);
  assert.equal(sendMailCall.body.message.attachments[0].name, "signature.png");
  assert.equal(sendMailCall.body.message.attachments[0].contentId, "smartdesk-signature");
  assert.equal(sendMailCall.body.message.attachments[0].isInline, true);
  assert.equal(sendMailCall.body.saveToSentItems, true);

  // Verificação de logs
  assert.ok(logs.includes("sendMail_fallback"), "log deve conter operação sendMail_fallback");
  assert.ok(logs.includes("FallbackSuccess"), "log deve registrar sucesso do fallback");
});

// =========================================================================
// Cenário 3 — outro 503
// =========================================================================
test("Cenário 3 — outro 503: 503 com código diferente NÃO usa fallback", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    if (url.endsWith("/createReply")) {
      return new Response(
        JSON.stringify({ error: { code: "ServiceUnavailable", message: "Back-end server is busy." } }),
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
      assert.notEqual(error.publicCode, "SIGNATURE_DRAFT_MAILBOX_MOVE_FALLBACK_FAILED");
      return true;
    },
  );

  assert.ok(!calls.some((url) => url.includes("sendMail")), "NÃO deve chamar sendMail para outro 503");
});

// =========================================================================
// Cenário 4 — 500 + ErrorMailboxMoveInProgress
// =========================================================================
test("Cenário 4 — 500 + ErrorMailboxMoveInProgress: NÃO usa fallback (exige status === 503)", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    if (url.endsWith("/createReply")) {
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

  assert.ok(!calls.some((url) => url.includes("sendMail")), "NÃO deve chamar sendMail quando status for 500");
});

// =========================================================================
// Cenário 5 — 403 Forbidden
// =========================================================================
test("Cenário 5 — 403 Forbidden: NÃO usa fallback", async () => {
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
// Cenário 6 — Fallback falha
// =========================================================================
test("Cenário 6 — Fallback falha: createReply -> ErrorMailboxMoveInProgress e sendMail -> 500", async () => {
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/createReply")) {
      return makeMailboxMove503();
    }
    if (url.endsWith("/sendMail")) {
      return new Response(
        JSON.stringify({ error: { code: "GeneralException", message: "Internal server error during sendMail." } }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200 });
  };

  const persisted = [];
  await assert.rejects(
    sendAndPersistTicketReply(
      { ticket: TICKET, userId: USER_ID, message: "Resposta com falha de fallback" },
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
      assert.equal(error.publicCode, "SIGNATURE_DRAFT_MAILBOX_MOVE_FALLBACK_FAILED");
      assert.equal(error.statusCode, 502);
      assert.equal(error.operation, "sendMail_fallback");
      assert.equal(error.microsoftDiagnosticError, true);
      assert.ok(error.message.includes("movimentação interna"));
      return true;
    },
  );

  // CRÍTICO: nenhuma mensagem de saída deve ser persistida se o fallback falhar!
  assert.equal(persisted.length, 0, "NÃO deve persistir mensagem se o fallback falhar");
});

// =========================================================================
// Cenário 7 — Retry do createReply
// =========================================================================
test("Cenário 7 — Retry do createReply: recupera na 2a tentativa sem acionar fallback", async () => {
  let createReplyAttempts = 0;
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    if (url.endsWith("/createReply")) {
      createReplyAttempts += 1;
      if (createReplyAttempts === 1) return makeMailboxMove503();
      return new Response(JSON.stringify({ id: "draft-recovered" }), { status: 201 });
    }
    if (options?.method === "PATCH") return new Response("{}", { status: 200 });
    if (url.endsWith("/attachments")) return new Response("{}", { status: 201 });
    if (url.endsWith("/send")) return new Response("{}", { status: 202 });
    return new Response("{}", { status: 200 });
  };

  const result = await replyToMicrosoftMessage(
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
  );

  assert.equal(result.status, 202);
  assert.equal(result.draftId, "draft-recovered");
  assert.equal(createReplyAttempts, 2, "deve ter tentado 2 vezes");
  assert.ok(!calls.some((url) => url.includes("sendMail")), "NÃO deve ter acionado fallback pois recuperou no retry");
});

// =========================================================================
// Cenário 8 — Segurança
// =========================================================================
test("Cenário 8 — Segurança: nenhum log ou erro contém credenciais ou segredos", async () => {
  const sensitiveToken = "Bearer-secret-access-token-987654";
  const sensitiveSecret = "client-secret-very-confidential";

  const fetchImpl = async (url, options) => {
    if (url.endsWith("/createReply")) {
      return makeMailboxMove503();
    }
    if (url.endsWith("/sendMail")) {
      return new Response(null, { status: 202 });
    }
    return new Response("{}", { status: 200 });
  };

  const { logs } = await captureLogs(() =>
    sendAndPersistTicketReply(
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
    ),
  );

  // Verificar que nenhuma credencial ou segredo vazou nos logs
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
