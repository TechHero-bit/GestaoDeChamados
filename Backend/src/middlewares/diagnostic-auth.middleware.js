import { timingSafeEqual } from "node:crypto";

/**
 * MIDDLEWARE TEMPORÁRIO — autenticação da rota de diagnóstico Microsoft.
 *
 * Protege a rota via header `x-diagnostic-secret`.
 * Usa comparação em tempo constante (timingSafeEqual) para evitar timing attacks.
 *
 * Variável de ambiente esperada: MICROSOFT_DIAGNOSTIC_SECRET
 *
 * ⚠️  REMOVER após conclusão do diagnóstico.
 */
export function diagnosticAuth(req, res, next) {
  const receivedSecret = req.headers["x-diagnostic-secret"];
  const expectedSecret = process.env.MICROSOFT_DIAGNOSTIC_SECRET?.trim();

  if (!expectedSecret) {
    console.error("[MICROSOFT_DIAG] MICROSOFT_DIAGNOSTIC_SECRET não configurado.");
    return res.status(500).json({
      success: false,
      message: "Configuração de diagnóstico ausente no servidor.",
    });
  }

  const received = Buffer.from(receivedSecret || "");
  const expected = Buffer.from(expectedSecret);
  const isValid =
    received.length === expected.length && timingSafeEqual(received, expected);

  if (!isValid) {
    return res.status(401).json({
      success: false,
      message: "Não autorizado. Segredo de diagnóstico inválido ou ausente.",
    });
  }

  next();
}
