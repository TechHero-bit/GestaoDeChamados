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
  buildRegularAttachmentPayload,
  buildSignatureAttachmentPayload,
  createMicrosoftAttachmentUploadSession,
  createMicrosoftReplyDraft,
  listMicrosoftDraftAttachments,
  sendMicrosoftReplyDraft,
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

function graphAttachment(name, size, id = "attachment-1") {
  return { id, name, size, isInline: false };
}

function confirmedSmallUpload(name, size, id = "attachment-1") {
  return {
    attachmentId: id,
    name,
    isInline: false,
    graphSize: size,
    parsedBufferSize: size,
    base64RoundtripValid: true,
    graphCreateConfirmed: true,
  };
}

test("assinatura e anexo comum usam o mesmo builder de fileAttachment", () => {
  const contentBytes = Buffer.from("same-bytes").toString("base64");
  const signature = buildSignatureAttachmentPayload({
    contentBytes,
    contentId: "smartdesk-signature",
  });
  const regular = buildRegularAttachmentPayload({
    name: "print.png",
    contentType: "image/png",
    contentBytes,
  });

  assert.equal(signature["@odata.type"], regular["@odata.type"]);
  assert.equal(signature["@odata.type"], "#microsoft.graph.fileAttachment");
  assert.equal(signature.isInline, true);
  assert.equal(signature.contentId, "smartdesk-signature");
  assert.equal(regular.isInline, false);
  assert.equal("contentId" in regular, false);
  assert.equal("contentLocation" in signature, false);
  assert.equal("contentLocation" in regular, false);
  assert.equal(signature.contentBytes, regular.contentBytes);
});

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
        return Response.json(graphAttachment("report.pdf", bytes.length), { status: 201 });
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
          return Response.json(graphAttachment("print.png", bytes.length), { status: 201 });
        },
      }),
    }),
  });
  assert.equal(controllerResponse.status, 201);
  assert.equal(controllerResponse.body.success, true);
  assert.equal(controllerResponse.body.data.small_attachment_created, true);
  assert.equal(typeof controllerResponse.body.data.handle, "string");
  assert.equal(JSON.stringify(controllerResponse.body).includes("attachmentId"), false);
  const handlePayload = JSON.parse(Buffer.from(
    controllerResponse.body.data.handle.split(".")[1],
    "base64url",
  ));
  assert.equal(JSON.stringify(handlePayload).includes("attachment-1"), false);
  assert.equal(typeof handlePayload.smallUploadReceipts[0].attachmentIdDigest, "string");
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
      attachment_debug: {
        draft_exists: true,
        draft_sent_before_attachment: false,
        same_draft: true,
        payload_direct_object: true,
        odata_type_matches_signature: true,
        buffer_present: true,
        base64_roundtrip_valid: true,
      },
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

