/**
 * Middleware para autorização baseada em papéis (RBAC).
 * Exemplo: requireRole('ADMIN')
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Não autenticado.",
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Acesso não autorizado para o seu perfil de usuário.",
      });
    }

    next();
  };
}
