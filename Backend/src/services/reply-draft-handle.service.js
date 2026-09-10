import { createHash, createHmac } from "node:crypto";
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

export function replyDraftAttachmentIdDigest(attachmentId) {
  return createHmac("sha256", secret())
    .update("ticket-reply-small-attachment-id\0", "utf8")
    .update(String(attachmentId), "utf8")
    .digest("base64url");
}

export async function signReplyDraftHandle({
  userId,
  ticketId,
  draftId,
  digest,
  signatureExpected,
  smallUploadReceipts = [],
}) {
  const confirmedSmallUploads = [...new Map(
    smallUploadReceipts
      .filter((receipt) =>
        Number.isInteger(receipt?.index)
          && receipt.index >= 0
          && receipt.index <= 19
          && typeof receipt.attachmentIdDigest === "string"
          && /^[A-Za-z0-9_-]{43}$/.test(receipt.attachmentIdDigest)
          && Number.isSafeInteger(receipt.expectedSize)
          && receipt.expectedSize > 0
          && Number.isSafeInteger(receipt.parsedBufferSize)
          && receipt.parsedBufferSize > 0
          && typeof receipt.base64RoundtripValid === "boolean"
          && typeof receipt.graphCreateConfirmed === "boolean")
      .map((receipt) => [receipt.index, {
        index: receipt.index,
        attachmentIdDigest: receipt.attachmentIdDigest,
        expectedSize: receipt.expectedSize,
        parsedBufferSize: receipt.parsedBufferSize,
        base64RoundtripValid: receipt.base64RoundtripValid,
        graphCreateConfirmed: receipt.graphCreateConfirmed,
      }]),
  ).values()].sort((left, right) => left.index - right.index);
  return new SignJWT({
    ticketId,
    draftId,
    digest,
    signatureExpected: signatureExpected === true,
    smallUploadReceipts: confirmedSmallUploads,
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
