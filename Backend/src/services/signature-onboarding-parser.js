export const ONBOARDING_SUBJECT = "Centauro/Interno: Chamado - Onboarding de TI";

function normalizeComparable(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function isOnboardingSubject(subject) {
  return normalizeComparable(subject) === normalizeComparable(ONBOARDING_SUBJECT);
}

const HTML_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
]);

export function htmlToReadableText(value) {
  return String(value || "")
    .replace(/<\s*(br|\/p|\/div|\/tr|\/li)\b[^>]*>/gi, "\n")
    .replace(/<\s*(p|div|tr|li)\b[^>]*>/gi, "\n")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity) => {
      if (entity[0] === "#") {
        const hexadecimal = entity[1]?.toLowerCase() === "x";
        const code = Number.parseInt(
          entity.slice(hexadecimal ? 2 : 1),
          hexadecimal ? 16 : 10,
        );
        return Number.isFinite(code) ? String.fromCodePoint(code) : " ";
      }
      return HTML_ENTITIES.get(entity.toLowerCase()) || " ";
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractLabeledValue(text, labels) {
  const escaped = labels.map((label) =>
    label.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&"),
  );
  const pattern = new RegExp(
    `(?:^|\\n)\\s*(?:${escaped.join("|")})\\s*[:\\-–]?\\s*([^\\n|;]+)`,
    "imu",
  );
  const match = text.match(pattern);
  return match?.[1]?.replace(/\s+/g, " ").trim() || null;
}

export function extractOnboardingFields(content) {
  const text = htmlToReadableText(content);
  const employeeName = extractLabeledValue(text, [
    "nome do colaborador",
    "nome completo",
    "colaborador",
    "nome",
  ]);
  const jobTitle = extractLabeledValue(text, ["função", "funcao", "cargo"]);
  const rawPhone = extractLabeledValue(text, [
    "telefone do colaborador",
    "telefone",
    "celular",
    "ramal",
  ]);
  const phoneMatch = rawPhone?.match(
    /(?:\+?55\s*)?(?:\(?\d{2}\)?[\s.-]*)?\d{4,5}[\s.-]*\d{4}/,
  );
  const phone = phoneMatch?.[0]?.replace(/\s+/g, " ").trim() || rawPhone;
  return { employeeName, jobTitle, phone, text };
}

export function corporateEmailForName(name) {
  const tokens = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length < 2) return null;

  const localTokens = [tokens[0]];
  if (tokens.length > 2 && normalizeComparable(tokens.at(-2)) === "de") {
    localTokens.push(tokens.at(-2));
  }
  localTokens.push(tokens.at(-1));

  const localPart = localTokens
    .join("")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return localPart ? `${localPart}@centaurotelecom.com.br` : null;
}

function contentIdIndex(html, contentId) {
  if (!contentId) return -1;
  const normalizedCid = contentId.replace(/^<|>$/g, "");
  return String(html || "")
    .toLowerCase()
    .indexOf(`cid:${normalizedCid.toLowerCase()}`);
}

export function classifyImageCandidates(attachments, html) {
  const normalizedHtml = String(html || "").toLowerCase();
  const signatureMarkers = [
    "atenciosamente",
    "cordialmente",
    "att.",
    "linkedin.com",
  ];
  const signatureStart = signatureMarkers
    .map((marker) => normalizedHtml.indexOf(marker))
    .filter((index) => index >= 0)
    .reduce(
      (minimum, index) => Math.min(minimum, index),
      Number.POSITIVE_INFINITY,
    );

  return (attachments || [])
    .map((attachment, positionIndex) => ({ attachment, positionIndex }))
    .filter(({ attachment }) =>
      ["image/png", "image/jpeg", "image/webp"].includes(
        String(attachment.content_type || "").toLowerCase(),
      ),
    )
    .map(({ attachment, positionIndex }) => {
      const reasons = [];
      const fileName = normalizeComparable(attachment.file_name);
      const size = Number(attachment.file_size || 0);
      let score = 20;

      if (/foto|photo|perfil|profile|colaborador|funcionario/.test(fileName)) {
        score += 55;
        reasons.push("nome do arquivo sugere fotografia");
      }
      if (
        /logo|assinatura|signature|icone|icon|banner|facebook|instagram|linkedin|whatsapp/.test(
          fileName,
        )
      ) {
        score -= 85;
        reasons.push(
          "nome do arquivo sugere elemento da assinatura do remetente",
        );
      }
      if (attachment.is_inline) {
        score -= 30;
        reasons.push("imagem inline no HTML");
      } else {
        score += 25;
        reasons.push("imagem anexada separadamente");
      }
      if (size > 80_000) {
        score += 15;
        reasons.push("tamanho compatível com fotografia");
      } else if (size > 0 && size < 35_000) {
        score -= 20;
        reasons.push("arquivo pequeno, comum em ícones e logotipos");
      }

      const cidIndex = contentIdIndex(html, attachment.content_id);
      if (
        cidIndex >= 0 &&
        Number.isFinite(signatureStart) &&
        cidIndex >= signatureStart
      ) {
        score -= 60;
        reasons.push(
          "Content-ID aparece após o início da assinatura do remetente",
        );
      }

      const confidence = Math.max(0, Math.min(1, (score + 100) / 200));
      const classification =
        score >= 70
          ? "provavel_foto"
          : score <= 0
            ? "assinatura_remetente"
            : "incerta";
      return {
        attachment_id: attachment.id,
        file_name: attachment.file_name,
        content_type: attachment.content_type,
        file_size: size,
        is_inline: attachment.is_inline === true,
        content_id: attachment.content_id || null,
        position_index: positionIndex,
        score,
        confidence,
        classification,
        reasons,
      };
    })
    .sort(
      (a, b) => b.score - a.score || a.position_index - b.position_index,
    );
}

export function choosePhotoCandidate(candidates) {
  const first = candidates[0];
  const second = candidates[1];
  const unambiguous =
    first &&
    first.classification === "provavel_foto" &&
    first.confidence >= 0.8 &&
    (!second || first.score - second.score >= 35);
  return unambiguous ? first : null;
}
