import { AUTH_COOKIE_NAME, getClearCookieOptions } from "../config/auth-cookie.js";
import { validateSession, verifyToken } from "../services/auth.service.js";

/**
 * Middleware para autenticação via JWT em cookie HttpOnly e validação de sessão server-side.
 */
export async function authenticate(req, res, next) {
  try {
    let token = req.cookies?.[AUTH_COOKIE_NAME];

    // Fallback opcional para Authorization header caso necessário
    if (!token && req.headers.authorization?.startsWith("Bearer ")) {
      token = req.headers.authorization.slice(7).trim();
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Não autenticado. Faça login para continuar.",
      });
    }

    // 1. Validar JWT com jose
    const payload = await verifyToken(token);
    if (!payload || !payload.sid || !payload.jti) {
      res.clearCookie(AUTH_COOKIE_NAME, getClearCookieOptions());
      return res.status(401).json({
        success: false,
        message: "Sessão inválida ou expirada.",
      });
    }

    // 2. Validar sessão server-side no banco e inatividade (10 min)
    const sessionData = await validateSession(payload.sid, payload.jti);
    if (!sessionData) {
      res.clearCookie(AUTH_COOKIE_NAME, getClearCookieOptions());
      return res.status(401).json({
        success: false,
        message: "Sessão expirada ou encerrada. Faça login novamente.",
      });
    }

    // 3. Anexar dados do usuário e sessão à requisição
    req.user = sessionData.user;
    req.session = sessionData.session;

    next();
  } catch (error) {
    res.clearCookie(AUTH_COOKIE_NAME, getClearCookieOptions());
    return res.status(401).json({
      success: false,
      message: "Falha na autenticação.",
    });
  }
}
