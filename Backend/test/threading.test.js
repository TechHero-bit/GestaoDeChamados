import assert from "node:assert/strict";
import { test } from "node:test";
import { getReplyMessageId } from "../src/controllers/ticket.controller.js";
import { webhookPayloadSchema } from "../src/schemas/webhook.schema.js";
import { processarEntrada } from "../src/services/ticket.service.js";
import { sendTicketReply } from "../src/services/email.service.js";

class InMemorySupabase {
  constructor() {
    this.tickets = [];
    this.messages = [];
    this.nextId = 1;
  }

  from(table) {
    return new InMemoryQuery(this, table);
  }
}

class InMemoryQuery {
  constructor(database, table) {
    this.database = database;
    this.table = table;
    this.filters = [];
    this.operation = "select";
    this.values = null;
    this.singleResult = false;
    this.limitValue = null;
  }

  select() {
    return this;
  }

  insert(values) {
    this.operation = "insert";
    this.values = values;
    return this;
  }

  update(values) {
    this.operation = "update";
    this.values = values;
    return this;
  }

  delete() {
    this.operation = "delete";
    return this;
  }

  eq(field, value) {
    this.filters.push([field, value]);
    return this;
  }

  order() {
    return this;
  }

  limit(value) {
    this.limitValue = value;
    return this;
  }

  maybeSingle() {
    this.singleResult = true;
    return this;
  }

  single() {
    this.singleResult = true;
    return this;
  }

  then(resolve, reject) {
    return Promise.resolve().then(() => this.execute()).then(resolve, reject);
  }

  execute() {
    const collection =
      this.table === "tickets"
        ? this.database.tickets
        : this.database.messages;

    if (this.operation === "insert") {
      const record = {
        id: `${this.table}-${this.database.nextId++}`,
        ...this.values,
      };
      collection.push(record);
      return { data: this.singleResult ? record : [record], error: null };
    }

    const matches = collection.filter((record) =>
      this.filters.every(([field, value]) => record[field] === value),
    );

    if (this.operation === "update") {
      matches.forEach((record) => Object.assign(record, this.values));
      const data = this.singleResult ? matches[0] || null : matches;
      return { data, error: null };
    }

    if (this.operation === "delete") {
      for (const record of matches) {
        const index = collection.indexOf(record);
        collection.splice(index, 1);
      }
      return { data: null, error: null };
    }

    const limited = this.limitValue ? matches.slice(0, this.limitValue) : matches;
    return {
      data: this.singleResult ? limited[0] || null : limited,
      error: null,
    };
  }
}

function payload(messageId, conversationId, body = messageId) {
  return {
    message_id: messageId,
    conversation_id: conversationId,
    remetente_email: "cliente@example.com",
    remetente_nome: "Cliente",
    assunto: "Solicitação (chamado)",
    corpo_mensagem: body,
    data_recebimento: "2026-08-31T12:00:00.000Z",
  };
}

function runProcess(database, dados) {
  return processarEntrada(dados, {
    supabase: database,
    helpdeskEmail: "helpdesk@example.com",
  });
}

test("primeiro e-mail cria um ticket e uma mensagem de entrada", async () => {
  const database = new InMemorySupabase();
  const result = await runProcess(database, payload("MSG-1", "CONV-1"));

  assert.equal(result.duplicate, false);
  assert.equal(result.threaded, false);
  assert.equal(database.tickets.length, 1);
  assert.equal(database.messages.length, 1);
  assert.equal(database.tickets[0].outlook_message_id, "MSG-1");
  assert.equal(database.tickets[0].outlook_last_message_id, "MSG-1");
  assert.equal(database.tickets[0].outlook_conversation_id, "CONV-1");
  assert.equal(database.messages[0].direcao, "Entrada");
});

test("o mesmo message_id retorna duplicate sem criar dados", async () => {
  const database = new InMemorySupabase();
  await runProcess(database, payload("MSG-1", "CONV-1"));
  const result = await runProcess(database, payload("MSG-1", "CONV-1", "repetido"));

  assert.equal(result.duplicate, true);
  assert.equal(result.ticket.id, database.tickets[0].id);
  assert.equal(database.tickets.length, 1);
  assert.equal(database.messages.length, 1);
});

test("resposta da mesma conversa adiciona mensagem e atualiza a última mensagem", async () => {
  const database = new InMemorySupabase();
  const first = await runProcess(database, payload("MSG-1", "CONV-1"));
  const result = await runProcess(database, payload("MSG-2", "CONV-1", "segunda mensagem"));

  assert.equal(result.duplicate, false);
  assert.equal(result.threaded, true);
  assert.equal(result.ticket.id, first.ticket.id);
  assert.equal(database.tickets.length, 1);
  assert.equal(database.messages.length, 2);
  assert.equal(database.messages[1].ticket_id, first.ticket.id);
  assert.equal(database.messages[1].outlook_message_id, "MSG-2");
  assert.equal(database.tickets[0].outlook_last_message_id, "MSG-2");
});

test("nova conversa cria um segundo ticket", async () => {
  const database = new InMemorySupabase();
  const first = await runProcess(database, payload("MSG-1", "CONV-1"));
  const second = await runProcess(database, payload("MSG-3", "CONV-2"));

  assert.equal(first.ticket.id === second.ticket.id, false);
  assert.equal(database.tickets.length, 2);
  assert.equal(database.messages.length, 2);
});

test("conversation_id é obrigatório e deve ser uma string não vazia", () => {
  const base = payload("MSG-1", "CONV-1");
  assert.equal(webhookPayloadSchema.safeParse({ ...base, conversation_id: "" }).success, false);
  assert.equal(webhookPayloadSchema.safeParse({ ...base, conversation_id: 123 }).success, false);
  assert.equal(webhookPayloadSchema.safeParse(base).success, true);
});

test("reply envia MSG-2 e mantém fallback para ticket legado", async () => {
  const nativeFetch = globalThis.fetch;
  const previousUrl = process.env.POWER_AUTOMATE_REPLY_URL;
  let captured;
  process.env.POWER_AUTOMATE_REPLY_URL = "https://power-automate.example.test/reply";
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(null, { status: 204 });
  };

  try {
    const ticket = {
      outlook_last_message_id: "MSG-2",
      outlook_message_id: "MSG-1",
    };
    await sendTicketReply({
      ticketId: "ticket-1",
      messageId: getReplyMessageId(ticket),
      destinatario: "cliente@example.com",
      assunto: "RE: Solicitação (chamado)",
      mensagem: "Resposta",
    });
    assert.equal(JSON.parse(captured.options.body).message_id, "MSG-2");
    assert.equal(
      getReplyMessageId({ outlook_last_message_id: null, outlook_message_id: "MSG-1" }),
      "MSG-1",
    );
  } finally {
    globalThis.fetch = nativeFetch;
    if (previousUrl) process.env.POWER_AUTOMATE_REPLY_URL = previousUrl;
    else delete process.env.POWER_AUTOMATE_REPLY_URL;
  }
});