import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findCorporateEmailConflicts,
  saveGeneratedSignature,
} from "../src/services/signature-request.service.js";

const requestId = "00000000-0000-4000-8000-000000000001";
const png = Buffer.alloc(24);
Buffer.from("89504e470d0a1a0a", "hex").copy(png);
Buffer.from("IHDR").copy(png, 12);
png.writeUInt32BE(768, 16);
png.writeUInt32BE(200, 20);
const generatedFile = { buffer: png, size: png.length, mimetype: "image/png" };

function setup({ user = null, active = [] } = {}) {
  const request = {
    id: requestId,
    employee_name: "Kevin Batista de Souza",
    job_title: "Analista",
    phone: "21999999999",
    corporate_email: "kevindesouza@centaurotelecom.com.br",
    status: "Pendente",
    photo_attachment_id: null,
    photo_storage_path: `requests/${requestId}/photos/photo.png`,
    source_ticket_id: null,
    email_conflict: false,
    extraction_warnings: [],
    archived_at: null,
  };
  const artifacts = [];
  const uploads = [];
  const supabase = {
    from(table) {
      const filters = {};
      const query = {
        select() { return this; },
        eq(key, value) { filters[key] = value; return this; },
        neq(key, value) { filters[`not:${key}`] = value; return this; },
        is(key, value) { filters[`is:${key}`] = value; return this; },
        ilike(key, value) { filters[`ilike:${key}`] = value; return this; },
        order() { return this; },
        limit() { return this; },
        insert(value) { this.inserted = value; return this; },
        update(value) { this.updated = value; return this; },
        async maybeSingle() {
          if (table === "signature_requests") return { data: filters.id === requestId ? request : null, error: null };
          if (table === "users") return { data: user, error: null };
          return { data: null, error: null };
        },
        then(resolve, reject) {
          let data = [];
          if (table === "signature_requests" && filters["ilike:corporate_email"]) {
            data = active.filter((row) => row.corporate_email.toLowerCase() === filters["ilike:corporate_email"].toLowerCase())
              .filter((row) => row.archived_at == null)
              .filter((row) => row.id !== filters["not:id"]);
          } else if (table === "signature_artifacts" && this.inserted) {
            artifacts.push(this.inserted);
          } else if (table === "signature_artifacts") {
            data = artifacts.filter((row) => row.signature_request_id === filters.signature_request_id);
          }
          if (table === "signature_requests" && this.updated) Object.assign(request, this.updated);
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
    storage: { from: () => ({
      upload: async (path) => { uploads.push(path); return { error: null }; },
      download: async () => ({ data: new Blob([png], { type: "image/png" }), error: null }),
    }) },
  };
  return { supabase, request, artifacts, uploads };
}

test("solicitação válida, fotografia privada selecionada e PNG 768x200 gera e registra versão", async () => {
  const state = setup();
  const result = await saveGeneratedSignature(requestId, generatedFile, "admin-1", { supabase: state.supabase });
  assert.equal(result.request.status, "Gerada");
  assert.equal(result.request.history.length, 1);
  assert.equal(state.artifacts.length, 1);
  assert.equal(state.uploads.length, 1);
});

test("duplicidade ativa e conta de usuário bloqueiam geração, sem upload", async () => {
  const duplicate = setup({ active: [{ id: "old", corporate_email: "kevindesouza@centaurotelecom.com.br", archived_at: null }] });
  await assert.rejects(saveGeneratedSignature(requestId, generatedFile, "admin-1", { supabase: duplicate.supabase }), /solicitações duplicadas/);
  assert.equal(duplicate.uploads.length, 0);

  const existingUser = setup({ user: { id: "user-1" } });
  await assert.rejects(saveGeneratedSignature(requestId, generatedFile, "admin-1", { supabase: existingUser.supabase }), /fluxo de atualização/);
  assert.equal(existingUser.uploads.length, 0);
});

test("PNG em alta resolução preserva as dimensões no histórico", async () => {
  const state = setup();
  const buffer = Buffer.from(png);
  buffer.writeUInt32BE(2304, 16);
  buffer.writeUInt32BE(600, 20);
  await saveGeneratedSignature(requestId, { ...generatedFile, buffer }, "admin-1", { supabase: state.supabase });
  assert.equal(state.uploads.length, 1);
  assert.deepEqual(state.artifacts[0].snapshot.dimensions, { width: 2304, height: 600 });
  assert.equal(state.artifacts[0].snapshot.template, 'modelo-centauro-hd.svg');
});

test("gerações oficiais sucessivas preservam cada versão no histórico", async () => {
  const state = setup();
  await saveGeneratedSignature(requestId, generatedFile, "admin-1", { supabase: state.supabase });
  await saveGeneratedSignature(requestId, generatedFile, "admin-1", { supabase: state.supabase });
  assert.equal(state.artifacts.length, 2);
});

test("arquivar duplicada libera somente a solicitação restante e permite gerar com dados corrigidos", async () => {
  const state = setup({ active: [{
    id: "old-request",
    corporate_email: "kevindesouza@centaurotelecom.com.br",
    archived_at: "2026-10-15T12:00:00.000Z",
  }] });
  state.request.employee_name = "Kevin Souza Atualizado";
  state.request.corporate_email = "kevinsouza@centaurotelecom.com.br";
  const conflicts = await findCorporateEmailConflicts(
    state.supabase,
    state.request.corporate_email,
    requestId,
  );
  assert.deepEqual(conflicts, { user_exists: false, requests: [] });
  const result = await saveGeneratedSignature(requestId, generatedFile, "admin-1", { supabase: state.supabase });
  assert.equal(result.request.status, "Gerada");
  assert.equal(state.artifacts[0].snapshot.employee_name, "Kevin Souza Atualizado");
});
