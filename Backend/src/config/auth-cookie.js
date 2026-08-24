export const AUTH_COOKIE_NAME =
  process.env.JWT_COOKIE_NAME || "helpdesk_session";

export function getAuthCookieOptions() {
  const isProduction = process.env.NODE_ENV === "production";
  const sameSite =
    process.env.COOKIE_SAME_SITE || (isProduction ? "none" : "lax");

  return {
    httpOnly: true,
    secure: isProduction,
    sameSite,
    path: "/",
    maxAge: 8 * 60 * 60 * 1000, // 8 horas
  };
}

export function getClearCookieOptions() {
  const isProduction = process.env.NODE_ENV === "production";
  const sameSite =
    process.env.COOKIE_SAME_SITE || (isProduction ? "none" : "lax");

  return {
    httpOnly: true,
    secure: isProduction,
    sameSite,
    path: "/",
  };
}
