import { Router } from "express";
import {
  generalLimiter,
  getClientIp,
  rateLimitMiddleware,
} from "../config/rate-limit.js";
import {
  abrirFotografia,
  abrirImagemCandidata,
  atualizarSolicitacao,
  baixarAssinatura,
  buscarSolicitacao,
  enviarFotografia,
  gerarAssinatura,
  listarSolicitacoes,
} from "../controllers/signature-request.controller.js";
import { authenticate } from "../middlewares/auth.middleware.js";
import { parseMultipartFile } from "../middlewares/multipart.middleware.js";
import { MAX_SIGNATURE_IMAGE_BYTES } from "../services/signature-request.service.js";

const router = Router();
const limit = rateLimitMiddleware(
  generalLimiter,
  (req) => req.user?.id || getClientIp(req),
);

router.use(authenticate);
router.get("/", limit, listarSolicitacoes);
router.get("/:id/photo", limit, abrirFotografia);
router.get("/:id/images/:attachmentId", limit, abrirImagemCandidata);
router.post(
  "/:id/photo",
  limit,
  parseMultipartFile("photo", MAX_SIGNATURE_IMAGE_BYTES),
  enviarFotografia,
);
router.post(
  "/:id/generate",
  limit,
  parseMultipartFile("signature", MAX_SIGNATURE_IMAGE_BYTES),
  gerarAssinatura,
);
router.get("/:id/history/:artifactId", limit, baixarAssinatura);
router.get("/:id", limit, buscarSolicitacao);
router.put("/:id", limit, atualizarSolicitacao);

export default router;
