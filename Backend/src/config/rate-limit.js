import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Memória local para desenvolvimento e fallback caso Redis não esteja configurado
class InMemorySlidingWindowLimiter {
  constructor(maxRequests, windowMs) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.hits = new Map();

    // Limpeza periódica a cada 5 minutos
    setInterval(() => {
      const now = Date.now();
      for (const [key, timestamps] of this.hits.entries()) {
        const valid = timestamps.filter((t) => now - t < this.windowMs);
        if (valid.length === 0) {
          this.hits.delete(key);
        } else {
          this.hits.set(key, valid);
        }
      }
    }, 5 * 60 * 1000).unref();
  }

  async limit(identifier) {
    const now = Date.now();
    const timestamps = (this.hits.get(identifier) || []).filter(
      (t) => now - t < this.windowMs,
    );

    if (timestamps.length >= this.maxRequests) {
      return {
        success: false,
        limit: this.maxRequests,
        remaining: 0,
        reset: now + this.windowMs,
      };
    }

    timestamps.push(now);
    this.hits.set(identifier, timestamps);

    return {
      success: true,
      limit: this.maxRequests,
      remaining: this.maxRequests - timestamps.length,
      reset: now + this.windowMs,
    };
  }
}

let redisClient = null;
const isProduction = process.env.NODE_ENV === "production";
const redisUrl = process.env.UPSTASH_REDIS_REST_URL?.trim();
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
if (redisUrl && redisToken) {
  try {
    redisClient = new Redis({
      url: redisUrl,
      token: redisToken,
    });
  } catch (error) {
    console.warn(
      "Aviso: Não foi possível conectar ao Upstash Redis. Usando fallback em memória.",
      error.message,
    );
  }
} else if (isProduction) {
  console.warn(
    "Aviso: Rate limiting distribuído (Upstash Redis) não configurado em produção. Utilizando fallback em memória de forma controlada.",
  );
}

export function createLimiter(
  prefix,
  maxRequests,
  windowStr,
  windowMs,
  customRedis = redisClient,
) {
  const fallbackLimiter = new InMemorySlidingWindowLimiter(
    maxRequests,
    windowMs,
  );

  if (customRedis) {
    const upstashLimiter = new Ratelimit({
      redis: customRedis,
      limiter: Ratelimit.slidingWindow(maxRequests, windowStr),
      prefix: `helpdesk:ratelimit:${prefix}`,
      analytics: false,
    });
    return {
      isDistributed: true,
      limit: async (identifier) => {
        try {
          return await upstashLimiter.limit(identifier);
        } catch (error) {
          console.warn(
            `Aviso: Falha no Upstash Redis para limiter [${prefix}]. Acionando fallback em memória:`,
            error.message,
          );
          return await fallbackLimiter.limit(identifier);
        }
      },
    };
  }

  // Quando Upstash não estiver configurado ou disponível, utiliza o fallback
  // em memória já existente para não indisponibilizar a autenticação e as rotas.
  return fallbackLimiter;
}

// Limitadores configurados
export const loginLimiter = createLimiter(
  "login",
  5,
  "15 m",
  15 * 60 * 1000, // 5 tentativas a cada 15 min
);

export const replyLimiter = createLimiter(
  "reply",
  10,
  "1 m",
  60 * 1000, // 10 envios por minuto
);

export const generalLimiter = createLimiter(
  "general",
  150,
  "1 m",
  60 * 1000, // 150 requisições por minuto
);

export function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return String(forwarded).split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || "127.0.0.1";
}

/**
 * Middleware factory para aplicar rate limiting
 */
export function rateLimitMiddleware(
  limiter,
  getIdentifier = (req) => getClientIp(req),
) {
  return async (req, res, next) => {
    try {
      const identifier = getIdentifier(req);
      const result = await limiter.limit(identifier);

      if (!result.success) {
        return res.status(429).json({
          success: false,
          message:
            "Muitas requisições. Tente novamente em alguns minutos.",
        });
      }

      next();
    } catch (error) {
      console.error("Erro no rate limiting:", error.message);
      // Fail-open: falha inesperada no serviço de rate limit não deve indisponibilizar a aplicação com 503
      next();
    }
  };
}
