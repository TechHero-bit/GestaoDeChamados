import { Router } from "express";
import { webhookAuth } from "../middlewares/webhook-auth.middleware.js";
import { receberEmailOutlook } from "../controllers/webhook.controller.js";

const router = Router();

// POST /api/webhooks/outlook — Receber e-mail do Power Automate
router.post("/outlook", webhookAuth, receberEmailOutlook);

export default router;
