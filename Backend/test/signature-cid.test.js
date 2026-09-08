import assert from "node:assert/strict";
import { test } from "node:test";
import { getUserSignatureForReply } from "../src/services/signature.service.js";
import { replyToMicrosoftMessage } from "../src/services/microsoft-graph.service.js";
import { sendAndPersistTicketReply } from "../src/services/ticket-reply.service.js";
import { errorMiddleware } from "../src/middlewares/error.middleware.js";

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
  const signature = await getUserSignatureForReply(USER_ID, { supabase: database });

  assert.equal(database.query.columns, "id, signature_enabled, signature_storage_path");
  assert.equal(database.query.filterColumn, "id");
  assert.equal(database.query.userId, USER_ID);
  assert.deepEqual(database.calls, [SIGNATURE_PATH]);
  assert.equal(signature.enabled, true);
  assert.equal(signature.has_signature, true);
  assert.equal(signature.storage_path, SIGNATURE_PATH);
  assert.equal(signature.storage_downloaded, true);
  assert.equal(signature.same_authenticated_user, true);
  assert.deepEqual(signature.image_bytes, PNG);
});

test("linha de usuário ausente não é convertida em enabled=false", async () => {
  const database = fakeSupabase({ rowFound: false });

  await assert.rejects(
    getUserSignatureForReply(USER_ID, { supabase: database }),
    (error) => {
      assert.match(error.message, /localizar a configuração da assinatura do usuário autenticado/);
      assert.deepEqual(error.signatureDebug, {
        enabled: false,
        path_found: false,
        same_authenticated_user: false,
      });
      return true;
    },
  );
  assert.equal(database.query.userId, USER_ID);
});

test("resultado de outro usuário é rejeitado", async () => {
  const database = fakeSupabase({ rowUserId: "user-b" });

  await assert.rejects(
    getUserSignatureForReply(USER_ID, { supabase: database }),
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
    has_signature: true,
    storage_path: SIGNATURE_PATH,
    same_authenticated_user: true,
    image_bytes: PNG,
    storage_downloaded: true,
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
    has_signature: true,
    storage_path: SIGNATURE_PATH,
    same_authenticated_user: true,
    image_bytes: PNG,
    storage_downloaded: true,
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
    path_found: true,
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
  const signature = await getUserSignatureForReply(USER_ID, { supabase: database });
  assert.equal(signature.enabled, false);
  assert.equal(signature.same_authenticated_user, true);
  assert.equal(signature.storage_downloaded, false);
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
  assert.deepEqual(replyResult.signatureDebug, { enabled: false });
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
    getUserSignatureForReply(USER_ID, { supabase: database }),
    (error) => {
      assert.equal(error.publicCode, "SIGNATURE_DOWNLOAD_FAILED");
      assert.equal(error.safeToFallback, false);
      assert.deepEqual(error.signatureDebug, {
        enabled: true,
        path_found: true,
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
    getUserSignatureForReply(USER_ID, { supabase: database }),
    (error) => error.publicCode === "SIGNATURE_DOWNLOAD_FAILED",
  );
});
test("erro da pipeline retorna success=false e debug somente booleano", () => {
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
  assert.equal(responseBody.signature_debug.attachment_created, false);
  assert.equal(responseBody.signature_debug.draft_sent, false);
  assert.equal(Object.hasOwn(responseBody.signature_debug, "draftId"), false);
  assert.equal(Object.hasOwn(responseBody.signature_debug, "contentBytes"), false);
});
