import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getCandidateImage,
  getSignaturePhoto,
} from "../src/services/signature-request.service.js";

const requestId = "00000000-0000-4000-8000-000000000001";
const ticketId = "00000000-0000-4000-8000-000000000002";
const attachmentId = "00000000-0000-4000-8000-000000000003";
const imageBytes = Buffer.from("89504e470d0a1a0a", "hex");

function fakeSupabase({ status = "Disponivel", stored = true, manual = false } = {}) {
  const downloads = [];
  const request = {
    id: requestId,
    source_ticket_id: ticketId,
    photo_attachment_id: manual ? null : attachmentId,
    photo_storage_path: manual ? "requests/manual/photos/photo.png" : null,
  };
  const attachment = {
    id: attachmentId,
    ticket_message_id: "message-1",
    storage_path: "tickets/ticket-1/photo.png",
    content_type: "image/png",
    processing_status: status,
    processing_error: status === "Falhou" ? "OBJECT_NOT_FOUND" : null,
  };
  return {
    downloads,
    from(table) {
      const filters = {};
      return {
        select() { return this; },
        eq(field, value) { filters[field] = value; return this; },
        async maybeSingle() {
          const data = table === "signature_requests" ? request
            : table === "signature_request_images" ? { id: "candidate-1" }
            : table === "ticket_message_attachments" ? attachment
            : table === "ticket_messages" ? { ticket_id: ticketId }
            : null;
          if (table === "signature_requests") assert.equal(filters.id, requestId);
          return { data, error: null };
        },
      };
    },
    storage: {
      from(bucket) {
        return {
          async download(path) {
            downloads.push({ bucket, path });
            return stored
              ? { data: new Blob([imageBytes], { type: "image/png" }), error: null }
              : { data: null, error: { statusCode: 404 } };
          },
        };
      },
    },
  };
}

test("fotografia do anexo é lida pelo servidor do bucket privado", async () => {
  const supabase = fakeSupabase();
  const image = await getSignaturePhoto(requestId, { supabase });
  assert.deepEqual(image.buffer, imageBytes);
  assert.equal(image.contentType, "image/png");
  assert.deepEqual(supabase.downloads, [{
    bucket: "AnexosChamados",
    path: "tickets/ticket-1/photo.png",
  }]);
});

test("foto manual usa bucket separado sem mudar a assinatura do administrador", async () => {
  const supabase = fakeSupabase({ manual: true });
  const image = await getSignaturePhoto(requestId, { supabase });
  assert.deepEqual(image.buffer, imageBytes);
  assert.equal(supabase.downloads[0].bucket, "AssinaturasColaboradores");
});

test("candidato disponível mas ausente no storage não é mostrado como foto pronta", async () => {
  const supabase = fakeSupabase({ stored: false });
  await assert.rejects(
    getCandidateImage(requestId, attachmentId, { supabase }),
    (error) => error.statusCode === 409 &&
      error.publicCode === "SIGNATURE_PHOTO_STORAGE_READ_FAILED",
  );
});

test("anexo pendente não é baixado antes da confirmação do Power Automate", async () => {
  const supabase = fakeSupabase({ status: "Pendente" });
  await assert.rejects(
    getSignaturePhoto(requestId, { supabase }),
    (error) => error.statusCode === 409 &&
      error.publicCode === "SIGNATURE_PHOTO_UNAVAILABLE",
  );
  assert.deepEqual(supabase.downloads, []);
});