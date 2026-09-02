import { createHash, randomBytes } from "node:crypto";
import { getMicrosoftConfig, MICROSOFT_SCOPES } from "../config/microsoft.js";
import { getSupabase } from "../config/supabase.js";
import {
  decryptMicrosoftToken,
  encryptMicrosoftToken,
} from "./microsoft-crypto.service.js";

const STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_SKEW_MS = 60 * 1000;

function hashState(state) {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function serviceError(message, statusCode = 502, cause) {
  return Object.assign(new Error(message), { statusCode, cause });
}

function microsoftTokenError(message, statusCode, userId, stage, connection, cause) {
  return Object.assign(new Error(message), {
    statusCode,
    microsoftAuthError: true,
    microsoftAuthLog: {
      stage,
      status: statusCode,
      connection,
      code: cause?.code || cause?.name || null,
      userId,
    },
  });
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function requestToken(body, { fetchImpl = globalThis.fetch } = {}) {
  const config = getMicrosoftConfig();
  const response = await fetchImpl(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      ...body,
    }),
  });
  const data = await readJson(response);

  if (!response.ok || !data.access_token) {
    throw serviceError("Não foi possível concluir a autorização Microsoft.");
  }

  return data;
}

export async function createMicrosoftOAuthState(userId, { supabase = getSupabase(), now = new Date() } = {}) {
  const state = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + STATE_TTL_MS);
  const { error } = await supabase.from("microsoft_oauth_states").insert({
    user_id: userId,
    state_hash: hashState(state),
    expires_at: expiresAt.toISOString(),
  });

  if (error) {
    throw serviceError("Não foi possível iniciar a conexão Microsoft.", 502, error);
  }

  return state;
}

export async function consumeMicrosoftOAuthState(
  state,
  { supabase = getSupabase(), now = new Date() } = {},
) {
  if (typeof state !== "string" || state.length < 32 || state.length > 256) {
    return null;
  }

  const { data, error } = await supabase
    .from("microsoft_oauth_states")
    .update({ used_at: now.toISOString() })
    .eq("state_hash", hashState(state))
    .is("used_at", null)
    .gt("expires_at", now.toISOString())
    .select("user_id, expires_at")
    .maybeSingle();

  if (error) {
    throw serviceError("Não foi possível validar a autorização Microsoft.", 502, error);
  }
  return data;
}

export async function exchangeMicrosoftAuthorizationCode(code, { fetchImpl } = {}) {
  if (typeof code !== "string" || code.length === 0) {
    throw serviceError("Código de autorização Microsoft ausente.", 400);
  }

  const data = await requestToken(
    { code, grant_type: "authorization_code" },
    { fetchImpl },
  );
  if (!data.refresh_token) {
    throw serviceError("A autorização Microsoft não retornou refresh token.");
  }
  return data;
}

