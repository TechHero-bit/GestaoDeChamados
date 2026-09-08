import assert from "node:assert/strict";
import { test } from "node:test";
import { getUserSignatureConfig } from "../src/services/signature.service.js";
import { replyToMicrosoftMessage } from "../src/services/microsoft-graph.service.js";
import { sendAndPersistTicketReply } from "../src/services/ticket-reply.service.js";
import { errorMiddleware } from "../src/middlewares/error.middleware.js";
import { responderTicket } from "../src/controllers/ticket.controller.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const USER_ID = "user-a";
const SIGNATURE_PATH = USER_ID + "/signature.png";
const SUCCESSFUL_GRAPH_DEBUG = {
  enabled: true,
  draft_created: true,
  body_contains_cid: true,
  attachment_created: true,
  attachment_inline: true,
  content_id_matches: true,
  draft_sent: true,
};

function fakeSupabase({
  enabled = true,
  path = SIGNATURE_PATH,
  rowUserId = USER_ID,
  rowFound = true,
  download = new Blob([PNG], { type: "image/png" }),
} = {}) {
  const calls = [];
  const query = { columns: null, filterColumn: null, userId: null };
  return {
    calls,
    query,
    from(table) {
      assert.equal(table, "users");
      return {
        select(columns) {
          query.columns = columns;
          return this;
        },
        eq(column, value) {
          query.filterColumn = column;
          query.userId = value;
          return this;
        },
        maybeSingle: async () => ({
          data: rowFound
            ? {
                id: rowUserId,
                signature_enabled: enabled,
                signature_storage_path: path,
                data_atualizacao: "2026-09-02T12:00:00.000Z",
              }
            : null,
          error: null,
        }),
      };
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, "Assinaturas");
        return {
          download: async (downloadPath) => {
            calls.push(downloadPath);
            return { data: download, error: null };
          },
        };
      },
    },
  };
}

function replyDependencies(signature) {
  let graphPayload;
  let persisted;
  return {
    getConnectionStatus: async () => ({ connected: true, email: "agent@example.com" }),
    getSignature: async () => signature,
    replyWithMicrosoftGraph: async (_userId, payload) => {
      graphPayload = payload;
      return payload.inlineAttachment
        ? { signatureDebug: SUCCESSFUL_GRAPH_DEBUG }
        : undefined;
    },
    persistMessage: async (payload) => { persisted = payload; return payload; },
    helpdeskEmail: () => "helpdesk@example.com",
    getGraphPayload: () => graphPayload,
    getPersisted: () => persisted,
  };
}

test("assinatura ativa baixa PNG do bucket Assinaturas", async () => {
  const database = fakeSupabase();
  const signature = await getUserSignatureConfig(USER_ID, { supabase: database, downloadImage: true });

  assert.equal(database.query.columns, "id, signature_enabled, signature_storage_path, data_atualizacao");
  assert.equal(database.query.filterColumn, "id");
  assert.equal(database.query.userId, USER_ID);
  assert.deepEqual(database.calls, [SIGNATURE_PATH]);
  assert.equal(signature.enabled, true);
  assert.equal(signature.hasSignature, true);
  assert.equal(signature.storagePath, SIGNATURE_PATH);
  assert.equal(signature.storageDownloaded, true);
  assert.equal(signature.sameAuthenticatedUser, true);
  assert.deepEqual(signature.imageBytes, PNG);
});

test("linha de usuário ausente não é convertida em enabled=false", async () => {
  const database = fakeSupabase({ rowFound: false });

  await assert.rejects(
    getUserSignatureConfig(USER_ID, { supabase: database, downloadImage: true }),
    (error) => {
      assert.equal(error.publicCode, "SIGNATURE_PROFILE_NOT_FOUND");
      assert.deepEqual(error.signatureDebug, {
        enabled: false,
        auth_user_id_present: true,
        signature_service_received_string_id: true,
        signature_profile_found: false,
        profile_enabled: false,
        path_found: false,
        has_signature: false,
        same_authenticated_user: false,
        reply_enabled: false,
      });
      return true;
    },
  );
  assert.equal(database.query.userId, USER_ID);
});

test("resultado de outro usuário é rejeitado", async () => {
  const database = fakeSupabase({ rowUserId: "user-b" });

  await assert.rejects(
    getUserSignatureConfig(USER_ID, { supabase: database, downloadImage: true }),
    (error) => error.signatureDebug?.same_authenticated_user === false,
  );
  assert.equal(database.query.userId, USER_ID);
  assert.notEqual(database.query.userId, "user-b");
});

