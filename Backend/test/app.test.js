import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import app from "../src/app.js";
import { sendTicketReply } from "../src/services/email.service.js";

let server;
let baseUrl;

before(async () => {
  process.env.WEBHOOK_SECRET = "test-webhook-secret";
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("GET /health informa que a API está ativa", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("rotas desconhecidas retornam o formato de erro padrão", async () => {
  const response = await fetch(`${baseUrl}/rota-inexistente`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    success: false,
    message: "Rota não encontrada.",
  });
});

test("webhook rejeita requisição sem segredo", async () => {
  const response = await fetch(`${baseUrl}/api/webhooks/outlook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).success, false);
});

test("webhook valida o payload antes de acessar o banco", async () => {
  const response = await fetch(`${baseUrl}/api/webhooks/outlook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-webhook-secret": "test-webhook-secret",
    },
    body: JSON.stringify({ assunto: "sem marcador" }),
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.success, false);
  assert.equal(body.message, "Payload inválido.");
  assert.ok(Array.isArray(body.errors));
});

test("rotas de ticket rejeitam UUID inválido antes de acessar o banco", async () => {
  const response = await fetch(`${baseUrl}/api/tickets/nao-e-uuid`);
  assert.equal(response.status, 400);
  assert.equal(
    (await response.json()).message,
    "Identificador do chamado inválido.",
  );
});

test("listagem rejeita status fora do domínio", async () => {
  const response = await fetch(`${baseUrl}/api/tickets?status=Pendente`);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).message, "Filtros inválidos.");
});

test("listagem rejeita uma data inexistente", async () => {
  const response = await fetch(`${baseUrl}/api/tickets?date=2026-02-31`);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).message, "Filtros inválidos.");
});

test("serviço de e-mail exige a URL do fluxo de saída", async () => {
  const previousUrl = process.env.POWER_AUTOMATE_REPLY_URL;
  delete process.env.POWER_AUTOMATE_REPLY_URL;
  try {
    await assert.rejects(
      sendTicketReply({
        ticketId: "00000000-0000-4000-8000-000000000001",
        destinatario: "solicitante@example.com",
        assunto: "RE: Teste",
        mensagem: "Resposta",
      }),
      (error) => error.statusCode === 503,
    );
  } finally {
    if (previousUrl) process.env.POWER_AUTOMATE_REPLY_URL = previousUrl;
  }
});

test("serviço de e-mail envia o contrato esperado ao Power Automate", async () => {
  const nativeFetch = globalThis.fetch;
  const previousUrl = process.env.POWER_AUTOMATE_REPLY_URL;
  const previousSecret = process.env.POWER_AUTOMATE_REPLY_SECRET;
  let captured;

  process.env.POWER_AUTOMATE_REPLY_URL =
    "https://power-automate.example.test/reply";
  process.env.POWER_AUTOMATE_REPLY_SECRET = "reply-secret";
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(null, { status: 204 });
  };

  try {
    await sendTicketReply({
      ticketId: "00000000-0000-4000-8000-000000000001",
      destinatario: "solicitante@example.com",
      assunto: "RE: Teste",
      mensagem: "Resposta",
    });

    assert.equal(captured.url, process.env.POWER_AUTOMATE_REPLY_URL);
    assert.equal(captured.options.headers["x-webhook-secret"], "reply-secret");
    assert.deepEqual(JSON.parse(captured.options.body), {
      ticket_id: "00000000-0000-4000-8000-000000000001",
      destinatario: "solicitante@example.com",
      assunto: "RE: Teste",
      mensagem: "Resposta",
    });
  } finally {
    globalThis.fetch = nativeFetch;
    if (previousUrl) process.env.POWER_AUTOMATE_REPLY_URL = previousUrl;
    else delete process.env.POWER_AUTOMATE_REPLY_URL;
    if (previousSecret)
      process.env.POWER_AUTOMATE_REPLY_SECRET = previousSecret;
    else delete process.env.POWER_AUTOMATE_REPLY_SECRET;
  }
});
