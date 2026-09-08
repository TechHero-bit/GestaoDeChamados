const SIGNATURE_DEBUG_FIELDS = [
  "enabled",
  "path_found",
  "same_authenticated_user",
  "storage_downloaded",
  "draft_created",
  "body_contains_cid",
  "attachment_created",
  "attachment_inline",
  "content_id_matches",
  "draft_sent",
];

function safeSignatureDebug(debug) {
  if (!debug || typeof debug !== "object") return null;
  const safe = {};
  for (const field of SIGNATURE_DEBUG_FIELDS) {
    if (typeof debug[field] === "boolean") safe[field] = debug[field];
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

/**
 * Middleware centralizado de tratamento de erros.
 * Formato consistente: { success: false, message }
 */
export function errorMiddleware(err, req, res, _next) {
  const statusCode = err.statusCode || 500;
  const message = err.message || "Erro interno do servidor.";
  const signatureDebug = safeSignatureDebug(err.signatureDebug);

  if (err.microsoftDiagnosticError) {
    return res.status(statusCode).json({
      success: false,
      message,
      code: err.diagnosticCode,
      ...(signatureDebug ? { signature_debug: signatureDebug } : {}),
    });
  }

  if (err.microsoftAuthError) {

    return res.status(statusCode).json({
      success: false,
      message,
      code: err.diagnosticCode,
      ...(signatureDebug ? { signature_debug: signatureDebug } : {}),
    });
  }

  if (err.signatureError) {
    console.error("❌ Erro de assinatura:", err.signatureLog);
    return res.status(statusCode).json({
      success: false,
      message,
      ...(err.publicCode ? { code: err.publicCode } : {}),
      ...(signatureDebug ? { signature_debug: signatureDebug } : {}),
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
    ...(signatureDebug ? { signature_debug: signatureDebug } : {}),
  });
}