test("draft Graph usa createReply, PATCH HTML, attachment inline e send em ordem", async () => {
  const calls = [];
  const contentBytes = PNG.toString("base64");
  const graphResult = await replyToMicrosoftMessage(
    USER_ID,
    {
      messageId: "original/message",
      message: "Mensagem original",
      html: '<div>Resposta segura</div><br><br><img src="cid:smartdesk-signature" alt="Assinatura">',
      inlineAttachment: {
        contentId: "smartdesk-signature",
        contentBytes,
      },
    },
    {
      getAccessToken: async () => "token-not-logged",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith("/createReply")) {
          return new Response(JSON.stringify({ id: "draft-1" }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith("/attachments")) return new Response("{}", { status: 201 });
        if (url.endsWith("/send")) return new Response(null, { status: 202 });
        return new Response(null, { status: 200 });
      },
    },
  );

  assert.equal(calls.length, 4);
  assert.deepEqual(graphResult.signatureDebug, SUCCESSFUL_GRAPH_DEBUG);
  assert.equal(calls[0].url.endsWith("/messages/original%2Fmessage/createReply"), true);
  assert.equal(calls[1].url.endsWith("/messages/draft-1"), true);
  assert.equal(calls[2].url.endsWith("/messages/draft-1/attachments"), true);
  assert.equal(calls[3].url.endsWith("/messages/draft-1/send"), true);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    body: {
      contentType: "HTML",
      content: '<div>Resposta segura</div><br><br><img src="cid:smartdesk-signature" alt="Assinatura">',
    },
  });

  const attachment = JSON.parse(calls[2].options.body);
  assert.equal(attachment["@odata.type"], "#microsoft.graph.fileAttachment");
  assert.equal(attachment.isInline, true);
  assert.equal(attachment.contentId, "smartdesk-signature");
  assert.equal(attachment.contentBytes, contentBytes);
  assert.equal(calls[3].options.body, undefined);
  assert.equal(calls.some(({ url }) => url.endsWith("/reply")), false);
});

test("falhas em createReply, PATCH ou send interrompem o fluxo inline", async () => {
  const scenarios = [
    { stage: "createReply", expectedCode: "SIGNATURE_DRAFT_FAILED" },
    { stage: "patch", expectedCode: "SIGNATURE_DRAFT_FAILED" },
    { stage: "send", expectedCode: "SIGNATURE_SEND_FAILED" },
  ];

  for (const scenario of scenarios) {
    const calls = [];
    await assert.rejects(
      replyToMicrosoftMessage(
        USER_ID,
        {
          messageId: "message-id",
          message: "Mensagem original",
          html: '<div>Resposta</div><br><br><img src="cid:smartdesk-signature">',
          inlineAttachment: {
            contentId: "smartdesk-signature",
            contentBytes: PNG.toString("base64"),
          },
        },
        {
          getAccessToken: async () => "token-not-logged",
          fetchImpl: async (url, options) => {
            calls.push({ url, options });
            if (url.endsWith("/createReply")) {
              const status = scenario.stage === "createReply" ? 500 : 201;
              return new Response(JSON.stringify({ id: "same-draft" }), { status });
            }
            if (options.method === "PATCH") {
              return new Response(null, { status: scenario.stage === "patch" ? 500 : 200 });
            }
            if (url.endsWith("/attachments")) return new Response("{}", { status: 201 });
            if (url.endsWith("/send")) {
              return new Response(null, { status: scenario.stage === "send" ? 500 : 202 });
            }
            return new Response(null, { status: 500 });
          },
        },
      ),
      (error) => {
        assert.equal(error.publicCode, scenario.expectedCode);
        assert.equal(error.safeToFallback, false);
        assert.equal(error.signatureDebug.draft_sent, false);
        return true;
      },
    );

    assert.equal(calls.some(({ url }) => url.endsWith("/reply")), false);
  }
});

test("falha no attachment não chama send", async () => {
  const calls = [];

  await assert.rejects(
    replyToMicrosoftMessage(
      USER_ID,
      {
        messageId: "message-id",
        message: "Mensagem original",
        html: '<div>Resposta</div><br><br><img src="cid:smartdesk-signature">',
        inlineAttachment: {
          contentId: "smartdesk-signature",
          contentBytes: PNG.toString("base64"),
        },
      },
      {
        getAccessToken: async () => "token-not-logged",
        fetchImpl: async (url, options) => {
          calls.push({ url, options });
          if (url.endsWith("/createReply")) {
            return new Response(JSON.stringify({ id: "draft-2" }), { status: 201 });
          }
          if (url.endsWith("/attachments")) return new Response("failed", { status: 400 });
          return new Response(null, { status: 200 });
        },
      },
    ),
    (error) => {
      assert.equal(error.publicCode, "SIGNATURE_ATTACHMENT_FAILED");
      assert.equal(error.safeToFallback, false);
      return true;
    },
  );

  assert.equal(calls.length, 3);
  assert.equal(calls.some(({ url }) => url.endsWith("/send")), false);
});

