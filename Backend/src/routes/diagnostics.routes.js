/**
 * ROTA TEMPORÁRIA — Diagnóstico Microsoft Graph / Shared Mailbox
 * ==============================================================
 * Protegida por header x-diagnostic-secret (MICROSOFT_DIAGNOSTIC_SECRET).
 *
 * GET /api/diagnostics/microsoft/shared-mailbox-message
 *   ?userId=<uuid>&messageId=<graph-message-id>
 *
 * ⚠️  REMOVER após conclusão do diagnóstico.
 */

import { Router } from "express";
import { diagSharedMailboxMessage } from "../controllers/microsoft-diagnostic.controller.js";
import { diagnosticAuth } from "../middlewares/diagnostic-auth.middleware.js";

const router = Router();

// Autenticação via x-diagnostic-secret aplicada a toda a sub-árvore /diagnostics
router.use(diagnosticAuth);

router.get("/microsoft/shared-mailbox-message", diagSharedMailboxMessage);

export default router;
