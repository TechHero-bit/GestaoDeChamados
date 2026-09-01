export const MICROSOFT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Mail.Send",
];

function missingMicrosoftVariables() {
  return [
    "MICROSOFT_CLIENT_ID",
    "MICROSOFT_TENANT_ID",
    "MICROSOFT_CLIENT_SECRET",
    "MICROSOFT_REDIRECT_URI",
    "MICROSOFT_TOKEN_ENCRYPTION_KEY",
  ].filter((name) => !process.env[name]?.trim());
}

export function getMicrosoftConfig() {
  const missing = missingMicrosoftVariables();
  if (missing.length > 0) {
    throw Object.assign(
      new Error("Integração Microsoft não configurada no servidor."),
      { statusCode: 503 },
    );
  }

  const tenant = encodeURIComponent(process.env.MICROSOFT_TENANT_ID.trim());
  return {
    clientId: process.env.MICROSOFT_CLIENT_ID.trim(),
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET.trim(),
    redirectUri: process.env.MICROSOFT_REDIRECT_URI.trim(),
    authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    graphMeUrl: "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName",
  };
}

export function getFrontendUrl() {
  const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:4200")
    .split(",")[0]
    .trim();

  try {
    const url = new URL(frontendUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    return url.toString().replace(/\/$/, "");
  } catch {
    throw Object.assign(new Error("FRONTEND_URL inválida."), { statusCode: 500 });
  }
}

export function getMicrosoftAuthorizationUrl(state) {
  const config = getMicrosoftConfig();
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", MICROSOFT_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}