test("assinatura ativa nunca faz fallback para reply sem assinatura", async () => {
  const signature = {
    enabled: true,
    profileEnabled: true,
    signatureServiceReceivedStringId: true,
    signatureProfileFound: true,
    hasSignature: true,
    storagePath: SIGNATURE_PATH,
    sameAuthenticatedUser: true,
    imageBytes: PNG,
    storageDownloaded: true,
  };
  const dependencies = replyDependencies(signature);
  let fallbackCalled = false;
  dependencies.replyWithMicrosoftGraph = async () => {
    throw Object.assign(new Error("attachment failed"), { safeToFallback: true });
  };
  dependencies.replyWithPowerAutomate = async () => {
    fallbackCalled = true;
  };

  await assert.rejects(
    sendAndPersistTicketReply(
      {
        ticket: {
          id: "ticket-no-fallback",
          remetente_email: "requester@example.com",
          assunto: "Teste",
          outlook_last_message_id: "message-id",
        },
        userId: USER_ID,
        message: "Resposta obrigatoriamente assinada",
      },
      dependencies,
    ),
    /attachment failed/,
  );

  assert.equal(fallbackCalled, false);
  assert.equal(dependencies.getPersisted(), undefined);
});

test("reply com attachment inline persiste apenas a mensagem original e não expõe bytes nos logs", async () => {
  const signature = {
    enabled: true,
    profileEnabled: true,
    signatureServiceReceivedStringId: true,
    signatureProfileFound: true,
    hasSignature: true,
    storagePath: SIGNATURE_PATH,
    sameAuthenticatedUser: true,
    imageBytes: PNG,
    storageDownloaded: true,
  };
  const deps = replyDependencies(signature);
  const originalMessage = "<script>log</script>";
  const logs = [];
  let replyResult;
  const originalConsoleLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    replyResult = await sendAndPersistTicketReply(
      {
        ticket: {
          id: "ticket-1",
          remetente_email: "requester@example.com",
          assunto: "Teste",
          outlook_last_message_id: "message-id",
        },
        userId: USER_ID,
        message: originalMessage,
      },
      deps,
    );
  } finally {
    console.log = originalConsoleLog;
  }

  assert.deepEqual(replyResult.signatureDebug, {
    ...SUCCESSFUL_GRAPH_DEBUG,
    auth_user_id_present: true,
    signature_service_received_string_id: true,
    signature_profile_found: true,
    profile_enabled: true,
    reply_enabled: true,
    path_found: true,
    has_signature: true,
    same_authenticated_user: true,
    storage_downloaded: true,
  });
  const payload = deps.getGraphPayload();
  assert.equal(payload.html.includes('src="cid:smartdesk-signature"'), true);
  assert.equal(payload.inlineAttachment.contentId, "smartdesk-signature");
  assert.equal(payload.inlineAttachment.contentBytes, PNG.toString("base64"));
  assert.equal(deps.getPersisted().corpo_mensagem, originalMessage);
  assert.equal(deps.getPersisted().corpo_mensagem.includes("<img"), false);
  assert.equal(logs.join("\n").includes(PNG.toString("base64")), false);
  assert.equal(logs.join("\n").includes("token-not-logged"), false);
});

test("assinatura desativada não baixa Storage e mantém reply JSON sem imagem", async () => {
  const database = fakeSupabase({ enabled: false });
  const signature = await getUserSignatureConfig(USER_ID, { supabase: database, downloadImage: true });
  assert.equal(signature.enabled, false);
  assert.equal(signature.sameAuthenticatedUser, true);
  assert.equal(signature.storageDownloaded, false);
  assert.equal(database.query.userId, USER_ID);
  assert.deepEqual(database.calls, []);

  const deps = replyDependencies(signature);
  const replyResult = await sendAndPersistTicketReply(
    {
      ticket: {
        id: "ticket-2",
        remetente_email: "requester@example.com",
        assunto: "Teste",
        outlook_last_message_id: "message-id",
      },
      userId: USER_ID,
      message: "Sem assinatura",
    },
    deps,
  );
  assert.deepEqual(replyResult.signatureDebug, {
    enabled: false,
    auth_user_id_present: true,
    signature_service_received_string_id: true,
    signature_profile_found: true,
    profile_enabled: false,
    reply_enabled: false,
    path_found: true,
    has_signature: true,
    same_authenticated_user: true,
    storage_downloaded: false,
    draft_created: false,
    body_contains_cid: false,
    attachment_created: false,
    attachment_inline: false,
    content_id_matches: false,
    draft_sent: false,
  });
  assert.equal(deps.getGraphPayload().inlineAttachment, undefined);
  assert.equal(deps.getGraphPayload().html.includes("<img"), false);
});

