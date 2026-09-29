import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readGraphErrorDetails,
  readGraphErrorCode,
  replyToMicrosoftMessage,
} from "../src/services/microsoft-graph.service.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const DUMMY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("readGraphErrorDetails extrai code, message, innerError e headers com segurança", async () => {
  const mockResponse = new Response(
    JSON.stringify({
      error: {
        code: "ErrorItemNotFound",
        message: "The specified object was not found in the store.",
        innerError: {
          code: "ItemNotFound",
          "request-id": "req-inner-123",
          "client-request-id": "client-inner-456",
        },
      },
    }),
    {
      status: 404,
      headers: {
        "content-type": "application/json",
        "request-id": "req-header-789",
        "client-request-id": "client-header-012",
      },
    },
  );

  const details = await readGraphErrorDetails(mockResponse);
  assert.equal(details.code, "ErrorItemNotFound");
  assert.equal(details.message, "The specified object was not found in the store.");
  assert.equal(details.innerErrorCode, "ItemNotFound");
  // Header tem prioridade ou é capturado
  assert.equal(details.requestId, "req-header-789");
  assert.equal(details.clientRequestId, "client-header-012");

  const code = await readGraphErrorCode(mockResponse);
  assert.equal(code, "ErrorItemNotFound");
});

test("readGraphErrorDetails lida com falha de parse ou corpo vazio sem erro", async () => {
  const emptyResponse = new Response("", { status: 500 });
  const details = await readGraphErrorDetails(emptyResponse);
  assert.deepEqual(details, {
    code: undefined,
    message: undefined,
    innerErrorCode: undefined,
    requestId: undefined,
    clientRequestId: undefined,
  });
});

test("createReply com falha registra MICROSOFT_GRAPH_DIAGNOSTIC e preserva detalhes internamente sem expor token", async () => {
  const logs = [];
  const originalConsoleInfo = console.info;
  console.info = (...args) => logs.push(args.join(" "));

  const sensitiveToken = "Bearer-secret-access-token-12345";
  const sensitiveEmailHtml = "<div>Secret Email Body Content</div><br><br><img src=\"cid:smartdesk-signature\">";

  try {
    await assert.rejects(
      replyToMicrosoftMessage(
        USER_ID,
        {
          messageId: "AAMkAGExYW1wbGUxMjM0NTY3ODkw",
          message: "Mensagem do operador",
          html: sensitiveEmailHtml,
          inlineAttachment: {
            contentId: "smartdesk-signature",
            contentBytes: DUMMY_PNG_BASE64,
          },
        },
        {
          getAccessToken: async () => sensitiveToken,
          fetchImpl: async (url, options) => {
            if (url.endsWith("/createReply")) {
              return new Response(
                JSON.stringify({
                  error: {
                    code: "ErrorItemNotFound",
                    message: "The specified object was not found in the store.",
                  },
                }),
                {
                  status: 404,
                  headers: {
                    "Content-Type": "application/json",
                    "request-id": "req-test-uuid-001",
                    "client-request-id": "client-test-uuid-002",
                  },
                },
              );
            }
            return new Response("{}", { status: 200 });
          },
        },
      ),
      (error) => {
        // Preserva o contrato funcional
        assert.equal(error.statusCode, 502);
        assert.equal(error.publicCode, "SIGNATURE_DRAFT_FAILED");
        assert.equal(error.message, "A Microsoft não aceitou a criação do rascunho da resposta.");
        assert.equal(error.safeToFallback, false);
        // Preserva diagnóstico interno do Graph
        assert.equal(error.graphStatus, 404);
        assert.equal(error.graphError, "ErrorItemNotFound");
        assert.equal(error.graphDetails.code, "ErrorItemNotFound");
        assert.equal(error.graphDetails.message, "The specified object was not found in the store.");
        assert.equal(error.graphDetails.requestId, "req-test-uuid-001");
        assert.equal(error.graphDetails.clientRequestId, "client-test-uuid-002");
        return true;
      },
    );
  } finally {
    console.info = originalConsoleInfo;
  }

  const allLogs = logs.join("\n");
  // Confirma captura de diagnóstico
  assert.equal(allLogs.includes("MICROSOFT_GRAPH_DIAGNOSTIC"), true);
  assert.equal(allLogs.includes("operation=createReply"), true);
  assert.equal(allLogs.includes("status=404"), true);
  assert.equal(allLogs.includes("code=ErrorItemNotFound"), true);
  assert.equal(allLogs.includes("message=The specified object was not found in the store."), true);
  assert.equal(allLogs.includes("requestId=req-test-uuid-001"), true);
  assert.equal(allLogs.includes("clientRequestId=client-test-uuid-002"), true);

  // Confirma segurança: JAMAIS expõe token ou corpo do email nos logs
  assert.equal(allLogs.includes(sensitiveToken), false);
  assert.equal(allLogs.includes("Secret Email Body Content"), false);
  assert.equal(allLogs.includes("htmlMeta="), true);
  assert.equal(allLogs.includes("containsSignatureCid"), true);
});

test("patchDraft com falha registra etapa patchDraft e preserva diagnóstico", async () => {
  const logs = [];
  const originalConsoleInfo = console.info;
  console.info = (...args) => logs.push(args.join(" "));

  try {
    await assert.rejects(
      replyToMicrosoftMessage(
        USER_ID,
        {
          messageId: "msg-id-123",
          message: "Mensagem",
          html: '<div>Resp</div><br><br><img src="cid:smartdesk-signature">',
          inlineAttachment: {
            contentId: "smartdesk-signature",
            contentBytes: DUMMY_PNG_BASE64,
          },
        },
        {
          getAccessToken: async () => "token-safe",
          fetchImpl: async (url, options) => {
            if (url.endsWith("/createReply")) {
              return new Response(JSON.stringify({ id: "draft-xyz" }), { status: 201 });
            }
            if (options.method === "PATCH") {
              return new Response(
                JSON.stringify({
                  error: {
                    code: "ErrorInvalidRequest",
                    message: "Invalid patch body content",
                  },
                }),
                {
                  status: 400,
                  headers: { "request-id": "patch-req-1" },
                },
              );
            }
            return new Response("{}", { status: 200 });
          },
        },
      ),
      (error) => {
        assert.equal(error.publicCode, "SIGNATURE_DRAFT_FAILED");
        assert.equal(error.graphStatus, 400);
        assert.equal(error.graphError, "ErrorInvalidRequest");
        assert.equal(error.graphDetails.requestId, "patch-req-1");
        return true;
      },
    );
  } finally {
    console.info = originalConsoleInfo;
  }

  const allLogs = logs.join("\n");
  assert.equal(allLogs.includes("operation=patchDraft"), true);
  assert.equal(allLogs.includes("status=400"), true);
  assert.equal(allLogs.includes("code=ErrorInvalidRequest"), true);
});
