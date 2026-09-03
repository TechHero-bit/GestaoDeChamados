import assert from "node:assert/strict";
import { test } from "node:test";
import { replyTicketSchema } from "../src/schemas/ticket.schema.js";
import { replyToMicrosoftMessage } from "../src/services/microsoft-graph.service.js";
import {
  getReplyMessageId,
  sendAndPersistTicketReply,
} from "../src/services/ticket-reply.service.js";

const TICKET = {
  id: "00000000-0000-4000-8000-000000000001",
  remetente_email: "solicitante@example.com",
  assunto: "Falha no acesso",
  prioridade: "Alta",
  outlook_last_message_id: "last-message-id",
  outlook_message_id: "original-message-id",
};

function createDependencies({ connected = true, graphError, powerError } = {}) {
  const calls = [];
  return {
    calls,
    dependencies: {
      getConnectionStatus: async (userId) => {
        calls.push(["status", userId]);
        return connected
          ? {
              connected: true,
              email: "Agent@Example.com",
              display_name: "Agente",
            }
          : { connected: false };
      },
      replyWithMicrosoftGraph: async (userId, payload) => {
        calls.push(["graph", userId, payload]);
        if (graphError) throw graphError;
      },
      replyWithPowerAutomate: async (payload) => {
        calls.push(["power", payload]);
        if (powerError) throw powerError;
      },
      persistMessage: async (payload) => {
        calls.push(["persist", payload]);
        return { id: "persisted-message", ...payload };
      },
      helpdeskEmail: () => "helpdesk@example.com",
    },
  };
}

async function graphResponseError(status) {
  try {
    await replyToMicrosoftMessage(
      "authenticated-user",
      { messageId: "message-id", message: "Resposta" },
      {
        getAccessToken: async () => "secret-token",
        fetchImpl: async () => new Response(null, { status }),
      },
    );
  } catch (error) {
    return error;
  }
  assert.fail(`Graph deveria rejeitar o status ${status}`);
}

test("usuário conectado usa Graph, não chama Power Automate e persiste após confirmação", async () => {
  const { calls, dependencies } = createDependencies();

  const result = await sendAndPersistTicketReply(
    { ticket: TICKET, userId: "authenticated-user", message: "Resposta segura" },
    dependencies,
  );

  assert.equal(result.provider, "microsoft_graph");
  assert.deepEqual(calls.map(([name]) => name), ["status", "graph", "persist"]);
  assert.deepEqual(calls[1], [
    "graph",
    "authenticated-user",
    { messageId: "last-message-id", message: "Resposta segura", html: "Resposta segura" },
  ]);
  assert.deepEqual(calls[2][1], {
    ticket_id: TICKET.id,
    direcao: "Saida",
    remetente_email: "agent@example.com",
    destinatario_email: "solicitante@example.com",
    corpo_mensagem: "Resposta segura",
    created_by: "authenticated-user",
  });
});

test("usuário desconectado mantém Power Automate e persiste o padrão existente", async () => {
  const { calls, dependencies } = createDependencies({ connected: false });

  const result = await sendAndPersistTicketReply(
    { ticket: TICKET, userId: "authenticated-user", message: "Resposta" },
    dependencies,
  );

  assert.equal(result.provider, "power_automate");
  assert.deepEqual(calls.map(([name]) => name), ["status", "power", "persist"]);
  assert.deepEqual(calls[1][1], {
    ticketId: TICKET.id,
    messageId: "last-message-id",
    destinatario: "solicitante@example.com",
    assunto: "RE: Falha no acesso",
    mensagem: "Resposta",
    prioridade: "Alta",
  });
  assert.equal(calls[2][1].remetente_email, "helpdesk@example.com");
  assert.equal(calls[2][1].created_by, "authenticated-user");
});

test("Graph 400, 401, 403 e 404 não acionam fallback nem persistência", async () => {
  for (const status of [400, 401, 403, 404]) {
    const graphError = await graphResponseError(status);
    const { calls, dependencies } = createDependencies({ graphError });

    await assert.rejects(
      sendAndPersistTicketReply(
        { ticket: TICKET, userId: "authenticated-user", message: "Resposta" },
        dependencies,
      ),
      (error) => error === graphError,
    );

    assert.deepEqual(calls.map(([name]) => name), ["status", "graph"]);
    assert.equal(graphError.safeToFallback, false);
  }
});

test("respostas explícitas 429 e 5xx permitem fallback confirmado pelo Power Automate", async () => {
  for (const status of [429, 503]) {
    const graphError = await graphResponseError(status);
    const { calls, dependencies } = createDependencies({ graphError });

    const result = await sendAndPersistTicketReply(
      { ticket: TICKET, userId: "authenticated-user", message: "Resposta" },
      dependencies,
    );

    assert.equal(graphError.safeToFallback, true);
    assert.equal(result.provider, "power_automate");
    assert.deepEqual(calls.map(([name]) => name), [
      "status",
      "graph",
      "power",
      "persist",
    ]);
  }
});