test("sem assinatura o Graph mantém somente o reply simples", async () => {
  const calls = [];
  await replyToMicrosoftMessage(
    USER_ID,
    { messageId: "message-id", message: "Sem assinatura" },
    {
      getAccessToken: async () => "token-not-logged",
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return new Response(null, { status: 202 });
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.endsWith("/messages/message-id/reply"), true);
  assert.equal(calls[0].options.method, "POST");
});

test("falha ao baixar assinatura ativa retorna SIGNATURE_DOWNLOAD_FAILED e não envia", async () => {
  const database = fakeSupabase({ download: null });
  database.storage.from = () => ({
    download: async () => ({ data: null, error: new Error("download failed") }),
  });

  await assert.rejects(
    getUserSignatureConfig(USER_ID, { supabase: database, downloadImage: true }),
    (error) => {
      assert.equal(error.publicCode, "SIGNATURE_DOWNLOAD_FAILED");
      assert.equal(error.safeToFallback, false);
      assert.deepEqual(error.signatureDebug, {
        enabled: true,
        auth_user_id_present: true,
        signature_service_received_string_id: true,
        signature_profile_found: true,
        profile_enabled: true,
        reply_enabled: true,
        path_found: true,
        has_signature: true,
        same_authenticated_user: true,
        storage_downloaded: false,
      });
      return true;
    },
  );
});

test("usuário A não pode carregar o path de assinatura do usuário B", async () => {
  const database = fakeSupabase({ path: "user-b/signature.png" });
  await assert.rejects(
    getUserSignatureConfig(USER_ID, { supabase: database, downloadImage: true }),
    (error) => error.publicCode === "SIGNATURE_DOWNLOAD_FAILED",
  );
});
test("erro da pipeline não expõe diagnóstico interno", () => {
  let statusCode;
  let responseBody;
  const response = {
    status(status) {
      statusCode = status;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
  };
  const error = Object.assign(new Error("Falha controlada na assinatura."), {
    statusCode: 502,
    diagnosticCode: "SIGNATURE_ATTACHMENT_FAILED",
    microsoftDiagnosticError: true,
    signatureDebug: {
      ...SUCCESSFUL_GRAPH_DEBUG,
      attachment_created: false,
      draft_sent: false,
      draftId: "não-pode-vazar",
      contentBytes: PNG.toString("base64"),
    },
  });

  errorMiddleware(error, { originalUrl: "/api/tickets/id/reply", method: "POST" }, response);

  assert.equal(statusCode, 502);
  assert.equal(responseBody.success, false);
  assert.equal(responseBody.code, "SIGNATURE_ATTACHMENT_FAILED");
  assert.equal(Object.hasOwn(responseBody, "signature_debug"), false);
});

test("signature_enabled=true permanece true da consulta até o payload Graph", async () => {
  const database = fakeSupabase({ enabled: true });
  const dependencies = replyDependencies(null);
  dependencies.getSignature = (authenticatedUserId, options) => {
    assert.equal(authenticatedUserId, USER_ID);
    assert.deepEqual(options, { downloadImage: true });
    return getUserSignatureConfig(authenticatedUserId, {
      ...options,
      supabase: database,
    });
  };

  const result = await sendAndPersistTicketReply(
    {
      ticket: {
        id: "ticket-shared-config",
        remetente_email: "requester@example.com",
        assunto: "Teste",
        outlook_last_message_id: "message-id",
      },
      userId: USER_ID,
      message: "Configuração compartilhada",
    },
    dependencies,
  );

  assert.equal(result.signatureDebug.profile_enabled, true);
  assert.equal(result.signatureDebug.reply_enabled, true);
  assert.equal(result.signatureDebug.path_found, true);
  assert.equal(result.signatureDebug.has_signature, true);
  assert.equal(database.query.userId, USER_ID);
  assert.equal(dependencies.getGraphPayload().html.includes("cid:smartdesk-signature"), true);
  assert.equal(dependencies.getGraphPayload().inlineAttachment.contentBytes, PNG.toString("base64"));
});
test("signature service rejeita formato incorreto de userId sem consultar users", async () => {
  for (const invalidUserId of [undefined, null, { userId: USER_ID }, []]) {
    const database = fakeSupabase();

    await assert.rejects(
      getUserSignatureConfig(invalidUserId, {
        supabase: database,
        downloadImage: true,
      }),
      (error) => {
        assert.equal(error.publicCode, "SIGNATURE_USER_ID_INVALID");
        assert.equal(error.signatureDebug.signature_service_received_string_id, false);
        return true;
      },
    );

    assert.equal(database.query.userId, null);
  }
});

test("controller de POST reply preserva req.user.id até a seleção do fluxo Graph", async () => {
  const authenticatedUserId = "555cdf54-1ec4-41a2-bef4-02a1d3745b21";
  const signaturePath = authenticatedUserId + "/signature.png";
  const database = fakeSupabase({
    rowUserId: authenticatedUserId,
    path: signaturePath,
  });
  let loadedSignature;
  let graphPayload;
  let responseStatus;
  let responseBody;
  let nextError;

  const req = {
    params: { id: "00000000-0000-4000-8000-000000000099" },
    body: { mensagem: "Resposta do atendente" },
    user: { id: authenticatedUserId },
  };
  const res = {
    status(status) {
      responseStatus = status;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
  };

  await responderTicket(
    req,
    res,
    (error) => {
      nextError = error;
    },
    {
      findTicket: async (ticketId) => ({
        id: ticketId,
        remetente_email: "requester@example.com",
        assunto: "Teste",
        prioridade: "Normal",
        outlook_last_message_id: "message-id",
      }),
      getSignature: getUserSignatureConfig,
      sendReply: (input, options) => {
        assert.equal(input.userId, authenticatedUserId);
        assert.equal(options.getSignature, getUserSignatureConfig);
        return sendAndPersistTicketReply(input, {
          getConnectionStatus: async () => ({
            connected: true,
            email: "agent@example.com",
          }),
          getSignature: async (userId, signatureOptions) => {
            loadedSignature = await options.getSignature(userId, {
              ...signatureOptions,
              supabase: database,
            });
            return loadedSignature;
          },
          replyWithMicrosoftGraph: async (userId, payload) => {
            assert.equal(userId, authenticatedUserId);
            assert.equal(loadedSignature.enabled, true);
            assert.equal(loadedSignature.profileEnabled, true);
            assert.equal(loadedSignature.signatureServiceReceivedStringId, true);
            assert.equal(loadedSignature.signatureProfileFound, true);
            assert.equal(loadedSignature.hasSignature, true);
            assert.equal(loadedSignature.sameAuthenticatedUser, true);
            assert.equal(loadedSignature.storagePath, signaturePath);
            graphPayload = payload;
            return { signatureDebug: SUCCESSFUL_GRAPH_DEBUG };
          },
          persistMessage: async (payload) => payload,
          helpdeskEmail: () => "helpdesk@example.com",
        });
      },
    },
  );

  assert.equal(nextError, undefined);
  assert.equal(responseStatus, 201);
  assert.equal(responseBody.success, true);
  assert.equal(responseBody.provider, "microsoft_graph");
  assert.equal(Object.hasOwn(responseBody, "signature_debug"), false);
  assert.equal(database.query.userId, authenticatedUserId);
  assert.equal(graphPayload.html.includes("cid:smartdesk-signature"), true);
});

test("perfil autenticado ausente interrompe o reply antes do Graph", async () => {
  const database = fakeSupabase({ rowFound: false });
  let graphCalled = false;

  await assert.rejects(
    sendAndPersistTicketReply(
      {
        ticket: {
          id: "ticket-profile-missing",
          remetente_email: "requester@example.com",
          assunto: "Teste",
          outlook_last_message_id: "message-id",
        },
        userId: USER_ID,
        message: "Não enviar sem resolver o perfil",
      },
      {
        getConnectionStatus: async () => ({
          connected: true,
          email: "agent@example.com",
        }),
        getSignature: (userId, options) =>
          getUserSignatureConfig(userId, {
            ...options,
            supabase: database,
          }),
        replyWithMicrosoftGraph: async () => {
          graphCalled = true;
        },
      },
    ),
    (error) => error.publicCode === "SIGNATURE_PROFILE_NOT_FOUND",
  );

  assert.equal(graphCalled, false);
});
