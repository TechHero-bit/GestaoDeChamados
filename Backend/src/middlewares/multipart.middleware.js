/**
 * Parser mínimo para multipart/form-data usado pela assinatura.
 * Mantém o upload no backend e não persiste o conteúdo binário em disco.
 */
export function parseMultipart(req, res, next) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);

  if (!boundaryMatch) {
    return res.status(400).json({
      success: false,
      message: "Envie a assinatura como multipart/form-data.",
    });
  }

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const delimiter = Buffer.from(`--${boundary}`);
  const chunks = [];

  req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  req.on("error", next);
  req.on("end", () => {
    try {
      const body = Buffer.concat(chunks);
      const file = findMultipartFile(body, delimiter, "signature");

      if (!file) {
        return res.status(400).json({
          success: false,
          message: "O campo signature é obrigatório.",
        });
      }

      req.file = file;
      return next();
    } catch (error) {
      return next(
        Object.assign(new Error("Não foi possível ler o upload da assinatura."), {
          statusCode: 400,
          cause: error,
        }),
      );
    }
  });
}

function findMultipartFile(body, delimiter, expectedField) {
  let cursor = 0;

  while (cursor < body.length) {
    const partStart = body.indexOf(delimiter, cursor);
    if (partStart < 0) break;

    let headersStart = partStart + delimiter.length;
    if (body[headersStart] === 45 && body[headersStart + 1] === 45) break;
    if (body[headersStart] === 13 && body[headersStart + 1] === 10) headersStart += 2;

    const headersEnd = body.indexOf(Buffer.from("\r\n\r\n"), headersStart);
    if (headersEnd < 0) break;

    const nextPart = body.indexOf(delimiter, headersEnd + 4);
    if (nextPart < 0) break;

    const headers = body.toString("latin1", headersStart, headersEnd);
    const disposition = headers.match(/content-disposition:\s*form-data;([^\r\n]*)/i);
    const name = disposition?.[1]?.match(/(?:^|;)\s*name="([^"]+)"/i)?.[1];
    const filename = disposition?.[1]?.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1];

    if (name === expectedField && filename !== undefined) {
      const contentType = headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || "";
      let fileEnd = nextPart;
      if (body[fileEnd - 2] === 13 && body[fileEnd - 1] === 10) fileEnd -= 2;

      return {
        fieldname: name,
        originalname: filename,
        encoding: "7bit",
        mimetype: contentType,
        buffer: body.subarray(headersEnd + 4, fileEnd),
        size: fileEnd - (headersEnd + 4),
      };
    }

    cursor = nextPart + delimiter.length;
  }

  return null;
}
