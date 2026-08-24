import { Router } from "express";
import {
  listarTickets,
  buscarTicket,
  atualizarTicket,
  excluirTicket,
  responderTicket,
} from "../controllers/ticket.controller.js";

const router = Router();

// GET    /api/tickets          — Listar tickets
// GET    /api/tickets/:id      — Buscar ticket com mensagens
// PUT    /api/tickets/:id      — Atualizar status
// DELETE /api/tickets/:id      — Excluir ticket
// POST   /api/tickets/:id/reply — Responder ao solicitante
router.get("/", listarTickets);
router.get("/:id", buscarTicket);
router.put("/:id", atualizarTicket);
router.delete("/:id", excluirTicket);
router.post("/:id/reply", responderTicket);

export default router;
