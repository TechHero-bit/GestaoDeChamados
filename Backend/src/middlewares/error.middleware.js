/**
 * Middleware centralizado de tratamento de erros.
 * Formato consistente: { success: false, message }
 */
export function errorMiddleware(err, req, res, _next) {
  const statusCode = err.statusCode || 500;
  const message = err.message || "Erro interno do servidor.";

  if (err.microsoftDiagnosticError) {
    return res.status(statusCode).json({
      success: false,
      message,
      code: err.diagnosticCode,
    });
  }

  if (err.microsoftAuthError) {

    return res.status(statusCode).json({
      success: false,
      message,
      code: err.diagnosticCode,
    });
  }

  if (err.signatureError) {
    console.error("❌ Erro de assinatura:", err.signatureLog);
    return res.status(statusCode).json({
      success: false,
      message,
      ...(err.publicCode ? { code: err.publicCode } : {}),
    });
  }

  // Log detalhado somente em desenvolvimento
  if (process.env.NODE_ENV !== "production") {
    console.error("❌ Erro:", {
      status: statusCode,
      message,
      stack: err.stack,
      path: req.originalUrl,
      method: req.method,
    });
  } else {
    console.error(`❌ ${req.method} ${req.originalUrl} → ${statusCode}`);
  }

  res.status(statusCode).json({
    success: false,
    message:
      statusCode === 500 && process.env.NODE_ENV === "production"
        ? "Erro interno do servidor."
        : message,
  });
}
