import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { getSupabase } from "../config/supabase.js";

const DEFAULT_IDLE_TIMEOUT_MINUTES = 10;
const DEFAULT_ABSOLUTE_TIMEOUT_HOURS = 8;
const ACTIVITY_UPDATE_THROTTLE_MS = 60 * 1000; // 1 minuto

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw Object.assign(
      new Error(
        "JWT_SECRET não configurado ou muito curto (mínimo 32 caracteres).",
      ),
      { statusCode: 500 },
    );
  }
  return new TextEncoder().encode(secret);
}

function getIdleTimeoutMs() {
  const minutes =
    Number.parseInt(process.env.SESSION_IDLE_TIMEOUT_MINUTES, 10) ||
    DEFAULT_IDLE_TIMEOUT_MINUTES;
  return minutes * 60 * 1000;
}

function getAbsoluteTimeoutHours() {
  return (
    Number.parseInt(process.env.SESSION_ABSOLUTE_TIMEOUT_HOURS, 10) ||
    DEFAULT_ABSOLUTE_TIMEOUT_HOURS
  );
}

function authError(message = "E-mail ou senha inválidos.", statusCode = 401) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Assina um JWT seguro com os claims mínimos necessários.
 */
export async function signSessionToken({ userId, sessionId, jti, role }) {
  const secret = getJwtSecret();
  const absoluteHours = getAbsoluteTimeoutHours();

  return await new SignJWT({
    sid: sessionId,
    jti,
    role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${absoluteHours}h`)
    .sign(secret);
}

/**
 * Valida a integridade criptográfica do JWT.
 */
export async function verifyToken(token) {
  try {
    const secret = getJwtSecret();
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });
    return payload;
  } catch {
    return null;
  }
}

/**
 * Autentica usuário com e-mail e senha.
 */
export async function login({ email, password }) {
  const supabase = getSupabase();
  const normalizedEmail = email.trim().toLowerCase();

  // 1. Buscar usuário ativo pelo e-mail
  const { data: user, error: userError } = await supabase
    .from("users")
    .select(
      "id, nome, email, password_hash, role, ativo, ultimo_login, data_criacao",
    )
    .eq("email", normalizedEmail)
    .maybeSingle();

  if (userError) {
    throw Object.assign(
      new Error("Erro ao consultar usuário para autenticação."),
      { statusCode: 502, cause: userError },
    );
  }

  // Prevenção contra enumeração: mesma resposta para usuário inexistente, inativo ou senha errada
  if (!user || !user.ativo) {
    throw authError();
  }

  // 2. Comparar senha com hash bcrypt
  const passwordMatch = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatch) {
    throw authError();
  }

  // 3. Criar sessão server-side na tabela user_sessions
  const jti = randomUUID();
  const absoluteHours = getAbsoluteTimeoutHours();
  const expiresAt = new Date(Date.now() + absoluteHours * 60 * 60 * 1000);

  const { data: session, error: sessionError } = await supabase
    .from("user_sessions")
    .insert({
      user_id: user.id,
      jti,
      last_activity_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(),
      revoked_at: null,
    })
    .select("id, user_id, jti, last_activity_at, expires_at")
    .single();

  if (sessionError) {
    throw Object.assign(new Error("Não foi possível registrar a sessão."), {
      statusCode: 502,
      cause: sessionError,
    });
  }

  // 4. Atualizar ultimo_login de forma assíncrona
  supabase
    .from("users")
    .update({ ultimo_login: new Date().toISOString() })
    .eq("id", user.id)
    .then(({ error }) => {
      if (error)
        console.error(
          "Aviso: falha ao atualizar ultimo_login:",
          error.message,
        );
    });

  // 5. Gerar JWT
  const token = await signSessionToken({
    userId: user.id,
    sessionId: session.id,
    jti: session.jti,
    role: user.role,
  });

  return {
    token,
    user: {
      id: user.id,
      nome: user.nome,
      email: user.email,
      role: user.role,
    },
  };
}

/**
 * Revoga a sessão server-side (logout).
 */
export async function logout(sessionId) {
  if (!sessionId) return;
  const supabase = getSupabase();

  await supabase
    .from("user_sessions")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", sessionId)
    .is("revoked_at", null);
}

/**
 * Valida a sessão no banco de dados e verifica timeouts de inatividade e absoluto.
 */
export async function validateSession(sessionId, jti) {
  const supabase = getSupabase();

  const { data: session, error: sessionError } = await supabase
    .from("user_sessions")
    .select("id, user_id, jti, last_activity_at, expires_at, revoked_at")
    .eq("id", sessionId)
    .maybeSingle();

  if (sessionError || !session) return null;

  // Se a sessão foi revogada ou JTI não confere
  if (session.revoked_at || session.jti !== jti) {
    return null;
  }

  const now = Date.now();
  const expiresAt = new Date(session.expires_at).getTime();
  const lastActivity = new Date(session.last_activity_at).getTime();
  const idleTimeoutMs = getIdleTimeoutMs();

  // Expiração absoluta (8h)
  if (now >= expiresAt) {
    await logout(session.id);
    return null;
  }

  // Timeout por inatividade (10 min)
  if (now - lastActivity > idleTimeoutMs) {
    await logout(session.id);
    return null;
  }

  // Buscar usuário ativo
  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id, nome, email, role, ativo")
    .eq("id", session.user_id)
    .maybeSingle();

  if (userError || !user || !user.ativo) {
    return null;
  }

  // Atualizar last_activity_at de forma throttled (a cada 1 minuto)
  if (now - lastActivity > ACTIVITY_UPDATE_THROTTLE_MS) {
    supabase
      .from("user_sessions")
      .update({ last_activity_at: new Date().toISOString() })
      .eq("id", session.id)
      .then(({ error }) => {
        if (error)
          console.error(
            "Aviso: falha ao atualizar last_activity_at:",
            error.message,
          );
      });
  }

  return {
    user: {
      id: user.id,
      nome: user.nome,
      email: user.email,
      role: user.role,
    },
    session: {
      id: session.id,
      last_activity_at: session.last_activity_at,
      expires_at: session.expires_at,
    },
  };
}

/**
 * Atualiza explicitamente a atividade do usuário.
 */
export async function touchActivity(sessionId) {
  if (!sessionId) return;
  const supabase = getSupabase();

  await supabase
    .from("user_sessions")
    .update({ last_activity_at: new Date().toISOString() })
    .eq("id", sessionId)
    .is("revoked_at", null);
}
