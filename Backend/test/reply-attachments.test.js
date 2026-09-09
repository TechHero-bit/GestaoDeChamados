import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import { adicionarAnexoSimplesResposta } from "../src/controllers/ticket.controller.js";
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

test("attachment simples vira um único fileAttachment não inline", async () => {
  let request;
  await addMicrosoftDraftFileAttachment(
    "user-a",
    { draftId: "draft/1", attachment: {
      name: "report.pdf", contentType: "application/pdf", bytes: Buffer.from("pdf"),
    } },
    {
      getAccessToken: async () => "secret-token",
      fetchImpl: async (url, options) => {
        request = { url, options };
        return new Response("{}", { status: 201 });
      },
    },
  );
  const body = JSON.parse(request.options.body);
  assert.equal(request.url.includes("draft%2F1/attachments"), true);
  assert.equal(body.isInline, false);
  assert.equal(body.contentBytes, Buffer.from("pdf").toString("base64"));
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

  const bytes = new Uint8Array(100 * 1024).fill(7);
  const manifest = [{ name: "print.png", size: bytes.length, contentType: "image/png" }];
  const form = new FormData();
  form.append("handle", "h".repeat(120));
  form.append("index", "0");
  form.append("mensagem", "Resposta com anexo");
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

  let uploadInput;
  let controllerResponse;
  const controllerRes = {
    status(status) { controllerResponse = { status }; return this; },
    json(body) { controllerResponse.body = body; return this; },
  };
  await adicionarAnexoSimplesResposta(req, controllerRes, assert.fail, {
    uploadAttachment: async (input) => {
      uploadInput = input;
      return { name: input.file.originalname, size: input.file.size, content_type: input.file.mimetype };
    },
  });
  assert.equal(controllerResponse.status, 201);
  assert.equal(controllerResponse.body.success, true);
  assert.equal(uploadInput.index, 0);
  assert.deepEqual(uploadInput.attachments, manifest);
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
