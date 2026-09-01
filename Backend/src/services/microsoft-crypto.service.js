import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const VERSION = "v1";

function getKey() {
  const configuredKey = process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY?.trim();
  if (!configuredKey) {
    throw Object.assign(
      new Error("MICROSOFT_TOKEN_ENCRYPTION_KEY não configurada."),
      { statusCode: 503 },
    );
  }

  // Derivar sempre 32 bytes permite usar uma chave secreta de configuração
  // sem armazenar uma representação diferente no código ou no banco.
  return createHash("sha256").update(configuredKey, "utf8").digest();
}

function encode(value) {
  return value.toString("base64url");
}

function decode(value) {
  return Buffer.from(value, "base64url");
}

export function encryptMicrosoftToken(token) {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Token Microsoft inválido para criptografia.");
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [VERSION, encode(iv), encode(authTag), encode(ciphertext)].join(".");
}

export function decryptMicrosoftToken(payload) {
  if (typeof payload !== "string") {
    throw new Error("Token Microsoft criptografado inválido.");
  }

  const [version, encodedIv, encodedAuthTag, encodedCiphertext] = payload.split(".");
  if (version !== VERSION || !encodedIv || !encodedAuthTag || !encodedCiphertext) {
    throw new Error("Token Microsoft criptografado inválido.");
  }

  const key = getKey();
  try {
    const decipher = createDecipheriv(ALGORITHM, key, decode(encodedIv));
    decipher.setAuthTag(decode(encodedAuthTag));
    return Buffer.concat([
      decipher.update(decode(encodedCiphertext)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Não foi possível descriptografar o token Microsoft.");
  }
}
