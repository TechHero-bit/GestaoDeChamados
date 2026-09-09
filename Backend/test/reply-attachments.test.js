import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import { adicionarAnexoSimplesResposta } from "../src/controllers/ticket.controller.js";
import { errorMiddleware } from "../src/middlewares/error.middleware.js";
import ticketRoutes from "../src/routes/ticket.routes.js";
import {
  MAX_ATTACHMENT_SIZE_BYTES,
  REPLY_ATTACHMENT_FILE_FIELD,
  SMALL_ATTACHMENT_LIMIT_BYTES,
  normalizeReplyAttachment,
} from "../src/services/reply-attachment-policy.service.js";
import {
  addMicrosoftDraftFileAttachment,
  createMicrosoftAttachmentUploadSession,
} from "../src/services/microsoft-graph.service.js";
import {
  createTicketReplyDraft,
  createTicketReplyUploadSession,
  sendTicketReplyDraft,
  uploadSmallTicketReplyAttachment,
} from "../src/services/ticket-reply-draft.service.js";

const previousSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = "test-secret-with-at-least-thirty-two-characters"; });
after(() => {
  if (previousSecret) process.env.JWT_SECRET = previousSecret;
  else delete process.env.JWT_SECRET;
});

const ticket = {
  id: "00000000-0000-4000-8000-000000000001",
  outlook_last_message_id: "message-id",
  remetente_email: "requester@example.com",
};
const connected = async () => ({ connected: true, email: "Agent@Example.com" });
const noSignature = async () => ({ enabled: false, hasSignature: false });

test("política separa attachment simples e upload session exatamente em 3 MiB", () => {
  assert.equal(normalizeReplyAttachment({ name: "a.pdf", size: SMALL_ATTACHMENT_LIMIT_BYTES - 1 }).kind, "simple");
  assert.equal(normalizeReplyAttachment({ name: "a.pdf", size: SMALL_ATTACHMENT_LIMIT_BYTES }).kind, "upload_session");
});

test("anexo acima de 150 MiB e extensões perigosas são bloqueados", () => {
  assert.throws(
    () => normalizeReplyAttachment({ name: "a.pdf", size: MAX_ATTACHMENT_SIZE_BYTES + 1 }),
    /excede o limite máximo/,
  );
  assert.throws(() => normalizeReplyAttachment({ name: "malware.exe", size: 10 }), /não é permitido/);
});

