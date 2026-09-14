import { Router } from "express";
import { webhookAuth } from "../middlewares/webhook-auth.middleware.js";
import {
  confirmarAnexoOutlook,
  falharAnexoOutlook,
  receberEmailOutlook,
} from "../controllers/webhook.controller.js";

const router = Router();

// Todas são chamadas exclusivamente pelo mesmo fluxo Outlook → SmartDesk.
router.post("/outlook", webhookAuth, receberEmailOutlook);
router.post("/outlook/attachments/complete", webhookAuth, confirmarAnexoOutlook);
router.post("/outlook/attachments/fail", webhookAuth, falharAnexoOutlook);

export default router;
