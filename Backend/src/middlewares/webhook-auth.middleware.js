/**
 * Middleware de autenticação do webhook.
 * Compara header x-webhook-secret com WEBHOOK_SECRET.
 */
export function webhookAuth(req, res, next) {
  const secret = req.headers["x-webhook-secret"];
  const expectedSecret = process.env.WEBHOOK_SECRET;

  if (!expectedSecret) {
    console.error("❌ WEBHOOK_SECRET não configurado no .env");
    return res.status(500).json({
      success: false,
      message: "Configuração de webhook ausente no servidor.",
    });
  }

  const received = Buffer.from(secret || "");
  const expected = Buffer.from(expectedSecret);
  const isValid =
    received.length === expected.length && timingSafeEqual(received, expected);

  if (!isValid) {
    return res.status(401).json({
      success: false,
      message: "Não autorizado. Segredo do webhook inválido.",
    });
  }

  next();
}
import { timingSafeEqual } from "node:crypto";
