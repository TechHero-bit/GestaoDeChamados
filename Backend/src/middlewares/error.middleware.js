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

    // [TEMPORÁRIO - DIAGNÓSTICO] Expõe dados seguros do Graph na response HTTP.
    // Ativado somente quando o erro possuir operation (erros de assinatura/draft).
    // NUNCA expõe: token, secret, HTML, contentBytes, messageId completo.
    const graphDetails = err.graphDetails && typeof err.graphDetails === "object"
      ? err.graphDetails
      : null;

    // `err.operation` é populado por signatureGraphError para todas as etapas instrumentadas
    const safeOperation = typeof err.operation === "string" && /^[A-Za-z0-9_]{1,50}$/.test(err.operation)
      ? err.operation
      : (graphDetails?.operation && /^[A-Za-z0-9_]{1,50}$/.test(graphDetails.operation)
          ? graphDetails.operation
          : null);

    let diagnosticBlock = null;
    if (safeOperation !== null) {
      const safeStatus = typeof err.graphStatus === "number"
        ? err.graphStatus
        : (typeof graphDetails?.status === "number" ? graphDetails.status : null);

      const rawCode = graphDetails?.code;
      const safeCode = typeof rawCode === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(rawCode.trim())
        ? rawCode.trim()
        : (typeof err.graphError === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(err.graphError)
            ? err.graphError
            : null);

      const rawMessage = graphDetails?.message;
      const safeMessage = typeof rawMessage === "string" && rawMessage.trim().length > 0
        ? rawMessage.trim().slice(0, 500)
        : null;

      const rawInnerCode = graphDetails?.innerErrorCode;
      const safeInnerCode = typeof rawInnerCode === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(rawInnerCode.trim())
        ? rawInnerCode.trim()
        : null;

      const rawRequestId = graphDetails?.requestId;
      const safeRequestId = typeof rawRequestId === "string" && rawRequestId.trim().length > 0
        ? rawRequestId.trim().slice(0, 200)
        : null;

      const rawClientRequestId = graphDetails?.clientRequestId;
      const safeClientRequestId = typeof rawClientRequestId === "string" && rawClientRequestId.trim().length > 0
        ? rawClientRequestId.trim().slice(0, 200)
        : null;

      diagnosticBlock = {
        operation: safeOperation,
        status: safeStatus,
        code: safeCode,
        message: safeMessage,
        innerErrorCode: safeInnerCode,
        requestId: safeRequestId,
        clientRequestId: safeClientRequestId,
      };
    }


    return res.status(statusCode).json({
      success: false,
      message,
      code: errorCode,
      ...attachmentDetails,
      ...(diagnosticBlock && process.env.NODE_ENV !== "production"
        ? { diagnostic: diagnosticBlock }
        : {}),
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
