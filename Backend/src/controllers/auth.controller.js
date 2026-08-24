import {
  AUTH_COOKIE_NAME,
  getAuthCookieOptions,
  getClearCookieOptions,
} from "../config/auth-cookie.js";
import { loginSchema } from "../schemas/auth.schema.js";
import * as authService from "../services/auth.service.js";

/**
 * POST /api/auth/login
 * Autentica usuário e cria cookie HttpOnly com JWT
 */
export async function login(req, res, next) {
  try {
    const parseResult = loginSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        success: false,
        message: "E-mail e senha são obrigatórios.",
        errors: parseResult.error.errors.map((e) => ({
          campo: e.path.join("."),
          mensagem: e.message,
        })),
      });
    }

    const { email, password } = parseResult.data;
    const { token, user } = await authService.login({ email, password });

    // Configurar cookie seguro HttpOnly
    res.cookie(AUTH_COOKIE_NAME, token, getAuthCookieOptions());

    return res.json({
      success: true,
      message: "Autenticação realizada com sucesso.",
      user,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/auth/logout
 * Revoga a sessão server-side e remove o cookie
 */
export async function logout(req, res, next) {
  try {
    const token =
      req.cookies?.[AUTH_COOKIE_NAME] ||
      (req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7).trim()
        : null);

    if (token) {
      const payload = await authService.verifyToken(token);
      if (payload?.sid) {
        await authService.logout(payload.sid);
      }
    }

    res.clearCookie(AUTH_COOKIE_NAME, getClearCookieOptions());

    return res.json({
      success: true,
      message: "Sessão encerrada com sucesso.",
    });
  } catch (error) {
    res.clearCookie(AUTH_COOKIE_NAME, getClearCookieOptions());
    next(error);
  }
}

/**
 * GET /api/auth/me
 * Retorna os dados do usuário autenticado
 */
export async function me(req, res) {
  return res.json({
    success: true,
    user: req.user,
  });
}

/**
 * POST /api/auth/activity
 * Notificação leve de atividade do usuário
 */
export async function activity(req, res, next) {
  try {
    if (req.session?.id) {
      await authService.touchActivity(req.session.id);
    }

    return res.json({
      success: true,
    });
  } catch (error) {
    next(error);
  }
}