export async function getMicrosoftProfile(accessToken, { fetchImpl = globalThis.fetch } = {}) {
  const config = getMicrosoftConfig();
  const response = await fetchImpl(config.graphMeUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await readJson(response);

  if (!response.ok || !data.id) {
    throw serviceError("Não foi possível obter o perfil Microsoft.");
  }

  const email = data.mail || data.userPrincipalName;
  if (!email) {
    throw serviceError("A conta Microsoft não possui e-mail utilizável.", 400);
  }

  return {
    microsoftUserId: data.id,
    email,
    displayName: data.displayName || email,
  };
}

export async function saveMicrosoftConnection(
  userId,
  { tokens, profile, scopes = MICROSOFT_SCOPES, supabase = getSupabase() },
) {
  const expiresInSeconds = Number.parseInt(tokens.expires_in, 10);
  const expiresAt = new Date(
    Date.now() + (Number.isFinite(expiresInSeconds) ? expiresInSeconds : 3600) * 1000,
  );

  const { data, error } = await supabase
    .from("user_microsoft_connections")
    .upsert(
      {
        user_id: userId,
        microsoft_user_id: profile.microsoftUserId,
        email: profile.email,
        display_name: profile.displayName,
        access_token_encrypted: encryptMicrosoftToken(tokens.access_token),
        refresh_token_encrypted: encryptMicrosoftToken(tokens.refresh_token),
        access_token_expires_at: expiresAt.toISOString(),
        scopes,
        connected_at: new Date().toISOString(),
        revoked_at: null,
      },
      { onConflict: "user_id" },
    )
    .select("id, user_id, microsoft_user_id, email, display_name, connected_at, updated_at")
    .single();

  if (error) {
    throw serviceError("Não foi possível salvar a conexão Microsoft.", 502, error);
  }
  return data;
}

export async function completeMicrosoftConnection(
  { state, code, supabase = getSupabase(), fetchImpl, now = new Date() },
) {
  const stateData = await consumeMicrosoftOAuthState(state, { supabase, now });
  if (!stateData) {
    throw serviceError("State OAuth inválido ou expirado.", 400);
  }

  const tokens = await exchangeMicrosoftAuthorizationCode(code, { fetchImpl });
  const profile = await getMicrosoftProfile(tokens.access_token, { fetchImpl });
  const connection = await saveMicrosoftConnection(stateData.user_id, {
    tokens,
    profile,
    scopes: tokens.scope ? tokens.scope.split(" ").filter(Boolean) : MICROSOFT_SCOPES,
    supabase,
  });

  return { userId: stateData.user_id, connection };
}

export async function getMicrosoftConnectionStatus(userId, { supabase = getSupabase() } = {}) {
  const { data, error } = await supabase
    .from("user_microsoft_connections")
    .select("email, display_name, connected_at")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();

  if (error) {
    throw microsoftTokenError(
      "Não foi possível consultar a conexão Microsoft.",
      502,
      userId,
      "connection.status",
      "query_failed",
      error,
    );
  }
  return data
    ? {
        connected: true,
        email: data.email,
        display_name: data.display_name,
        connected_at: data.connected_at,
      }
    : { connected: false };
}

export async function disconnectMicrosoftConnection(userId, { supabase = getSupabase(), now = new Date() } = {}) {
  const { error } = await supabase
    .from("user_microsoft_connections")
    .update({ revoked_at: now.toISOString() })
    .eq("user_id", userId)
    .is("revoked_at", null);

  if (error) {
    throw serviceError("Não foi possível desconectar a conta Microsoft.", 502, error);
  }
}

export async function getValidMicrosoftAccessToken(
  userId,
  { supabase = getSupabase(), fetchImpl = globalThis.fetch, now = new Date() } = {},
) {
  const { data, error } = await supabase
    .from("user_microsoft_connections")
    .select("access_token_encrypted, refresh_token_encrypted, access_token_expires_at")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .maybeSingle();

  if (error) {
    throw microsoftTokenError(
      "Não foi possível consultar a conexão Microsoft.",
      502,
      userId,
      "connection.lookup",
      "query_failed",
      error,
    );
  }

  if (!data) {
    const { data: existingConnection, error: stateError } = await supabase
      .from("user_microsoft_connections")
      .select("revoked_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (stateError) {
      throw microsoftTokenError(
        "Não foi possível consultar a conexão Microsoft.",
        502,
        userId,
        "connection.lookup",
        "query_failed",
        stateError,
      );
    }

    const connectionState = existingConnection ? "revoked" : "not_found";
    throw microsoftTokenError(
      "Conta Microsoft não conectada.",
      404,
      userId,
      "connection.lookup",
      connectionState,
    );
  }

  const expiresAt = new Date(data.access_token_expires_at).getTime();
  if (Number.isFinite(expiresAt) && expiresAt - now.getTime() > TOKEN_SKEW_MS) {
    try {
      return decryptMicrosoftToken(data.access_token_encrypted);
    } catch (cause) {
      throw microsoftTokenError(
        cause.message,
        cause.statusCode || 502,
        userId,
        "token.decrypt",
        "present",
        cause,
      );
    }
  }

  let refreshToken;
  try {
    refreshToken = decryptMicrosoftToken(data.refresh_token_encrypted);
  } catch (cause) {
    throw microsoftTokenError(
      cause.message,
      cause.statusCode || 502,
      userId,
      "token.decrypt",
      "present",
      cause,
    );
  }

  let refreshed;
  try {
    refreshed = await requestToken(
      { refresh_token: refreshToken, grant_type: "refresh_token" },
      { fetchImpl },
    );
  } catch (cause) {
    throw microsoftTokenError(
      cause.message,
      cause.statusCode || 502,
      userId,
      "token.refresh",
      "present",
      cause,
    );
  }
  const refreshedExpiresIn = Number.parseInt(refreshed.expires_in, 10);
  const newExpiresAt = new Date(
    now.getTime() + (Number.isFinite(refreshedExpiresIn) ? refreshedExpiresIn : 3600) * 1000,
  );
  const update = {
    access_token_encrypted: encryptMicrosoftToken(refreshed.access_token),
    access_token_expires_at: newExpiresAt.toISOString(),
  };
  if (refreshed.refresh_token) {
    update.refresh_token_encrypted = encryptMicrosoftToken(refreshed.refresh_token);
  }

  const { error: updateError } = await supabase
    .from("user_microsoft_connections")
    .update(update)
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (updateError) {
    throw microsoftTokenError(
      "Não foi possível atualizar a conexão Microsoft.",
      502,
      userId,
      "token.persist",
      "present",
      updateError,
    );
  }

  return refreshed.access_token;
}
