import { Router } from "express";
import {
  getClientIp,
  loginLimiter,
  rateLimitMiddleware,
} from "../config/rate-limit.js";
import {
  activity,
  login,
  logout,
  me,
} from "../controllers/auth.controller.js";
import { authenticate } from "../middlewares/auth.middleware.js";

const router = Router();

// POST /api/auth/login — Rate limited (5 reqs / 15 min por IP + e-mail)
router.post(
  "/login",
  rateLimitMiddleware(loginLimiter, (req) => {
    const email = req.body?.email
      ? String(req.body.email).trim().toLowerCase()
      : "";
    return `${getClientIp(req)}:${email}`;
  }),
  login,
);

// POST /api/auth/logout — Revoga sessão e limpa cookie
router.post("/logout", logout);

// GET /api/auth/me — Usuário autenticado
router.get("/me", authenticate, me);

// POST /api/auth/activity — Atualização leve de atividade
router.post("/activity", authenticate, activity);

export default router;
