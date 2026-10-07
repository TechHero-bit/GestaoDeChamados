import assert from "node:assert/strict";
import { test } from "node:test";
import { updateTicketSchema } from "../src/schemas/ticket.schema.js";
import { atualizarTicket, listarResponsaveis } from "../src/services/ticket.service.js";

const adminId = "00000000-0000-4000-8000-000000000001";
const ticketId = "00000000-0000-4000-8000-000000000002";

function database(users = [], queryError = null) {
  const state = { users, ticket: { id: ticketId, responsavel_id: null }, updates: [] };
  return {
    state,
    from(table) {
      const filters = [];
      let update;
      let single = false;
      let fields;
      return {
        select(value) { fields = value; return this; },
        eq(field, value) { filters.push([field, value]); return this; },
        order() { return this; },
        maybeSingle() { single = true; return this; },
        update(value) { update = value; return this; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            if (queryError) return { data: null, error: queryError };
            const source = table === "users" ? state.users : [state.ticket];
            const matches = source.filter((row) => filters.every(([field, value]) => row[field] === value));
            if (update) {
              state.updates.push(update);
              matches.forEach((row) => Object.assign(row, update));
            }
            const rows = table === "users"
              ? matches.map((row) => Object.fromEntries(fields.split(",").map((field) => [field, row[field]])))
              : matches;
            return { data: single ? rows[0] || null : rows, error: null };
          }).then(resolve, reject);
        },
      };
    },
  };
}

const activeAdmin = { id: adminId, nome: "Administrador", email: "admin@example.com", role: "ADMIN", ativo: true, password_hash: "private" };

test("atribuição aceita UUID e null e rejeita identificadores inválidos", () => {
  assert.deepEqual(updateTicketSchema.parse({ responsavel_id: adminId }), { responsavel_id: adminId });
  assert.deepEqual(updateTicketSchema.parse({ responsavel_id: null }), { responsavel_id: null });
  for (const value of ["", "invalido", 123]) {
    assert.equal(updateTicketSchema.safeParse({ responsavel_id: value }).success, false);
  }
  assert.equal(updateTicketSchema.safeParse({}).success, false);
});

test("lista somente administradores ativos e dados públicos", async () => {
  const supabase = database([
    activeAdmin,
    { ...activeAdmin, id: "inactive", ativo: false },
    { ...activeAdmin, id: "agent", role: "AGENT" },
  ]);
  assert.deepEqual(await listarResponsaveis({ supabase }), [
    { id: adminId, nome: activeAdmin.nome, email: activeAdmin.email },
  ]);
});

test("salva um administrador ativo sem permitir alterações arbitrárias", async () => {
  const supabase = database([activeAdmin]);
  const updated = await atualizarTicket(ticketId, {
    responsavel_id: adminId, status: "Em Andamento", assunto: "ignorar", payload_original: {},
  }, { supabase });
  assert.equal(updated.responsavel_id, adminId);
  assert.deepEqual(supabase.state.updates, [{ responsavel_id: adminId, status: "Em Andamento" }]);
});

for (const [label, users] of [
  ["usuário inexistente", []],
  ["administrador inativo", [{ ...activeAdmin, ativo: false }]],
  ["agente", [{ ...activeAdmin, role: "AGENT" }]],
]) {
  test("rejeita atribuição para " + label + " sem atualizar o chamado", async () => {
    const supabase = database(users);
    await assert.rejects(atualizarTicket(ticketId, { responsavel_id: adminId }, { supabase }),
      (error) => error.statusCode === 400);
    assert.deepEqual(supabase.state.updates, []);
  });
}

test("remove o responsável mesmo se ele não estiver mais ativo", async () => {
  const supabase = database();
  supabase.state.ticket.responsavel_id = adminId;
  const updated = await atualizarTicket(ticketId, { responsavel_id: null }, { supabase });
  assert.equal(updated.responsavel_id, null);
});

test("atualizar prioridade preserva o responsável atual", async () => {
  const supabase = database();
  supabase.state.ticket.responsavel_id = adminId;
  const updated = await atualizarTicket(ticketId, { prioridade: "Alta" }, { supabase });
  assert.equal(updated.responsavel_id, adminId);
  assert.equal(updated.prioridade, "Alta");
});

test("falha no banco interrompe atribuição e listagem", async () => {
  const supabase = database([activeAdmin], { message: "database offline" });
  await assert.rejects(atualizarTicket(ticketId, { responsavel_id: adminId }, { supabase }),
    (error) => error.statusCode === 502);
  await assert.rejects(listarResponsaveis({ supabase }), (error) => error.statusCode === 502);
  assert.deepEqual(supabase.state.updates, []);
});
