import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import bcrypt from "bcryptjs";
import app from "../src/app.js";
import { AUTH_COOKIE_NAME } from "../src/config/auth-cookie.js";
import { loginLimiter } from "../src/config/rate-limit.js";
import { requireRole } from "../src/middlewares/role.middleware.js";
import { updateTicketSchema } from "../src/schemas/ticket.schema.js";
import * as authService from "../src/services/auth.service.js";
import { sendTicketReply } from "../src/services/email.service.js";

let server;
let baseUrl;

before(async () => {
  process.env.JWT_SECRET =
    "teste-jwt-secret-super-seguro-com-mais-de-32-caracteres-123456";
  process.env.WEBHOOK_SECRET = "test-webhook-secret";
  process.env.SESSION_IDLE_TIMEOUT_MINUTES = "10";
  process.env.SESSION_ABSOLUTE_TIMEOUT_HOURS = "8";
  process.env.NODE_ENV = "test";

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

// ==========================================
// 1. Health check e rotas públicas
// ==========================================

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

// ==========================================
// 2. Webhook do Outlook (público com secret)
// ==========================================

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

// ==========================================
// 3. Proteção das APIs de tickets (exigem auth)
// ==========================================

test("GET /api/tickets sem autenticação retorna 401", async () => {
  const response = await fetch(`${baseUrl}/api/tickets`);
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.match(body.message, /não autenticado/i);
});

test("GET /api/tickets/:id sem autenticação retorna 401", async () => {
  const response = await fetch(
    `${baseUrl}/api/tickets/00000000-0000-4000-8000-000000000001`,
  );
  assert.equal(response.status, 401);
});

test("POST /api/tickets/:id/reply sem autenticação retorna 401", async () => {
  const response = await fetch(
    `${baseUrl}/api/tickets/00000000-0000-4000-8000-000000000001/reply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mensagem: "Teste" }),
    },
  );
  assert.equal(response.status, 401);
});

test("DELETE /api/tickets/:id sem autenticação retorna 401", async () => {
  const response = await fetch(
    `${baseUrl}/api/tickets/00000000-0000-4000-8000-000000000001`,
    { method: "DELETE" },
  );
  assert.equal(response.status, 401);
});

// ==========================================
// 4. Validação de formato no Login
// ==========================================

test("POST /api/auth/login valida formato obrigatório de e-mail e senha", async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "invalido", password: "" }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.ok(Array.isArray(body.errors));
});

test("schema de atualização aceita status, prioridade ou ambos", () => {
  assert.deepEqual(updateTicketSchema.parse({ prioridade: "Alta" }), {
    prioridade: "Alta",
  });
  assert.deepEqual(updateTicketSchema.parse({ status: "Em Andamento" }), {
    status: "Em Andamento",
  });
  assert.deepEqual(
    updateTicketSchema.parse({ status: "Resolvido", prioridade: "Baixa" }),
    { status: "Resolvido", prioridade: "Baixa" },
  );
});

test("schema rejeita prioridade inválida e mantém campos não autorizados fora do payload", () => {
  const invalidPriority = updateTicketSchema.safeParse({ prioridade: "Urgente" });
  assert.equal(invalidPriority.success, false);
  assert.equal(invalidPriority.error.issues[0].path[0], "prioridade");

  const unauthorized = updateTicketSchema.safeParse({
    prioridade: "Alta",
    assunto: "não deve ser atualizado",
  });
  assert.deepEqual(unauthorized.data, { prioridade: "Alta" });

  const withoutAllowedFields = updateTicketSchema.safeParse({ assunto: "teste" });
  assert.equal(withoutAllowedFields.success, false);
});

// ==========================================
// 5. Unidade: JWT, Tokens e Criptografia
// ==========================================

test("signSessionToken gera JWT válido e assinado", async () => {
  const token = await authService.signSessionToken({
    userId: "00000000-0000-4000-8000-000000000001",
    sessionId: "11111111-1111-4000-8000-111111111111",
    jti: "test-jti-uuid",
    role: "ADMIN",
  });

  assert.ok(token);
  assert.equal(typeof token, "string");

  const payload = await authService.verifyToken(token);
  assert.ok(payload);
  assert.equal(payload.sub, "00000000-0000-4000-8000-000000000001");
  assert.equal(payload.sid, "11111111-1111-4000-8000-111111111111");
  assert.equal(payload.jti, "test-jti-uuid");
  assert.equal(payload.role, "ADMIN");
});

test("verifyToken rejeita token com assinatura corrompida ou chave errada", async () => {
  const token = await authService.signSessionToken({
    userId: "00000000-0000-4000-8000-000000000001",
    sessionId: "11111111-1111-4000-8000-111111111111",
    jti: "test-jti-uuid",
    role: "ADMIN",
  });

  const corruptedToken = token.slice(0, -5) + "xxxxx";
  const payload = await authService.verifyToken(corruptedToken);
  assert.equal(payload, null);
});

test("bcrypt gera hashes seguros e realiza verificação", async () => {
  const password = "SenhaSuperSecreta@123";
  const hash = await bcrypt.hash(password, 10);

  assert.ok(hash);
  assert.notEqual(hash, password);
  assert.ok(await bcrypt.compare(password, hash));
  assert.equal(await bcrypt.compare("SenhaErrada", hash), false);
});

// ==========================================
// 6. Rate Limiting
// ==========================================

test("Rate limiter bloqueia requisições excessivas com HTTP 429", async () => {
  const testIp = "192.168.100.50";
  // Simular 5 tentativas rápidas para esgotar o limite de 5
  for (let i = 0; i < 5; i++) {
    const res = await loginLimiter.limit(testIp);
    assert.equal(res.success, true);
  }

  // A 6ª tentativa deve ser bloqueada
  const blocked = await loginLimiter.limit(testIp);
  assert.equal(blocked.success, false);
  assert.equal(blocked.remaining, 0);
});

// ==========================================
// 7. Autorização RBAC
// ==========================================

test("requireRole permite acesso quando role coincide e bloqueia com 403 caso contrário", () => {
  const adminMiddleware = requireRole("ADMIN");

  let nextCalled = false;
  let responseStatus = null;
  let responseBody = null;

  const mockRes = {
    status(code) {
      responseStatus = code;
      return this;
    },
    json(data) {
      responseBody = data;
      return this;
    },
  };

  // 1. Caso com usuário ADMIN
  adminMiddleware(
    { user: { id: "1", role: "ADMIN" } },
    mockRes,
    () => {
      nextCalled = true;
    },
  );
  assert.equal(nextCalled, true);

  // 2. Caso com usuário AGENT tentando rota de ADMIN
  nextCalled = false;
  adminMiddleware(
    { user: { id: "2", role: "AGENT" } },
    mockRes,
    () => {
      nextCalled = true;
    },
  );
  assert.equal(nextCalled, false);
  assert.equal(responseStatus, 403);
  assert.equal(responseBody.success, false);
});

// ==========================================
// 8. Testes de Integração de Email / Power Automate
// ==========================================

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
      messageId: "outlook-message-id-123",
      destinatario: "solicitante@example.com",
      assunto: "RE: Teste",
      mensagem: "Resposta",
      prioridade: "Alta",
    });

    assert.equal(captured.url, process.env.POWER_AUTOMATE_REPLY_URL);
    assert.equal(captured.options.headers["x-webhook-secret"], "reply-secret");
    assert.deepEqual(JSON.parse(captured.options.body), {
      ticket_id: "00000000-0000-4000-8000-000000000001",
      message_id: "outlook-message-id-123",
      destinatario: "solicitante@example.com",
      assunto: "RE: Teste",
      mensagem: "Resposta",
      prioridade: "Alta",
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

async function captureReplyPayload(options = {}) {
  const nativeFetch = globalThis.fetch;
  const previousUrl = process.env.POWER_AUTOMATE_REPLY_URL;
  let captured;

  process.env.POWER_AUTOMATE_REPLY_URL =
    "https://power-automate.example.test/reply";
  globalThis.fetch = async (url, requestOptions) => {
    captured = { url, requestOptions };
    return new Response(null, { status: 204 });
  };

  try {
    await sendTicketReply({
      ticketId: "00000000-0000-4000-8000-000000000001",
      messageId: "outlook-message-id-123",
      destinatario: "solicitante@example.com",
      assunto: "RE: Teste",
      mensagem: "Resposta",
      ...options,
    });
    return JSON.parse(captured.requestOptions.body);
  } finally {
    globalThis.fetch = nativeFetch;
    if (previousUrl) process.env.POWER_AUTOMATE_REPLY_URL = previousUrl;
    else delete process.env.POWER_AUTOMATE_REPLY_URL;
  }
}

test("serviço de e-mail envia prioridade Baixa", async () => {
  const payload = await captureReplyPayload({ prioridade: "Baixa" });
  assert.equal(payload.prioridade, "Baixa");
});

test("serviço de e-mail envia prioridade Normal", async () => {
  const payload = await captureReplyPayload({ prioridade: "Normal" });
  assert.equal(payload.prioridade, "Normal");
});

test("serviço de e-mail usa prioridade Normal para ticket legado", async () => {
  const payload = await captureReplyPayload();
  assert.equal(payload.prioridade, "Normal");
});

test("serviço de e-mail não chama Power Automate sem message_id", async () => {
  const nativeFetch = globalThis.fetch;
  const previousUrl = process.env.POWER_AUTOMATE_REPLY_URL;
  let called = false;

  process.env.POWER_AUTOMATE_REPLY_URL =
    "https://power-automate.example.test/reply";
  globalThis.fetch = async () => {
    called = true;
    return new Response(null, { status: 204 });
  };

  try {
    await assert.rejects(
      sendTicketReply({
        ticketId: "00000000-0000-4000-8000-000000000001",
        messageId: "",
        destinatario: "solicitante@example.com",
        assunto: "RE: Teste",
        mensagem: "Resposta",
        prioridade: "Alta",
      }),
      (error) => {
        assert.equal(error.statusCode, 400);
        return true;
      },
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = nativeFetch;
    if (previousUrl) process.env.POWER_AUTOMATE_REPLY_URL = previousUrl;
    else delete process.env.POWER_AUTOMATE_REPLY_URL;
  }
});
