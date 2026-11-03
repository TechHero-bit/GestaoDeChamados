import assert from "node:assert/strict";
import { test } from "node:test";
import { processOutlookOnboarding } from "../src/services/signature-request.service.js";

function memoryDatabase() {
  const rows = { signature_requests: [], signature_request_images: [], users: [] };
  return {
    rows,
    from(table) {
      const filters = [];
      let inserted;
      let single = false;
      return {
        select() { return this; },
        insert(value) { inserted = value; return this; },
        eq(key, value) { filters.push((row) => row[key] === value); return this; },
        neq(key, value) { filters.push((row) => row[key] !== value); return this; },
        ilike(key, value) { filters.push((row) => row[key]?.toLowerCase() === value.toLowerCase()); return this; },
        is(key, value) { filters.push((row) => (row[key] ?? null) === value); return this; },
        order() { return this; },
        limit() { return this; },
        maybeSingle() { single = true; return this; },
        single() { single = true; return this; },
        then(resolve, reject) {
          if (inserted) rows[table].push(...(Array.isArray(inserted) ? inserted : [inserted]));
          const data = rows[table].filter((row) => filters.every((matches) => matches(row)));
          return Promise.resolve({ data: single ? data[0] || null : data, error: null }).then(resolve, reject);
        },
      };
    },
  };
}

test("RE: onboarding cria assinatura vinculada ao chamado e anexos, e replay não duplica", async () => {
  const supabase = memoryDatabase();
  const input = {
    payload: {
      assunto: "RE: Centauro/Interno: Chamado - Onboarding de TI",
      message_id: "outlook-new-reply", conversation_id: "onboarding-thread",
      remetente_email: "rh@example.com",
      corpo_mensagem: "Nome: Kevin Batista de Souza\nFunção: Analista\nTelefone: 21999999999",
    },
    ticket: { id: "existing-ticket" }, message: { id: "existing-message" },
    attachments: [{ id: "internal-photo-id", file_name: "foto-colaborador.jpg",
      content_type: "image/jpeg", file_size: 200000, is_inline: false }],
  };
  const first = await processOutlookOnboarding(input, { supabase });
  assert.equal(first.duplicate, false);
  assert.equal(first.request.source_ticket_id, input.ticket.id);
  assert.equal(first.request.employee_name, "Kevin Batista de Souza");
  assert.equal(first.request.photo_attachment_id, "internal-photo-id");
  assert.equal(supabase.rows.signature_request_images[0].attachment_id, "internal-photo-id");
  const second = await processOutlookOnboarding(input, { supabase });
  assert.equal(second.duplicate, true);
  assert.equal(second.request.id, first.request.id);
  assert.equal(supabase.rows.signature_requests.length, 1);
  assert.equal(supabase.rows.signature_request_images.length, 1);
});

test("resposta sobre outro tipo de chamado não cria solicitação de assinatura", async () => {
  const supabase = { from() { throw new Error("Não deve consultar nem gravar assinatura"); } };
  assert.equal(await processOutlookOnboarding({ payload: {
    assunto: "RE: Centauro/Interno: Chamado - Desligamento de TI",
  } }, { supabase }), null);
});
