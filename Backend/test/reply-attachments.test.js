import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  MAX_ATTACHMENT_SIZE_BYTES,
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

test("arquivo grande cria upload session oficial sem enviar os bytes", async () => {
  let request;
  const session = await createMicrosoftAttachmentUploadSession(
    "user-a",
    { draftId: "draft-1", attachment: { name: "large.zip", size: 10 * 1024 * 1024 } },
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
    AttachmentItem: { attachmentType: "file", name: "large.zip", size: 10 * 1024 * 1024, isInline: false },
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
