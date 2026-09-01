import { Router } from "express";
import {
  connectMicrosoft,
  disconnectMicrosoft,
  microsoftCallback,
  microsoftStatus,
  sendMicrosoftTestEmail,
  sendMicrosoftTicketReplyTest,
} from "../controllers/microsoft-integration.controller.js";
import { authenticate } from "../middlewares/auth.middleware.js";

const router = Router();

router.get("/connect", authenticate, connectMicrosoft);
router.get("/callback", microsoftCallback);
router.get("/status", authenticate, microsoftStatus);
router.post("/disconnect", authenticate, disconnectMicrosoft);
router.post("/test-email", authenticate, sendMicrosoftTestEmail);
router.post("/test-ticket-reply/:ticketId", authenticate, sendMicrosoftTicketReplyTest);

export default router;
