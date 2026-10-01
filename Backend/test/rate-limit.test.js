import test from "node:test";
import assert from "node:assert/strict";
import {
  createLimiter,
  rateLimitMiddleware,
  loginLimiter,
} from "../src/config/rate-limit.js";

test("Cenário 1 — produção + Upstash disponível → rate limit distribuído", async () => {
  let redisInvoked = false;

  const mockRedis = {
    evalsha: async () => {
      redisInvoked = true;
      return [1, Date.now() + 60000];
    },
    eval: async () => {
      redisInvoked = true;
      return [1, Date.now() + 60000];
    },
    sadd: async () => 1,
  };

  const limiter = createLimiter("test-dist", 5, "1 m", 60000, mockRedis);
  assert.equal(limiter.isDistributed, true);

  const res = await limiter.limit("127.0.0.1:dist-user");
  assert.equal(res.success, true);
  assert.equal(redisInvoked, true);
});

test("Cenário 2 — produção + Upstash indisponível → request continua funcionando com fallback", async () => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    // Sem cliente Redis (customRedis = null)
    const limiter = createLimiter("test-fallback", 5, "1 m", 60000, null);
    assert.equal(limiter.isDistributed, undefined);

    let nextCalled = false;
    const req = { headers: {}, ip: "192.168.1.100" };
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        this.body = data;
        return this;
      },
    };

    const middleware = rateLimitMiddleware(limiter);
    await middleware(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  } finally {
    process.env.NODE_ENV = previousEnv;
  }
});

test("Cenário 3 — excesso de requisições continua sendo bloqueado com HTTP 429", async () => {
  const limiter = createLimiter("test-block", 3, "1 m", 60000, null);
  const identifier = "10.0.0.99";

  // 3 requisições permitidas
  for (let i = 0; i < 3; i++) {
    const res = await limiter.limit(identifier);
    assert.equal(res.success, true);
  }

  // 4ª requisição é bloqueada
  const blocked = await limiter.limit(identifier);
  assert.equal(blocked.success, false);
  assert.equal(blocked.remaining, 0);

  // Validação através do middleware retornando HTTP 429
  let nextCalled = false;
  const req = { headers: {}, ip: identifier };
  let responseStatus = null;
  let responseJson = null;
  const res = {
    status(code) {
      responseStatus = code;
      return this;
    },
    json(body) {
      responseJson = body;
      return this;
    },
  };

  const middleware = rateLimitMiddleware(limiter, (r) => r.ip);
  await middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(responseStatus, 429);
  assert.equal(responseJson.success, false);
});

test("Cenário 4 — login não pode ser bloqueado por RATE_LIMIT_UNAVAILABLE em produção", async () => {
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    let nextCalled = false;
    const req = {
      headers: {},
      ip: "10.0.0.1",
      body: { email: "atendente@empresa.com" },
    };
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };

    const middleware = rateLimitMiddleware(loginLimiter, (r) => `${r.ip}:${r.body?.email}`);
    await middleware(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  } finally {
    process.env.NODE_ENV = previousEnv;
  }
});
