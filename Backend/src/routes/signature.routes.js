import { Router } from "express";
import {
  deleteSignature,
  getSignature,
  updateSignatureSettings,
  uploadSignature,
} from "../controllers/signature.controller.js";
import { authenticate } from "../middlewares/auth.middleware.js";
import { parseMultipart } from "../middlewares/multipart.middleware.js";

const router = Router();

router.use(authenticate);
router.get("/signature", getSignature);
router.post("/signature", parseMultipart, uploadSignature);
router.put("/signature/settings", updateSignatureSettings);
router.delete("/signature", deleteSignature);

export default router;
