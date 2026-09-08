import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import app from "../src/app.js";
import {
  decryptMicrosoftToken,
  encryptMicrosoftToken,
} from "../src/services/microsoft-crypto.service.js";
import {
  completeMicrosoftConnection,
  consumeMicrosoftOAuthState,
  createMicrosoftOAuthState,
  disconnectMicrosoftConnection,
  getMicrosoftConnectionStatus,
  getValidMicrosoftAccessToken,
} from "../src/services/microsoft-oauth.service.js";
import { sendMicrosoftEmail } from "../src/services/microsoft-graph.service.js";
import { replyToMicrosoftMessage } from "../src/services/microsoft-graph.service.js";

class FakeSupabase {
  constructor() {
    this.microsoft_oauth_states = [];
    this.user_microsoft_connections = [];
    this.user_sessions = [];
    this.sequence = 0;
  }

  from(table) {
    return new FakeQuery(this, table);
  }
}

class FakeQuery {
  constructor(database, table) {
    this.database = database;
    this.table = table;
    this.operation = "select";
    this.values = null;
    this.filters = [];
    this.returnSingle = false;
    this.hasSelect = false;
  }

  select() {
    this.hasSelect = true;
    return this;
  }

  insert(values) {
    this.operation = "insert";
    this.values = values;
    return this;
  }

  upsert(values) {
    this.operation = "upsert";
    this.values = values;
    return this;
  }

  update(values) {
    this.operation = "update";
    this.values = values;
    return this;
  }

  eq(field, value) {
    this.filters.push((record) => record[field] === value);
    return this;
  }

  is(field, value) {
    this.filters.push((record) => record[field] === value);
    return this;
  }

  gt(field, value) {
    this.filters.push((record) => record[field] > value);
    return this;
  }

  maybeSingle() {
    this.returnSingle = true;
    return this;
  }

  single() {
    this.returnSingle = true;
    return this;
  }

  then(resolve, reject) {
    return Promise.resolve().then(() => this.execute()).then(resolve, reject);
  }

  execute() {
    const records = this.database[this.table];
    if (!records) return { data: null, error: new Error("Tabela fake ausente") };

    if (this.operation === "insert") {
      records.push({ id: `fake-${++this.database.sequence}`, ...(this.table === "microsoft_oauth_states" ? { used_at: null } : {}), ...this.values });
      return { data: null, error: null };
    }

    if (this.operation === "upsert") {
      let record = records.find((item) => item.user_id === this.values.user_id);
      if (!record) {
        record = { id: `fake-${++this.database.sequence}` };
        records.push(record);
      }
      Object.assign(record, this.values);
      return { data: this.returnSingle ? record : [record], error: null };
    }

    const matches = records.filter((record) => this.filters.every((filter) => filter(record)));
    if (this.operation === "update") {
      matches.forEach((record) => Object.assign(record, this.values));
    }
    const data = this.returnSingle ? matches[0] || null : matches;
    return { data, error: null };
  }
}

let server;
let baseUrl;

