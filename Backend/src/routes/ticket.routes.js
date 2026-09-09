import { Router } from "express";
import {
  generalLimiter,
  getClientIp,
  rateLimitMiddleware,
  replyLimiter,
} from "../config/rate-limit.js";
import {
  adicionarAnexoSimplesResposta,
  atualizarTicket,
  buscarTicket,
  cancelarRascunhoResposta,
  criarRascunhoResposta,
  criarSessaoUploadResposta,
  excluirTicket,
  finalizarRascunhoResposta,
  listarTickets,
  responderTicket,
} from "../controllers/ticket.controller.js";
import { authenticate } from "../middlewares/auth.middleware.js";
import { requireRole } from "../middlewares/role.middleware.js";
import { parseMultipartFile } from "../middlewares/multipart.middleware.js";
import {
  REPLY_ATTACHMENT_FILE_FIELD,
  SMALL_ATTACHMENT_LIMIT_BYTES,
} from "../services/reply-attachment-policy.service.js";

const router = Router();

// Todas as rotas de tickets exigem autenticação prévia
router.use(authenticate);

// GET /api/tickets — Listar tickets
router.get(
  "/",
  rateLimitMiddleware(generalLimiter, (req) => req.user?.id || getClientIp(req)),
  listarTickets,
);

// GET /api/tickets/:id — Buscar ticket com mensagens
router.get(
  "/:id",
  rateLimitMiddleware(generalLimiter, (req) => req.user?.id || getClientIp(req)),
  buscarTicket,
);

// PUT /api/tickets/:id — Atualizar campos permitidos do ticket
router.put(
  "/:id",
  rateLimitMiddleware(generalLimiter, (req) => req.user?.id || getClientIp(req)),
  atualizarTicket,
);

// DELETE /api/tickets/:id — Excluir ticket (Apenas perfil ADMIN)
router.delete(
  "/:id",
  requireRole("ADMIN"),
  rateLimitMiddleware(generalLimiter, (req) => req.user?.id || getClientIp(req)),
  excluirTicket,
);

// POST /api/tickets/:id/reply — Responder ao solicitante (Rate limited: 10/min)
router.post(
  "/:id/reply",
  rateLimitMiddleware(replyLimiter, (req) => req.user?.id || getClientIp(req)),
  responderTicket,
);

router.post(
  "/:id/reply/draft",
  rateLimitMiddleware(replyLimiter, (req) => req.user?.id || getClientIp(req)),
  criarRascunhoResposta,
);

router.post(
  "/:id/reply/draft/attachments",
  rateLimitMiddleware(generalLimiter, (req) => req.user?.id || getClientIp(req)),
  parseMultipartFile(REPLY_ATTACHMENT_FILE_FIELD, SMALL_ATTACHMENT_LIMIT_BYTES - 1),
  adicionarAnexoSimplesResposta,
);

router.post(
  "/:id/reply/draft/upload-session",
  rateLimitMiddleware(generalLimiter, (req) => req.user?.id || getClientIp(req)),
  criarSessaoUploadResposta,
);

router.post(
  "/:id/reply/draft/send",
  rateLimitMiddleware(replyLimiter, (req) => req.user?.id || getClientIp(req)),
  finalizarRascunhoResposta,
);

router.post(
  "/:id/reply/draft/cancel",
  rateLimitMiddleware(generalLimiter, (req) => req.user?.id || getClientIp(req)),
  cancelarRascunhoResposta,
);

export default router;
