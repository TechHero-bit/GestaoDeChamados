import assert from "node:assert/strict";
import { test } from "node:test";
import { microsoftCallback } from "../src/controllers/microsoft-integration.controller.js";

const state = "a".repeat(43);

function response() {
  return {
    statusCode: 200,
    location: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    redirect(location) { this.statusCode = 302; this.location = location; return this; },
  };
}

async function withFrontendUrl(url, run) {
  const previous = process.env.FRONTEND_URL;
  process.env.FRONTEND_URL = url;
  try { await run(); } finally {
    if (previous === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previous;
  }
}

test("callback salva a conexão e retorna à raiz pública do frontend sem expor código ou state", async () => {
  await withFrontendUrl("https://portal.example.com", async () => {
    const res = response();
    let completed = false;
    await microsoftCallback({ query: { state, code: "private-code" } }, res, assert.fail, {
      completeConnection: async (values) => {
        assert.deepEqual(values, { state, code: "private-code" });
        completed = true;
      },
    });
    assert.equal(completed, true);
    assert.equal(res.statusCode, 302);
    assert.equal(res.location, "https://portal.example.com/?microsoft=connected");
    assert.equal(res.location.includes(state), false);
    assert.equal(res.location.includes("private-code"), false);
  });
});

test("cancelamento valida o state e retorna à mesma raiz com resultado de erro", async () => {
  await withFrontendUrl("https://portal.example.com/", async () => {
    const res = response();
    let consumed = false;
    await microsoftCallback({ query: { state, error: "access_denied" } }, res, assert.fail, {
      consumeState: async (value) => { assert.equal(value, state); consumed = true; return { user_id: "user-1" }; },
      completeConnection: async () => assert.fail("não deve trocar tokens"),
    });
    assert.equal(consumed, true);
    assert.equal(res.location, "https://portal.example.com/?microsoft=error");
  });
});

test("falha ao conectar retorna erro sem dados internos no redirecionamento", async () => {
  await withFrontendUrl("https://portal.example.com", async () => {
    const res = response();
    await microsoftCallback({ query: { state, code: "private-code" } }, res, assert.fail, {
      completeConnection: async () => { throw new Error("private-token-error"); },
    });
    assert.equal(res.location, "https://portal.example.com/?microsoft=error");
  });
});

test("state expirado é rejeitado sem redirecionar para o portal", async () => {
  await withFrontendUrl("https://portal.example.com", async () => {
    const res = response();
    await microsoftCallback({ query: { state, error: "access_denied" } }, res, assert.fail, {
      consumeState: async () => null,
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.location, null);
  });
});

test("configuração inválida de destino é rejeitada antes de salvar a conexão", async () => {
  await withFrontendUrl("invalid-url", async () => {
    const res = response();
    let caught;
    await microsoftCallback({ query: { state, code: "private-code" } }, res, (error) => { caught = error; }, {
      completeConnection: async () => assert.fail("não deve salvar antes de validar destino"),
    });
    assert.equal(caught.statusCode, 500);
    assert.equal(res.location, null);
  });
});