function assertSmallAttachmentGraphRequest(request, { draftId, name, contentType, bytes }) {
  assert.equal(
    request.url,
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(draftId)}/attachments`,
  );
  assert.equal(request.options.method, "POST");
  assert.equal(new Headers(request.options.headers).get("Content-Type"), "application/json");
  const body = JSON.parse(request.options.body);
  assert.deepEqual(Object.keys(body).sort(), [
    "@odata.type", "contentBytes", "contentType", "isInline", "name",
  ].sort());
  assert.equal(body["@odata.type"], "#microsoft.graph.fileAttachment");
  assert.equal(body.name, name);
  assert.equal(body.contentType, contentType);
  assert.equal(body.isInline, false);
  assert.equal("contentId" in body, false);
  assert.equal(typeof body.contentBytes, "string");
  assert.equal(body.contentBytes.startsWith("data:"), false);
  assert.deepEqual(Buffer.from(body.contentBytes, "base64"), bytes);
}

test("PDF de 1 MB gera fileAttachment estrito e Base64 reversível", async () => {
  const bytes = Buffer.alloc(1024 * 1024, 11);
  let request;
  await addMicrosoftDraftFileAttachment(
    "user-a",
    { draftId: "draft/1", attachment: {
      name: "report.pdf", size: bytes.length, contentType: "application/pdf", bytes,
    } },
    {
      getAccessToken: async () => "secret-token",
      fetchImpl: async (url, options) => {
        request = { url, options };
        return new Response("{}", { status: 201 });
      },
    },
  );
  assertSmallAttachmentGraphRequest(request, {
    draftId: "draft/1", name: "report.pdf", contentType: "application/pdf", bytes,
  });
});

test("rota real de attachment recebe multipart PNG de 100 KB no campo attachment", async () => {
  const authLayerIndex = ticketRoutes.stack.findIndex((layer) => layer.name === "authenticate");
  const routeLayerIndex = ticketRoutes.stack.findIndex(
    (layer) => layer.route?.path === "/:id/reply/draft/attachments",
  );
  assert.ok(authLayerIndex >= 0 && authLayerIndex < routeLayerIndex, "a autenticação deve preceder a rota");

  const routeLayer = ticketRoutes.stack[routeLayerIndex];
  assert.equal(routeLayer.route.methods.post, true);
  const multipartLayer = routeLayer.route.stack.find((layer) => layer.name === "multipartParser");
  assert.ok(multipartLayer, "a rota deve registrar o middleware multipart");

  const bytes = Buffer.alloc(100 * 1024, 7);
  const manifest = [{ name: "print.png", size: bytes.length, contentType: "image/png" }];
  const draft = await createFlow(manifest);
  const form = new FormData();
  form.append("handle", draft.handle);
  form.append("index", "0");
  form.append("mensagem", "Mensagem da timeline");
  form.append("attachments", JSON.stringify(manifest));
  form.append(REPLY_ATTACHMENT_FILE_FIELD, new Blob([bytes], { type: "image/png" }), "print.png");
  const browserRequest = new Request("http://localhost/upload", { method: "POST", body: form });
  const req = Readable.from([Buffer.from(await browserRequest.arrayBuffer())]);
  req.headers = { "content-type": browserRequest.headers.get("content-type") };
  req.params = { id: ticket.id };
  req.user = { id: "user-a" };

  let parserResponse;
  const parserRes = {
    status(status) { parserResponse = { status }; return this; },
    json(body) { parserResponse.body = body; return this; },
  };
  await new Promise((resolve, reject) => {
    multipartLayer.handle(req, parserRes, (error) => error ? reject(error) : resolve());
  });
  assert.equal(parserResponse, undefined);
  assert.equal(req.file.fieldname, REPLY_ATTACHMENT_FILE_FIELD);
  assert.equal(req.file.originalname, "print.png");
  assert.equal(req.file.mimetype, "image/png");
  assert.equal(req.file.size, 100 * 1024);
  assert.equal(req.file.buffer.length, 100 * 1024);

  let graphRequest;
  let controllerResponse;
  const controllerRes = {
    status(status) { controllerResponse = { status }; return this; },
    json(body) { controllerResponse.body = body; return this; },
  };
  await adicionarAnexoSimplesResposta(req, controllerRes, assert.fail, {
    uploadAttachment: (input) => uploadSmallTicketReplyAttachment(input, {
      addAttachment: (userId, payload) => addMicrosoftDraftFileAttachment(userId, payload, {
        getAccessToken: async () => "secret-token",
        fetchImpl: async (url, options) => {
          graphRequest = { url, options };
          return new Response("{}", { status: 201 });
        },
      }),
    }),
  });
  assert.equal(controllerResponse.status, 201);
  assert.equal(controllerResponse.body.success, true);
  assertSmallAttachmentGraphRequest(graphRequest, {
    draftId: "draft-1", name: "print.png", contentType: "image/png", bytes,
  });
});

test("erro percorre Graph, draft service, controller e error middleware sem perder diagnóstico seguro", async () => {
  const bytes = Buffer.alloc(100 * 1024, 5);
  const attachments = [{ name: "print.png", size: bytes.length, contentType: "image/png" }];
  const draft = await createFlow(attachments);
  const req = {
    params: { id: ticket.id },
    user: { id: "user-a" },
    multipartFields: {
      handle: draft.handle,
      index: "0",
      mensagem: "Mensagem da timeline",
      attachments: JSON.stringify(attachments),
    },
    file: {
      originalname: "print.png",
      mimetype: "image/png",
      size: bytes.length,
      buffer: bytes,
    },
  };
  let graphErrorInstance;
  let controllerError;
  const unexpectedSuccess = {
    status() { return this; },
    json() { assert.fail("o controller não deve responder sucesso"); },
  };
  await adicionarAnexoSimplesResposta(req, unexpectedSuccess, (error) => {
    controllerError = error;
  }, {
    uploadAttachment: (input) => uploadSmallTicketReplyAttachment(input, {
      addAttachment: async (userId, payload) => {
        try {
          return await addMicrosoftDraftFileAttachment(userId, payload, {
            getAccessToken: async () => "secret-token",
            fetchImpl: async () => new Response(JSON.stringify({
              error: { code: "ErrorInvalidRequest", message: "sensitive graph detail" },
            }), { status: 400, headers: { "Content-Type": "application/json" } }),
          });
        } catch (error) {
          graphErrorInstance = error;
          throw error;
        }
      },
    }),
  });

  assert.equal(controllerError, graphErrorInstance, "draft service e controller devem preservar o mesmo Error");
  assert.equal(controllerError.code, "GRAPH_ATTACHMENT_FAILED");
  assert.equal(controllerError.statusCode, 502);
  assert.equal(controllerError.graphStatus, 400);
  assert.equal(controllerError.graphError, "ErrorInvalidRequest");
  assert.equal(controllerError.attachmentStrategy, "small");

  let publicResponse;
  const res = {
    status(status) { publicResponse = { status }; return this; },
    json(body) { publicResponse.body = body; return this; },
  };
  errorMiddleware(controllerError, { method: "POST", originalUrl: "/attachments" }, res, () => {});
  assert.deepEqual(publicResponse, {
    status: 502,
    body: {
      success: false,
      message: "O Microsoft Outlook não aceitou a operação com o anexo.",
      code: "GRAPH_ATTACHMENT_FAILED",
      graph_status: 400,
      graph_error: "ErrorInvalidRequest",
      attachment_strategy: "small",
    },
  });
  const serialized = JSON.stringify(publicResponse);
  assert.equal(serialized.includes("sensitive graph detail"), false);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("draft-1"), false);
  assert.equal(serialized.includes(bytes.toString("base64")), false);
});

test("arquivo de 5 MB cria upload session oficial sem enviar os bytes", async () => {
  let request;
  const fileSize = 5 * 1024 * 1024;
  const session = await createMicrosoftAttachmentUploadSession(
    "user-a",
    { draftId: "draft-1", attachment: { name: "large.zip", size: fileSize } },
    {
      getAccessToken: async () => "secret-token",
      fetchImpl: async (url, options) => {
        request = { url, options };
        return new Response(JSON.stringify({
          uploadUrl: "https://upload.example/capability-secret",
          expirationDateTime: "2026-09-09T18:00:00Z",
          nextExpectedRanges: ["0-"],
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      },
    },
  );
  assert.equal(request.url.endsWith("/attachments/createUploadSession"), true);
  assert.deepEqual(JSON.parse(request.options.body), {
    AttachmentItem: { attachmentType: "file", name: "large.zip", size: fileSize, isInline: false },
  });
  assert.equal(request.options.body.includes("contentBytes"), false);
  assert.equal(session.uploadUrl, "https://upload.example/capability-secret");
});

async function createFlow(attachments, signature = null) {
  return createTicketReplyDraft(
    { ticket, userId: "user-a", message: "Mensagem da timeline", attachments },
    {
      getConnectionStatus: connected,
      getSignature: async () => signature || noSignature(),
      createDraft: async (_userId, payload) => ({
        draftId: "draft-1",
        signatureAdded: Boolean(payload.inlineAttachment),
      }),
    },
  );
}

test("draft exige Outlook conectado quando há anexos", async () => {
  await assert.rejects(
    createTicketReplyDraft(
      { ticket, userId: "user-a", message: "Mensagem", attachments: [{ name: "a.pdf", size: 10, contentType: "application/pdf" }] },
      { getConnectionStatus: async () => ({ connected: false }), createDraft: async () => assert.fail() },
    ),
    /conecte sua conta Microsoft Outlook/,
  );
});

test("handle vincula usuário, ticket, mensagem e manifesto", async () => {
  const attachments = [{ name: "large.pdf", size: SMALL_ATTACHMENT_LIMIT_BYTES, contentType: "application/pdf" }];
  const draft = await createFlow(attachments);
  await assert.rejects(
    createTicketReplyUploadSession(
      { ticketId: ticket.id, userId: "user-b", handle: draft.handle, message: "Mensagem da timeline", attachments, index: 0 },
      { createUploadSession: async () => assert.fail() },
    ),
    /inválido ou expirou/,
  );
  await assert.rejects(
    createTicketReplyUploadSession(
      { ticketId: ticket.id, userId: "user-a", handle: draft.handle, message: "Mensagem alterada", attachments, index: 0 },
      { createUploadSession: async () => assert.fail() },
    ),
    /dados do rascunho foram alterados/,
  );
});

test("arquivo pequeno é validado contra tamanho declarado antes do Graph", async () => {
  const attachments = [{ name: "small.pdf", size: 3, contentType: "application/pdf" }];
  const draft = await createFlow(attachments);
  await assert.rejects(
    uploadSmallTicketReplyAttachment(
      { ticketId: ticket.id, userId: "user-a", handle: draft.handle, message: "Mensagem da timeline", attachments, index: 0,
        file: { size: 2, buffer: Buffer.from("xx") } },
      { addAttachment: async () => assert.fail() },
    ),
    /não corresponde/,
  );
});

test("falha ou ausência de qualquer anexo impede o envio do draft", async () => {
  const attachments = [
    { name: "one.pdf", size: 10, contentType: "application/pdf" },
    { name: "two.zip", size: SMALL_ATTACHMENT_LIMIT_BYTES, contentType: "application/zip" },
  ];
  const draft = await createFlow(attachments);
  let sent = false;
  await assert.rejects(
    sendTicketReplyDraft(
      { ticket, userId: "user-a", handle: draft.handle, message: "Mensagem da timeline", attachments },
      {
        getConnectionStatus: connected,
        listAttachments: async () => [{ name: "one.pdf", size: 10, isInline: false }],
        sendDraft: async () => { sent = true; },
      },
    ),
    /Nem todos os anexos/,
  );
  assert.equal(sent, false);
});

test("múltiplos anexos só enviam após todos concluídos e timeline não recebe bytes", async () => {
  const attachments = [
    { name: "one.pdf", size: 10, contentType: "application/pdf" },
    { name: "two.zip", size: SMALL_ATTACHMENT_LIMIT_BYTES, contentType: "application/zip" },
  ];
  const draft = await createFlow(attachments);
  const calls = [];
  const result = await sendTicketReplyDraft(
    { ticket, userId: "user-a", handle: draft.handle, message: "Mensagem da timeline", attachments },
    {
      getConnectionStatus: connected,
      listAttachments: async () => attachments.map(({ name, size }) => ({ name, size, isInline: false })),
      sendDraft: async () => calls.push("send"),
      persistMessage: async (payload) => { calls.push("persist"); return payload; },
    },
  );
  assert.deepEqual(calls, ["send", "persist"]);
  assert.equal(result.message.corpo_mensagem, "Mensagem da timeline");
  assert.equal(JSON.stringify(result).includes("contentBytes"), false);
  assert.equal(JSON.stringify(result).includes("uploadUrl"), false);
});

test("assinatura e anexo grande coexistem e a assinatura é obrigatória no draft", async () => {
  const attachments = [{ name: "large.pdf", size: SMALL_ATTACHMENT_LIMIT_BYTES, contentType: "application/pdf" }];
  const draft = await createFlow(attachments, {
    enabled: true, hasSignature: true, imageBytes: Buffer.from("png"),
  });
  let sent = false;
  await sendTicketReplyDraft(
    { ticket, userId: "user-a", handle: draft.handle, message: "Mensagem da timeline", attachments },
    {
      getConnectionStatus: connected,
      listAttachments: async () => [
        { name: "large.pdf", size: SMALL_ATTACHMENT_LIMIT_BYTES, isInline: false },
        { name: "signature.png", size: 3, isInline: true, contentId: "smartdesk-signature" },
      ],
      sendDraft: async () => { sent = true; },
      persistMessage: async (payload) => payload,
    },
  );
  assert.equal(draft.signature_added, true);
  assert.equal(sent, true);
});
