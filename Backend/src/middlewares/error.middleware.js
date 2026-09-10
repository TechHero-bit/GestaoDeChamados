/**
 * Middleware centralizado de tratamento de erros.
 * Formato consistente: { success: false, message }
 */
export function errorMiddleware(err, req, res, _next) {
  const statusCode = err.statusCode || 500;
  const message = err.message || "Erro interno do servidor.";

  if (err.microsoftDiagnosticError) {
    const errorCode = err.code || err.publicCode || err.diagnosticCode;
    const safeAttachmentDebug = err.attachmentDebug && typeof err.attachmentDebug === "object"
      ? Object.fromEntries([
          "draft_exists",
          "draft_sent_before_attachment",
          "same_draft",
          "payload_direct_object",
          "odata_type_matches_signature",
          "buffer_present",
          "base64_roundtrip_valid",
        ].map((key) => [key, err.attachmentDebug[key] === true]))
      : null;
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
          ...(safeAttachmentDebug ? { attachment_debug: safeAttachmentDebug } : {}),
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

  const safeCompletionDebug = err.publicCode === "ATTACHMENTS_INCOMPLETE"
    && err.attachmentDebug && typeof err.attachmentDebug === "object"
    ? Object.fromEntries(Object.entries(err.attachmentDebug).filter(([key, value]) =>
        [
          "expected_regular_count", "graph_regular_count", "expected_count", "found_count",
          "missing_count", "unexpected_count", "manifest_attachment_count", "expected_size",
          "parsed_buffer_size", "graph_size",
        ].includes(key)
          ? Number.isSafeInteger(value) && value >= 0
          : key === "size_delta"
            ? Number.isSafeInteger(value)
          : [
              "signature_expected", "signature_found", "regular_name_matches",
              "regular_size_matches", "regular_inline_matches", "all_regular_found",
              "small_upload_confirmed", "graph_regular_attachment_found",
              "draft_handle_current", "ready_to_send", "parser_size_matches",
              "base64_roundtrip_valid", "graph_create_confirmed",
            ].includes(key) && typeof value === "boolean"))
    : null;

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
    ...(safeCompletionDebug ? { attachment_debug: safeCompletionDebug } : {}),
    message:
      statusCode === 500 && process.env.NODE_ENV === "production"
        ? "Erro interno do servidor."
        : message,
  });
}
