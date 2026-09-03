import assert from "node:assert/strict";
import { test } from "node:test";
import { getUserSignatureForReply } from "../src/services/signature.service.js";
import {
  buildInlineMimeReply,
  replyToMicrosoftMessage,
} from "../src/services/microsoft-graph.service.js";
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

test("assinatura ativa baixa PNG do bucket Assinaturas e monta MIME CID", async () => {
  const database = fakeSupabase();
  const signature = await getUserSignatureForReply(USER_ID, { supabase: database });

  assert.deepEqual(database.calls, [SIGNATURE_PATH]);
  assert.equal(signature.storage_downloaded, true);
  assert.deepEqual(signature.image_bytes, PNG);

  const contentId = "smartdesk-signature-test";
  const html = '<div>Mensagem segura</div><br><br><img src="cid:' + contentId + '" alt="Assinatura">';
  const encodedMime = buildInlineMimeReply({
    html,
    imageBytes: PNG,
    contentId,
  });
  const mime = Buffer.from(encodedMime, "base64").toString("utf8");

  assert.equal(mime.includes("multipart/related"), true);
  assert.equal(mime.includes("Content-Type: text/html; charset=UTF-8"), true);
  assert.equal(mime.includes('src="cid:smartdesk-signature-test"'), true);
  assert.equal(mime.includes("Content-Type: image/png"), true);
  assert.equal(mime.includes('Content-Disposition: inline; filename="signature.png"'), true);
  assert.equal(mime.includes("Content-Transfer-Encoding: base64"), true);
  assert.equal(mime.includes("Content-ID: <smartdesk-signature-test>"), true);
  assert.equal(mime.includes("iVBORw0KGgo="), true);
  assert.equal(mime.includes("supabase.co"), false);
});

test("reply Graph recebe MIME Base64 com Content-Type text/plain e 202 é sucesso", async () => {
  let request;
  await replyToMicrosoftMessage(
    USER_ID,
    {
      messageId: "message-id",
      message: "Mensagem original",
      mime: buildInlineMimeReply({
        html: '<div>Resposta</div><img src="cid:smartdesk-signature-test">',
        imageBytes: PNG,
        contentId: "smartdesk-signature-test",
      }),
    },
    {
      getAccessToken: async () => "token-not-logged",
      fetchImpl: async (url, options) => {
        request = { url, options };
        return new Response(null, { status: 202 });
      },
    },
  );

  assert.match(request.url, /\/reply$/);
  assert.equal(request.options.headers["Content-Type"], "text/plain");
  assert.equal(typeof request.options.body, "string");
  const decodedMime = Buffer.from(request.options.body, "base64").toString("utf8");
  assert.equal(decodedMime.includes("iVBORw0KGgo="), true);
});

test("reply com CID persiste somente a mensagem original e não expõe bytes nos logs", async () => {
  const signature = {
    enabled: true,
    has_signature: true,
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
  const mime = Buffer.from(payload.mime, "base64").toString("utf8");
  const contentId = mime.match(/Content-ID: <([^>]+)>/)?.[1];

  assert.ok(contentId);
  assert.equal(mime.includes('src="cid:' + contentId + '"'), true);
  assert.equal(mime.includes("&lt;script&gt;log&lt;/script&gt;"), true);
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
  assert.equal(deps.getGraphPayload().mime, undefined);
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
