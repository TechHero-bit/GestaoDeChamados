import { createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";

const HANDLE_AUDIENCE = "ticket-reply-draft";

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) {
    throw Object.assign(new Error("JWT_SECRET não configurado ou muito curto."), { statusCode: 500 });
  }
  return new TextEncoder().encode(value);
}

export function replyDraftDigest(message, attachments) {
  const manifest = attachments.map(({ name, size, contentType }) => ({ name, size, contentType }));
  return createHash("sha256")
    .update(JSON.stringify({ message, attachments: manifest }), "utf8")
    .digest("base64url");
}

export async function signReplyDraftHandle({
  userId,
  ticketId,
  draftId,
  digest,
  signatureExpected,
  smallUploadIndexes = [],
}) {
  const confirmedSmallUploads = [...new Set(smallUploadIndexes)]
    .filter((index) => Number.isInteger(index) && index >= 0 && index <= 19)
    .sort((left, right) => left - right);
  return new SignJWT({
    ticketId,
    draftId,
    digest,
    signatureExpected: signatureExpected === true,
    smallUploadIndexes: confirmedSmallUploads,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setAudience(HANDLE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(secret());
}

export async function verifyReplyDraftHandle(handle, { userId, ticketId }) {
  try {
    const { payload } = await jwtVerify(handle, secret(), {
      algorithms: ["HS256"], audience: HANDLE_AUDIENCE, subject: userId,
    });
    if (payload.ticketId !== ticketId || typeof payload.draftId !== "string" || typeof payload.digest !== "string") {
      throw new Error("invalid claims");
    }
    return payload;
  } catch {
    throw Object.assign(new Error("O rascunho é inválido ou expirou."), {
      statusCode: 403, publicCode: "REPLY_DRAFT_INVALID",
    });
  }
}
