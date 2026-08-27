import { Router } from "express";
import {
  generalLimiter,
  getClientIp,
  rateLimitMiddleware,
  replyLimiter,
} from "../config/rate-limit.js";
import {
  atualizarTicket,
  buscarTicket,
  excluirTicket,
  listarTickets,
  responderTicket,
} from "../controllers/ticket.controller.js";
import { authenticate } from "../middlewares/auth.middleware.js";
import { requireRole } from "../middlewares/role.middleware.js";

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

export default router;