test("assinatura, anexo comum, verificação e send usam o mesmo draft na ordem correta", async () => {
  const signatureBytes = Buffer.from("signature-png");
  const regularBytes = Buffer.alloc(100 * 1024, 13);
  const attachments = [{ name: "print.png", size: regularBytes.length, contentType: "image/png" }];
  const operations = [];
  const draftUrls = [];
  const graphDependencies = {
    getAccessToken: async () => "secret-token",
    fetchImpl: async (url, options = {}) => {
      const method = options.method || "GET";
      if (url.endsWith("/createReply")) {
        operations.push("createReply");
        return new Response(JSON.stringify({ id: "same-draft" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      draftUrls.push(url);
      if (method === "PATCH") {
        operations.push("patch");
        return new Response("{}", { status: 200 });
      }
      if (method === "POST" && url.endsWith("/attachments")) {
        const payload = JSON.parse(options.body);
        assert.equal("attachment" in payload, false, "payload deve ser o objeto direto");
        assert.equal(payload["@odata.type"], "#microsoft.graph.fileAttachment");
        operations.push(payload.isInline ? "signature" : "regular");
        return Response.json(
          payload.isInline
            ? { id: "signature-id", name: "signature.png", size: signatureBytes.length, isInline: true }
            : graphAttachment("print.png", regularBytes.length, "regular-id"),
          { status: 201 },
        );
      }
      if (method === "GET" && url.includes("/attachments?")) {
        assert.equal(url.includes("contentId"), false, "$select não deve projetar propriedade derivada");
        operations.push("list");
        return new Response(JSON.stringify({ value: [
          { name: "signature.png", size: signatureBytes.length, isInline: true },
          { id: "regular-id", name: "print.png", size: regularBytes.length, isInline: false },
        ] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (method === "POST" && url.endsWith("/send")) {
        operations.push("send");
        return new Response(null, { status: 202 });
      }
      assert.fail(`chamada Graph inesperada: ${method}`);
    },
  };

  const draft = await createTicketReplyDraft(
    { ticket, userId: "user-a", message: "Mensagem da timeline", attachments },
    {
      getConnectionStatus: connected,
      getSignature: async () => ({
        enabled: true,
        hasSignature: true,
        imageBytes: signatureBytes,
      }),
      createDraft: (userId, payload) => createMicrosoftReplyDraft(userId, payload, graphDependencies),
    },
  );
  const uploaded = await uploadSmallTicketReplyAttachment(
    {
      ticketId: ticket.id,
      userId: "user-a",
      handle: draft.handle,
      message: "Mensagem da timeline",
      attachments,
      index: 0,
      file: { size: regularBytes.length, buffer: regularBytes },
    },
    {
      addAttachment: (userId, payload) => addMicrosoftDraftFileAttachment(
        userId,
        payload,
        graphDependencies,
      ),
    },
  );
  await sendTicketReplyDraft(
    {
      ticket,
      userId: "user-a",
      handle: uploaded.handle,
      message: "Mensagem da timeline",
      attachments,
    },
    {
      getConnectionStatus: connected,
      listAttachments: (userId, draftId, context) => listMicrosoftDraftAttachments(
        userId,
        draftId,
        { ...graphDependencies, ...context },
      ),
      sendDraft: (userId, draftId, context) => sendMicrosoftReplyDraft(
        userId,
        draftId,
        { ...graphDependencies, ...context },
      ),
      persistMessage: async (payload) => payload,
    },
  );

  assert.deepEqual(operations, ["createReply", "patch", "signature", "regular", "list", "send"]);
  assert.equal(operations.filter((operation) => operation === "send").length, 1);
  assert.equal(draftUrls.every((url) => url.includes("/messages/same-draft")), true);
});

test("BadRequest na verificação de attachments mantém strategy small e debug seguro", async () => {
  const attachments = [{ name: "print.png", size: 100 * 1024, contentType: "image/png" }];
  const draft = await createFlow(attachments, {
    enabled: true,
    hasSignature: true,
    imageBytes: Buffer.from("signature"),
  });
  let failure;
  try {
    await sendTicketReplyDraft(
      {
        ticket,
        userId: "user-a",
        handle: draft.handle,
        message: "Mensagem da timeline",
        attachments,
      },
      {
        getConnectionStatus: connected,
        listAttachments: (userId, draftId, context) => listMicrosoftDraftAttachments(
          userId,
          draftId,
          {
            ...context,
            getAccessToken: async () => "secret-token",
            fetchImpl: async (url) => {
              assert.equal(url.includes("contentId"), false);
              return new Response(JSON.stringify({
                error: { code: "BadRequest", message: "sensitive Graph message" },
              }), { status: 400, headers: { "Content-Type": "application/json" } });
            },
          },
        ),
        sendDraft: async () => assert.fail("não deve enviar após falha de verificação"),
        persistMessage: async () => assert.fail("não deve persistir após falha de verificação"),
      },
    );
  } catch (error) {
    failure = error;
  }

  assert.equal(failure.graphStatus, 400);
  assert.equal(failure.graphError, "BadRequest");
  assert.equal(failure.attachmentStrategy, "small");
  assert.deepEqual(failure.attachmentDebug, {
    draft_exists: true,
    draft_sent_before_attachment: false,
    same_draft: true,
    payload_direct_object: true,
    odata_type_matches_signature: true,
    buffer_present: true,
    base64_roundtrip_valid: true,
  });
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

test("buffer multipart truncado bloqueia antes de chamar o Graph", async () => {
  const attachments = [{ name: "small.pdf", size: 3, contentType: "application/pdf" }];
  const draft = await createFlow(attachments);
  await assert.rejects(
    uploadSmallTicketReplyAttachment(
      {
        ticketId: ticket.id, userId: "user-a", handle: draft.handle,
        message: "Mensagem da timeline", attachments, index: 0,
        file: { size: 3, buffer: Buffer.from("xx") },
      },
      { addAttachment: async () => assert.fail("Graph não deve receber buffer truncado") },
    ),
    /não corresponde/,
  );
});

test("mismatch isolado de Graph.size não invalida SMALL confirmado pelo id do POST 201", async () => {
  const attachments = [{ name: "print.png", size: 100 * 1024, contentType: "image/png" }];
  const draft = await createFlow(attachments, {
    enabled: true, hasSignature: true, imageBytes: Buffer.from("signature"),
  });
  const uploaded = await uploadSmallTicketReplyAttachment(
    {
      ticketId: ticket.id, userId: "user-a", handle: draft.handle,
      message: "Mensagem da timeline", attachments, index: 0,
      file: { size: attachments[0].size, buffer: Buffer.alloc(attachments[0].size) },
    },
    { addAttachment: async () => confirmedSmallUpload("print.png", attachments[0].size) },
  );
  let sent = false;
  const result = await sendTicketReplyDraft(
    {
      ticket, userId: "user-a", handle: uploaded.handle,
      message: "Mensagem da timeline", attachments,
    },
    {
      getConnectionStatus: connected,
      listAttachments: async () => [
        graphAttachment("print.png", attachments[0].size + 1),
        { name: "signature.png", size: 10, isInline: true },
      ],
      sendDraft: async () => { sent = true; },
      persistMessage: async (payload) => payload,
    },
  );
  assert.equal(sent, true);
  assert.deepEqual(result.attachmentDebug, {
    expected_regular_count: 1,
    graph_regular_count: 1,
    expected_size: 100 * 1024,
    parsed_buffer_size: 100 * 1024,
    graph_size: (100 * 1024) + 1,
    size_delta: 1,
    parser_size_matches: true,
    base64_roundtrip_valid: true,
    graph_create_confirmed: true,
    signature_expected: true,
    signature_found: true,
    regular_name_matches: true,
    regular_size_matches: false,
    regular_inline_matches: true,
    all_regular_found: true,
    small_upload_confirmed: true,
    graph_regular_attachment_found: true,
    draft_handle_current: true,
    manifest_attachment_count: 1,
    ready_to_send: true,
  });
});

test("nome usa a mesma normalização NFC no manifesto, upload e retorno do Graph", async () => {
  const decomposedName = "relato e\u0301.png";
  const attachments = [{ name: ` ${decomposedName} `, size: 1024, contentType: "image/png" }];
  const draft = await createFlow(attachments);
  let uploadedName;
  const uploaded = await uploadSmallTicketReplyAttachment(
    {
      ticketId: ticket.id, userId: "user-a", handle: draft.handle,
      message: "Mensagem da timeline", attachments, index: 0,
      file: { size: 1024, buffer: Buffer.alloc(1024) },
    },
    { addAttachment: async (_userId, payload) => {
      uploadedName = payload.attachment.name;
      return confirmedSmallUpload("relato é.png", 1024);
    } },
  );
  let sent = false;
  await sendTicketReplyDraft(
    {
      ticket, userId: "user-a", handle: uploaded.handle,
      message: "Mensagem da timeline", attachments,
    },
    {
      getConnectionStatus: connected,
      listAttachments: async () => [graphAttachment(` ${decomposedName} `, 1024)],
      sendDraft: async () => { sent = true; },
      persistMessage: async (payload) => payload,
    },
  );
  assert.equal(uploadedName, "relato é.png");
  assert.equal(sent, true);
});

test("handle anterior ao 201 do upload pequeno é stale e não envia", async () => {
  const attachments = [{ name: "print.png", size: 1024, contentType: "image/png" }];
  const draft = await createFlow(attachments);
  await uploadSmallTicketReplyAttachment(
    {
      ticketId: ticket.id, userId: "user-a", handle: draft.handle,
      message: "Mensagem da timeline", attachments, index: 0,
      file: { size: 1024, buffer: Buffer.alloc(1024) },
    },
    { addAttachment: async () => confirmedSmallUpload("print.png", 1024) },
  );
  let sent = false;
  await assert.rejects(
    sendTicketReplyDraft(
      {
        ticket, userId: "user-a", handle: draft.handle,
        message: "Mensagem da timeline", attachments,
      },
      {
        getConnectionStatus: connected,
        listAttachments: async () => [{ name: "print.png", size: 1024, isInline: false }],
        sendDraft: async () => { sent = true; },
      },
    ),
    (error) => error.attachmentDebug?.draft_handle_current === false
      && error.attachmentDebug?.small_upload_confirmed === false,
  );
  assert.equal(sent, false);
});

test("SMALL confirmado ainda bloqueia se sumir, mudar de nome ou virar inline", async (t) => {
  const cases = [
    { name: "ausente", graphList: [] },
    { name: "nome diferente", graphList: [graphAttachment("other.png", 1024)] },
    {
      name: "isInline incorreto",
      graphList: [{ id: "attachment-1", name: "print.png", size: 1024, isInline: true }],
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const attachments = [{ name: "print.png", size: 1024, contentType: "image/png" }];
      const draft = await createFlow(attachments);
      const uploaded = await uploadSmallTicketReplyAttachment(
        {
          ticketId: ticket.id, userId: "user-a", handle: draft.handle,
          message: "Mensagem da timeline", attachments, index: 0,
          file: { size: 1024, buffer: Buffer.alloc(1024) },
        },
        { addAttachment: async () => confirmedSmallUpload("print.png", 1024) },
      );
      let sent = false;
      let failure;
      try {
        await sendTicketReplyDraft(
          {
            ticket, userId: "user-a", handle: uploaded.handle,
            message: "Mensagem da timeline", attachments,
          },
          {
            getConnectionStatus: connected,
            listAttachments: async () => scenario.graphList,
            sendDraft: async () => { sent = true; },
          },
        );
      } catch (error) {
        failure = error;
      }
      assert.equal(failure?.publicCode, "ATTACHMENTS_INCOMPLETE");
      assert.equal(failure?.attachmentDebug?.ready_to_send, false);
      assert.equal(sent, false);

      if (scenario.name === "ausente") {
        let publicResponse;
        const res = {
          status(status) { publicResponse = { status }; return this; },
          json(body) { publicResponse.body = body; return this; },
        };
        errorMiddleware(failure, { method: "POST", originalUrl: "/send" }, res, () => {});
        assert.equal(publicResponse.status, 409);
        assert.equal(publicResponse.body.attachment_debug.expected_size, 1024);
        assert.equal(publicResponse.body.attachment_debug.parsed_buffer_size, 1024);
        assert.equal(publicResponse.body.attachment_debug.graph_size, 0);
        assert.equal(publicResponse.body.attachment_debug.size_delta, -1024);
        assert.equal(JSON.stringify(publicResponse).includes("attachment-1"), false);
        assert.equal(JSON.stringify(publicResponse).includes("print.png"), false);
      }
    });
  }
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
  const uploaded = await uploadSmallTicketReplyAttachment(
    {
      ticketId: ticket.id,
      userId: "user-a",
      handle: draft.handle,
      message: "Mensagem da timeline",
      attachments,
      index: 0,
      file: { size: 10, buffer: Buffer.alloc(10) },
    },
    { addAttachment: async () => confirmedSmallUpload("one.pdf", 10) },
  );
  const calls = [];
  const result = await sendTicketReplyDraft(
    { ticket, userId: "user-a", handle: uploaded.handle, message: "Mensagem da timeline", attachments },
    {
      getConnectionStatus: connected,
      listAttachments: async () => attachments.map(({ name, size }, index) =>
        graphAttachment(name, size, index === 0 ? "attachment-1" : "large-attachment")),
      sendDraft: async () => calls.push("send"),
      persistMessage: async (payload) => { calls.push("persist"); return payload; },
    },
  );
  assert.deepEqual(calls, ["send", "persist"]);
  assert.equal(result.message.corpo_mensagem, "Mensagem da timeline");
  assert.equal(JSON.stringify(result).includes("contentBytes"), false);
  assert.equal(JSON.stringify(result).includes("uploadUrl"), false);
});

test("attachment regular inesperado continua bloqueando e usa somente contadores", async () => {
  const attachments = [
    { name: "one.pdf", size: SMALL_ATTACHMENT_LIMIT_BYTES, contentType: "application/pdf" },
    { name: "two.zip", size: SMALL_ATTACHMENT_LIMIT_BYTES, contentType: "application/zip" },
  ];
  const draft = await createFlow(attachments);
  let failure;
  try {
    await sendTicketReplyDraft(
      { ticket, userId: "user-a", handle: draft.handle, message: "Mensagem da timeline", attachments },
      {
        getConnectionStatus: connected,
        listAttachments: async () => [
          ...attachments.map(({ name, size }) => ({ name, size, isInline: false })),
          { name: "extra.pdf", size: 12, isInline: false },
          { name: "signature.png", size: 8, isInline: true },
        ],
        sendDraft: async () => assert.fail("não deve enviar com attachment inesperado"),
      },
    );
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.attachmentDebug.expected_count, 2);
  assert.equal(failure.attachmentDebug.found_count, 2);
  assert.equal(failure.attachmentDebug.missing_count, 0);
  assert.equal(failure.attachmentDebug.unexpected_count, 1);
  assert.equal("regular_name_matches" in failure.attachmentDebug, false);
  assert.equal(failure.attachmentDebug.ready_to_send, false);
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
