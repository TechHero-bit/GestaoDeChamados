/**
 * Middleware centralizado de tratamento de erros.
 * Formato consistente: { success: false, message }
 */
export function errorMiddleware(err, req, res, _next) {
  const statusCode = err.statusCode || 500;
  const message = err.message || "Erro interno do servidor.";

  if (err.microsoftDiagnosticError) {
    const errorCode = err.code || err.publicCode || err.diagnosticCode;
    const attachmentDetails = errorCode === "GRAPH_ATTACHMENT_FAILED"
      ? {
          graph_status: Number.isInteger(err.graphStatus) ? err.graphStatus : null,
          graph_error: typeof err.graphError === "string"
            && /^[A-Za-z0-9_.-]{1,100}$/.test(err.graphError)
            ? err.graphError
            : "unknown",
          attachment_strategy: err.attachmentStrategy === "small" || err.attachmentStrategy === "large"
            ? err.attachmentStrategy
            : "unknown",
        }
      : {};
    return res.status(statusCode).json({
      success: false,
      message,
      code: errorCode,
      ...attachmentDetails,
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
    ...(err.publicCode ? { code: err.publicCode } : {}),
    message:
      statusCode === 500 && process.env.NODE_ENV === "production"
        ? "Erro interno do servidor."
        : message,
  });
}