before(async () => {
  process.env.MICROSOFT_CLIENT_ID = "client-id";
  process.env.MICROSOFT_TENANT_ID = "tenant-id";
  process.env.MICROSOFT_CLIENT_SECRET = "client-secret";
  process.env.MICROSOFT_REDIRECT_URI =
    "https://gestao-de-chamados-backend.vercel.app/api/integrations/microsoft/callback";
  process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY =
    "test-microsoft-encryption-key-which-is-never-a-token";
  process.env.FRONTEND_URL = "http://localhost:4200";

  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test("rotas Microsoft que alteram ou consultam conexão exigem autenticação", async () => {
  for (const [method, path] of [
    ["GET", "/api/integrations/microsoft/connect"],
    ["GET", "/api/integrations/microsoft/status"],
    ["POST", "/api/integrations/microsoft/disconnect"],
  ]) {
    const response = await fetch(`${baseUrl}${path}`, { method });
    assert.equal(response.status, 401);
  }
});

test("callback rejeita state ausente ou inválido sem acessar tokens", async () => {
  const response = await fetch(`${baseUrl}/api/integrations/microsoft/callback?state=invalid`);
  assert.equal(response.status, 400);
  assert.match((await response.json()).message, /State OAuth/);
});

test("state é aleatório, fica armazenado como hash e só pode ser consumido uma vez", async () => {
  const database = new FakeSupabase();
  const now = new Date("2026-09-01T12:00:00.000Z");
  const state = await createMicrosoftOAuthState("user-1", { supabase: database, now });

  assert.notEqual(database.microsoft_oauth_states[0].state_hash, state);
  assert.equal(database.microsoft_oauth_states[0].user_id, "user-1");
  assert.equal((await consumeMicrosoftOAuthState(state, { supabase: database, now })).user_id, "user-1");
  assert.equal(await consumeMicrosoftOAuthState(state, { supabase: database, now }), null);
});

test("callback troca tokens simulados, cifra antes de persistir e status não vaza segredos", async () => {
  const database = new FakeSupabase();
  database.user_sessions.push({
    id: "session-1",
    user_id: "user-1",
    jti: "jti-1",
    revoked_at: null,
  });
  const sessionsBefore = structuredClone(database.user_sessions);
  const state = await createMicrosoftOAuthState("user-1", { supabase: database });
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes("/token")) {
      return new Response(
        JSON.stringify({
          access_token: "access-token-plain",
          refresh_token: "refresh-token-plain",
          expires_in: 3600,
          scope: "openid profile email offline_access User.Read Mail.ReadWrite Mail.Send",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ id: "ms-user-1", displayName: "Usuário Microsoft", mail: "user@example.com" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    await completeMicrosoftConnection({ state, code: "authorization-code", supabase: database });
  } finally {
    globalThis.fetch = nativeFetch;
  }

  const stored = database.user_microsoft_connections[0];
  assert.match(stored.access_token_encrypted, /^v1\./);
  assert.match(stored.refresh_token_encrypted, /^v1\./);
  assert.notEqual(stored.access_token_encrypted, "access-token-plain");
  assert.equal(decryptMicrosoftToken(stored.access_token_encrypted), "access-token-plain");
  assert.equal(decryptMicrosoftToken(stored.refresh_token_encrypted), "refresh-token-plain");

  const status = await getMicrosoftConnectionStatus("user-1", { supabase: database });
  assert.deepEqual(status, {
    connected: true,
    email: "user@example.com",
    display_name: "Usuário Microsoft",
    connected_at: stored.connected_at,
  });
  assert.equal(Object.hasOwn(status, "access_token"), false);
  assert.equal(Object.hasOwn(status, "refresh_token"), false);
  assert.deepEqual(database.user_sessions, sessionsBefore);
});

test("disconnect marca a conexão como revogada e refresh atualiza tokens expirados", async () => {
  const database = new FakeSupabase();
  database.user_microsoft_connections.push({
    id: "connection-1",
    user_id: "user-1",
    email: "user@example.com",
    display_name: "Usuário Microsoft",
    access_token_encrypted: encryptMicrosoftToken("expired-access"),
    refresh_token_encrypted: encryptMicrosoftToken("old-refresh"),
    access_token_expires_at: "2020-01-01T00:00:00.000Z",
    revoked_at: null,
  });

  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  try {
    const token = await getValidMicrosoftAccessToken("user-1", { supabase: database });
    assert.equal(token, "new-access");
    assert.equal(decryptMicrosoftToken(database.user_microsoft_connections[0].access_token_encrypted), "new-access");
    assert.equal(decryptMicrosoftToken(database.user_microsoft_connections[0].refresh_token_encrypted), "new-refresh");
  } finally {
    globalThis.fetch = nativeFetch;
  }

  await disconnectMicrosoftConnection("user-1", { supabase: database });
  assert.deepEqual(await getMicrosoftConnectionStatus("user-1", { supabase: database }), { connected: false });
});

test("Microsoft Graph recebe /me/sendMail, token interno e saveToSentItems=true", async () => {
  const database = new FakeSupabase();
  database.user_microsoft_connections.push({
    user_id: "user-1",
    access_token_encrypted: encryptMicrosoftToken("graph-access-token"),
    refresh_token_encrypted: encryptMicrosoftToken("graph-refresh-token"),
    access_token_expires_at: "2099-01-01T00:00:00.000Z",
    revoked_at: null,
  });

  let requestedUserId;
  let captured;
  await sendMicrosoftEmail(
    "user-1",
    { to: "destinatario@example.com", subject: "Assunto", html: "Mensagem<br>segura" },
    {
      getAccessToken: async (userId) => {
        requestedUserId = userId;
        return getValidMicrosoftAccessToken(userId, { supabase: database });
      },
      fetchImpl: async (url, options) => {
        captured = { url, options };
        return new Response(null, { status: 202 });
      },
    },
  );

  assert.equal(requestedUserId, "user-1");
  assert.equal(captured.url, "https://graph.microsoft.com/v1.0/me/sendMail");
  assert.equal(captured.options.method, "POST");
  assert.equal(captured.options.headers.Authorization, "Bearer graph-access-token");
  assert.deepEqual(JSON.parse(captured.options.body), {
    message: {
      subject: "Assunto",
      body: { contentType: "HTML", content: "Mensagem<br>segura" },
      toRecipients: [{ emailAddress: { address: "destinatario@example.com" } }],
    },
    saveToSentItems: true,
  });
});

test("endpoints temporários de teste foram removidos", async () => {
  for (const path of [
    "/api/integrations/microsoft/test-email",
    "/api/integrations/microsoft/test-ticket-reply/00000000-0000-4000-8000-000000000001",
  ]) {
    const response = await fetch(`${baseUrl}${path}`, { method: "POST" });
    assert.equal(response.status, 404);
  }
});

test("usuário sem Outlook conectado recebe erro controlado e Graph não é chamado", async () => {
  let graphCalled = false;
  await assert.rejects(
    sendMicrosoftEmail(
      "user-without-outlook",
      { to: "destinatario@example.com", subject: "Assunto", html: "Mensagem" },
      {
        getAccessToken: async () => {
          throw Object.assign(new Error("Conta Microsoft não conectada."), { statusCode: 404 });
        },
        fetchImpl: async () => {
          graphCalled = true;
          return new Response(null, { status: 202 });
        },
      },
    ),
    (error) => {
      assert.equal(error.statusCode, 404);
      assert.equal(error.message, "Conta Microsoft não conectada.");
      return true;
    },
  );
  assert.equal(graphCalled, false);
});

test("erro do Microsoft Graph não expõe resposta sensível nem token", async () => {
  const accessToken = "graph-secret-access-token";
  await assert.rejects(
    sendMicrosoftEmail(
      "user-1",
      { to: "destinatario@example.com", subject: "Assunto", html: "Mensagem" },
      {
        getAccessToken: async () => accessToken,
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: { message: "dados internos", accessToken } }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          }),
      },
    ),
    (error) => {
      assert.equal(error.statusCode, 502);
      assert.equal(error.message, "A Microsoft não aceitou o envio do e-mail.");
      assert.equal(error.message.includes(accessToken), false);
      return true;
    },
  );
});

test("reply do Graph usa o último message ID, faz URL encoding e não altera o payload local", async () => {
  const database = new FakeSupabase();
  database.user_microsoft_connections.push({
    user_id: "user-1",
    access_token_encrypted: encryptMicrosoftToken("reply-access-token"),
    refresh_token_encrypted: encryptMicrosoftToken("reply-refresh-token"),
    access_token_expires_at: "2099-01-01T00:00:00.000Z",
    revoked_at: null,
  });

  let captured;
  await replyToMicrosoftMessage(
    "user-1",
    { messageId: "message/id?part=1", message: "<script>alert('x')</script>\nResposta" },
    {
      getAccessToken: (userId) => getValidMicrosoftAccessToken(userId, { supabase: database }),
      fetchImpl: async (url, options) => {
        captured = { url, options };
        return new Response(null, { status: 202 });
      },
    },
  );

  assert.equal(
    captured.url,
    "https://graph.microsoft.com/v1.0/me/messages/message%2Fid%3Fpart%3D1/reply",
  );
  assert.equal(captured.options.headers.Authorization, "Bearer reply-access-token");
  assert.deepEqual(JSON.parse(captured.options.body), {
    message: {
      body: {
        contentType: "HTML",
        content: "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;<br>Resposta",
      },
    },
  });
  assert.equal(captured.options.body.includes("comment"), false);
});

test("reply do Graph trata 400, 401, 403 e 404 com mensagens controladas", async () => {
  const expected = {
    400: "GRAPH_BAD_REQUEST",
    401: "GRAPH_UNAUTHORIZED",
    403: "GRAPH_FORBIDDEN",
    404: "GRAPH_MESSAGE_NOT_FOUND",
  };

  for (const [status, code] of Object.entries(expected)) {
    await assert.rejects(
      replyToMicrosoftMessage(
        "user-1",
        { messageId: "message-id", message: "Teste" },
        {
          getAccessToken: async () => "reply-secret-token",
          fetchImpl: async () => new Response(JSON.stringify({ access_token: "reply-secret-token" }), { status: Number(status) }),
        },
      ),
      (error) => {
        assert.equal(error.statusCode, 502);
        assert.equal(error.publicCode, code);
        assert.equal(error.message.includes("reply-secret-token"), false);
        return true;
      },
    );
  }
});
