export const GRAPH_CHUNK_SIZE = 10 * 320 * 1024;
export const SMALL_ATTACHMENT_FORM_FILE_FIELD = 'attachment';
export const SMALL_ATTACHMENT_LIMIT_BYTES = 3 * 1024 * 1024;
const MAX_CHUNK_ATTEMPTS = 3;
const CHUNK_TIMEOUT_MS = 30_000;

export type ReplyAttachmentStrategy = 'small' | 'large';

export function replyAttachmentStrategy(size: number): ReplyAttachmentStrategy {
  return size < SMALL_ATTACHMENT_LIMIT_BYTES ? 'small' : 'large';
}

export function createSmallAttachmentFormData(
  handle: string,
  index: number,
  message: string,
  attachments: unknown[],
  file: Blob,
  fileName: string,
): FormData {
  const form = new FormData();
  form.append('handle', handle);
  form.append('index', String(index));
  form.append('mensagem', message);
  form.append('attachments', JSON.stringify(attachments));
  form.append(SMALL_ATTACHMENT_FORM_FILE_FIELD, file, fileName);
  return form;
}

export function nextExpectedOffset(ranges: unknown, fallback: number): number {
  if (!Array.isArray(ranges)) return fallback;
  for (const range of ranges) {
    const match = typeof range === 'string' ? /^(\d+)-/.exec(range) : null;
    if (match) return Number(match[1]);
  }
  return fallback;
}

export async function uploadFileToMicrosoft(
  uploadUrl: string,
  file: Blob,
  initialRanges: string[],
  signal: AbortSignal,
  onProgress: (uploaded: number) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let offset = nextExpectedOffset(initialRanges, 0);
  while (offset < file.size) {
    signal.throwIfAborted();
    const endExclusive = Math.min(offset + GRAPH_CHUNK_SIZE, file.size);
    const chunk = file.slice(offset, endExclusive);
    let response: Response | null = null;

    for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt += 1) {
      const timeoutController = new AbortController();
      const timeoutId = globalThis.setTimeout(() => timeoutController.abort(), CHUNK_TIMEOUT_MS);
      const abortChunk = () => timeoutController.abort(signal.reason);
      signal.addEventListener('abort', abortChunk, { once: true });
      try {
        response = await fetchImpl(uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Range': `bytes ${offset}-${endExclusive - 1}/${file.size}`,
            'Content-Type': 'application/octet-stream',
          },
          body: chunk,
          signal: timeoutController.signal,
        });
      } catch (error) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (attempt === MAX_CHUNK_ATTEMPTS) {
          if (error instanceof TypeError) {
            throw new Error('O upload direto para o Microsoft Outlook foi bloqueado.');
          }
          throw new Error('O upload direto para o Microsoft Outlook excedeu o tempo limite.');
        }
        await delay(500 * 2 ** (attempt - 1), signal);
        continue;
      } finally {
        globalThis.clearTimeout(timeoutId);
        signal.removeEventListener('abort', abortChunk);
      }

      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        if (attempt === MAX_CHUNK_ATTEMPTS) break;
        await delay(retryDelayMs(response, attempt), signal);
        continue;
      }
      break;
    }

    if (!response || ![200, 201, 202].includes(response.status)) {
      throw new Error(
        response?.status === 413
          ? 'O Outlook recusou o arquivo por causa do limite da caixa postal.'
          : 'A Microsoft não conseguiu receber uma parte do anexo.',
      );
    }
    const payload = await response.json().catch(() => ({}));
    const next = nextExpectedOffset(payload.nextExpectedRanges, endExclusive);
    if (next < 0 || next > file.size || (next === offset && response.status === 202)) {
      throw new Error('A Microsoft retornou uma posição inválida para continuar o upload.');
    }
    offset = next;
    onProgress(offset);
  }
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(date - Date.now(), 0);
  }
  return 500 * 2 ** (attempt - 1);
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        globalThis.clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}
