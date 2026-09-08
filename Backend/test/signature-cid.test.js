import assert from "node:assert/strict";
import { test } from "node:test";
import { getUserSignatureForReply } from "../src/services/signature.service.js";
import { replyToMicrosoftMessage } from "../src/services/microsoft-graph.service.js";
import { sendAndPersistTicketReply } from "../src/services/ticket-reply.service.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const USER_ID = "user-a";
const SIGNATURE_PATH = USER_ID + "/signature.png";

function fakeSupabase({ enabled = true, path = SIGNATURE_PATH, download = new Blob([PNG], { type: "image/png" }) } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      assert.equal(table, "users");
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({
          data: { signature_enabled: enabled, signature_storage_path: path },
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
    replyWithMicrosoftGraph: async (_userId, payload) => { graphPayload = payload; },
    persistMessage: async (payload) => { persisted = payload; return payload; },
    helpdeskEmail: () => "helpdesk@example.com",
    getGraphPayload: () => graphPayload,
    getPersisted: () => persisted,
  };
}

test("assinatura ativa baixa PNG do bucket Assinaturas", async () => {
  const database = fakeSupabase();
  const signature = await getUserSignatureForReply(USER_ID, { supabase: database });

  assert.deepEqual(database.calls, [SIGNATURE_PATH]);
  assert.equal(signature.storage_downloaded, true);
  assert.deepEqual(signature.image_bytes, PNG);
});

test("draft Graph usa createReply, PATCH HTML, attachment inline e send em ordem", async () => {
  const calls = [];
  const contentBytes = PNG.toString("base64");
  await replyToMicrosoftMessage(
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
            status: 200,
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
            return new Response(JSON.stringify({ id: "draft-2" }), { status: 200 });
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

test("reply com attachment inline persiste apenas a mensagem original e não expõe bytes nos logs", async () => {
  const signature = {
    enabled: true,
    has_signature: true,
    storage_path: SIGNATURE_PATH,
    image_bytes: PNG,
    storage_downloaded: true,
  };
  const deps = replyDependencies(signature);
  const originalMessage = "<script>log</script>";
  const logs = [];
  const originalConsoleLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    await sendAndPersistTicketReply(
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
  assert.equal(signature.storage_downloaded, false);
  assert.deepEqual(database.calls, []);

  const deps = replyDependencies(signature);
  await sendAndPersistTicketReply(
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
  assert.equal(deps.getGraphPayload().inlineAttachment, undefined);
  assert.equal(deps.getGraphPayload().html.includes("<img"), false);
});

test("falha ao baixar assinatura ativa retorna SIGNATURE_LOAD_FAILED e não envia", async () => {
  const database = fakeSupabase({ download: null });
  database.storage.from = () => ({
    download: async () => ({ data: null, error: new Error("download failed") }),
  });

  await assert.rejects(
    getUserSignatureForReply(USER_ID, { supabase: database }),
    (error) => {
      assert.equal(error.publicCode, "SIGNATURE_LOAD_FAILED");
      assert.equal(error.safeToFallback, false);
      return true;
    },
  );
});

test("usuário A não pode carregar o path de assinatura do usuário B", async () => {
  const database = fakeSupabase({ path: "user-b/signature.png" });
  await assert.rejects(
    getUserSignatureForReply(USER_ID, { supabase: database }),
    (error) => error.publicCode === "SIGNATURE_LOAD_FAILED",
  );
});