test("falha de rede antes do envio ao Graph permite fallback sem risco de duplicidade", async () => {
  let graphError;
  try {
    await replyToMicrosoftMessage(
      "authenticated-user",
      { messageId: "message-id", message: "Resposta" },
      {
        getAccessToken: async () => {
          throw new TypeError("fetch failed");
        },
        fetchImpl: async () => assert.fail("Graph não deveria ser chamado sem token"),
      },
    );
  } catch (error) {
    graphError = error;
  }

  assert.equal(graphError.publicCode, "MICROSOFT_TOKEN_NETWORK_ERROR");
  assert.equal(graphError.safeToFallback, true);

  const { calls, dependencies } = createDependencies({ graphError });
  const result = await sendAndPersistTicketReply(
    { ticket: TICKET, userId: "authenticated-user", message: "Resposta" },
    dependencies,
  );
  assert.equal(result.provider, "power_automate");
  assert.deepEqual(calls.map(([name]) => name), [
    "status",
    "graph",
    "power",
    "persist",
  ]);
});

test("timeout ou falha de rede fica indeterminado e nunca gera fallback ou persistência", async () => {
  let graphError;
  try {
    await replyToMicrosoftMessage(
      "authenticated-user",
      { messageId: "message-id", message: "Resposta" },
      {
        getAccessToken: async () => "secret-token",
        fetchImpl: async () => {
          throw new DOMException("The operation was aborted", "TimeoutError");
        },
      },
    );
  } catch (error) {
    graphError = error;
  }

  assert.equal(graphError.publicCode, "GRAPH_DELIVERY_UNKNOWN");
  assert.equal(graphError.safeToFallback, false);

  const { calls, dependencies } = createDependencies({ graphError });
  await assert.rejects(
    sendAndPersistTicketReply(
      { ticket: TICKET, userId: "authenticated-user", message: "Resposta" },
      dependencies,
    ),
    (error) => error === graphError,
  );
  assert.deepEqual(calls.map(([name]) => name), ["status", "graph"]);
});

test("falha do Power Automate não persiste mensagem", async () => {
  const { calls, dependencies } = createDependencies({
    connected: false,
    powerError: new Error("Power Automate indisponível"),
  });

  await assert.rejects(
    sendAndPersistTicketReply(
      { ticket: TICKET, userId: "authenticated-user", message: "Resposta" },
      dependencies,
    ),
    /Power Automate indisponível/,
  );
  assert.deepEqual(calls.map(([name]) => name), ["status", "power"]);
});

test("falha de persistência após envio retorna estado confirmado e orienta não reenviar", async () => {
  const { calls, dependencies } = createDependencies();
  dependencies.persistMessage = async (payload) => {
    calls.push(["persist", payload]);
    throw new Error("Banco indisponível");
  };

  await assert.rejects(
    sendAndPersistTicketReply(
      { ticket: TICKET, userId: "authenticated-user", message: "Resposta" },
      dependencies,
    ),
    (error) => {
      assert.equal(error.publicCode, "REPLY_SENT_PERSIST_FAILED");
      assert.equal(error.deliveryConfirmed, true);
      assert.match(error.message, /Não tente reenviar/);
      return true;
    },
  );
  assert.deepEqual(calls.map(([name]) => name), ["status", "graph", "persist"]);
});

test("message ID é sempre interno, prioriza o último e usa o original como fallback", async () => {
  assert.equal(getReplyMessageId(TICKET), "last-message-id");
  assert.equal(
    getReplyMessageId({
      outlook_last_message_id: null,
      outlook_message_id: "original-message-id",
    }),
    "original-message-id",
  );

  const { calls, dependencies } = createDependencies();
  await sendAndPersistTicketReply(
    {
      ticket: { ...TICKET, outlook_last_message_id: null },
      userId: "authenticated-user",
      message: "Resposta",
    },
    dependencies,
  );
  assert.equal(calls.find(([name]) => name === "graph")[2].messageId, "original-message-id");
});

test("ticket sem message ID não envia nem persiste", async () => {
  const { calls, dependencies } = createDependencies();
  await assert.rejects(
    sendAndPersistTicketReply(
      {
        ticket: {
          ...TICKET,
          outlook_last_message_id: null,
          outlook_message_id: null,
        },
        userId: "authenticated-user",
        message: "Resposta",
      },
      dependencies,
    ),
    (error) => error.statusCode === 422,
  );
  assert.deepEqual(calls, []);
});

test("payload normal rejeita provider, user_id e message_id enviados pelo frontend", () => {
  for (const extra of [
    { provider: "graph" },
    { user_id: "outro-usuario" },
    { message_id: "forged-message" },
  ]) {
    assert.equal(
      replyTicketSchema.safeParse({ mensagem: "Resposta", ...extra }).success,
      false,
    );
  }
  assert.deepEqual(replyTicketSchema.parse({ mensagem: " Resposta " }), {
    mensagem: "Resposta",
  });
});
