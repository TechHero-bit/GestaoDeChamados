import assert from "node:assert/strict";
import { test } from "node:test";
import { listTicketsQuerySchema, updateTicketSchema } from "../src/schemas/ticket.schema.js";
import { atualizarTicket, listar } from "../src/services/ticket.service.js";

const id = "00000000-0000-4000-8000-000000000001";
const version = "2026-10-08T12:00:00.123456+00:00";

// Banco em memória aplica filtro e escrita juntos, como o UPDATE condicional.
function database({ fail = false } = {}) {
  const state = { row: { id, status: "Aberto", prioridade: "Alta", responsavel_id: null, data_atualizacao: version }, writes: [], filters: [], orders: [] };
  return { state, from() {
    const filters = [];
    let updates;
    let single = false;
    return {
      select() { return this; },
      eq(key, value) { filters.push([key, value]); state.filters.push([key, value]); return this; },
      is(key, value) { return this.eq(key, value); },
      order(key) { state.orders.push(key); return this; },
      range() { return this; },
      update(value) { updates = value; return this; },
      maybeSingle() { single = true; return this; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        if (fail) return { data: null, error: { message: "offline" } };
        const matches = filters.every(([key, value]) => state.row[key] === value);
        if (matches && updates) {
          state.writes.push(updates);
          Object.assign(state.row, updates, { data_atualizacao: "2026-10-08T13:00:00Z" });
        }
        const rows = matches ? [{ ...state.row }] : [];
        return { data: single ? rows[0] || null : rows, count: rows.length, error: null };
      }).then(resolve, reject); },
    };
  } };
}

test("valida versão com precisão do Postgres, filtros e ordenação do quadro", () => {
  assert.equal(updateTicketSchema.parse({ status: "Resolvido", expected_data_atualizacao: version }).expected_data_atualizacao, version);
  for (const value of ["inválida", "", null]) {
    assert.equal(updateTicketSchema.safeParse({ status: "Aberto", expected_data_atualizacao: value }).success, false);
  }
  assert.equal(updateTicketSchema.safeParse({ expected_data_atualizacao: version }).success, false);
  assert.equal(listTicketsQuerySchema.safeParse({ prioridade: "Alta", responsavel_id: "none", sort: "updated" }).success, true);
  assert.equal(listTicketsQuerySchema.safeParse({ responsavel_id: "outro", sort: "updated" }).success, false);
});

test("salva com versão correta sem persistir o campo de controle", async () => {
  const db = database();
  const result = await atualizarTicket(id, { status: "Resolvido", expected_data_atualizacao: version }, { supabase: db });
  assert.equal(result.status, "Resolvido");
  assert.equal(db.state.writes[0].status, "Resolvido");
  assert.equal(Object.hasOwn(db.state.writes[0], "expected_data_atualizacao"), false);
  assert.ok(Date.parse(db.state.writes[0].data_atualizacao) > Date.parse(version));
  assert.equal(result.prioridade, "Alta");
});

test("duas escritas com a mesma versão resultam em um sucesso e um conflito", async () => {
  const db = database();
  const results = await Promise.allSettled([
    atualizarTicket(id, { status: "Em Andamento", expected_data_atualizacao: version }, { supabase: db }),
    atualizarTicket(id, { status: "Resolvido", expected_data_atualizacao: version }, { supabase: db }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const failure = results.find((r) => r.status === "rejected");
  assert.equal(failure.reason.statusCode, 409);
  assert.equal(failure.reason.publicCode, "TICKET_CONFLICT");
  assert.equal(db.state.writes.length, 1);
});

test("versão antiga e falha de banco não sobrescrevem ticket", async () => {
  const db = database();
  await assert.rejects(atualizarTicket(id, { status: "Resolvido", expected_data_atualizacao: "2026-01-01T00:00:00Z" }, { supabase: db }), (e) => e.statusCode === 409);
  assert.equal(db.state.row.status, "Aberto");
  assert.equal(db.state.writes.length, 0);
  await assert.rejects(atualizarTicket(id, { status: "Resolvido", expected_data_atualizacao: version }, { supabase: database({ fail: true }) }), (e) => e.statusCode === 502);
});

test("filtros são aplicados no banco antes da paginação, com ordenação estável", async () => {
  const db = database();
  const result = await listar({ status: "Aberto", prioridade: "Alta", responsavel_id: "none", sort: "updated" }, { supabase: db });
  assert.equal(result.total, 1);
  assert.ok(db.state.filters.some(([key, value]) => key === "responsavel_id" && value === null));
  assert.deepEqual(db.state.orders, ["data_atualizacao", "id"]);
});

test("PUT de status sem sessão é recusado antes de acessar o banco", async () => {
  const { default: app } = await import("../src/app.js");
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tickets/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "Resolvido", expected_data_atualizacao: version }),
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).success, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
