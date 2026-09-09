import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  createSmallAttachmentFormData,
  GRAPH_CHUNK_SIZE,
  nextExpectedOffset,
  replyAttachmentStrategy,
  SMALL_ATTACHMENT_FORM_FILE_FIELD,
  uploadFileToMicrosoft,
} from '../src/app/core/utils/microsoft-graph-upload.ts';
import {
  markUnfinishedAttachments,
  updateAttachmentProgress,
} from '../src/app/core/utils/reply-attachment-state.ts';

function virtualBlob(size: number): Blob {
  return {
    size,
    slice(start = 0, end = size) {
      return { size: end - start } as Blob;
    },
  } as Blob;
}

test('chunk tem 3.276.800 bytes, múltiplo de 320 KiB e abaixo de 4 MB', () => {
  assert.equal(GRAPH_CHUNK_SIZE, 3_276_800);
  assert.equal(GRAPH_CHUNK_SIZE % (320 * 1024), 0);
  assert.equal(GRAPH_CHUNK_SIZE < 4 * 1024 * 1024, true);
});

test('PNG de 100 KB e PDF de 1 MB usam fluxo small; arquivo de 5 MB usa upload session', () => {
  assert.equal(replyAttachmentStrategy(100 * 1024), 'small');
  assert.equal(replyAttachmentStrategy(1024 * 1024), 'small');
  assert.equal(replyAttachmentStrategy(5 * 1024 * 1024), 'large');
});

test('arquivo pequeno é enviado em FormData no campo esperado e o browser cria o boundary', () => {
  const file = new Blob([new Uint8Array(100 * 1024)], { type: 'image/png' });
  const attachments = [{ name: 'print.png', size: file.size, contentType: file.type }];
  const form = createSmallAttachmentFormData(
    'safe-handle',
    0,
    'Resposta',
    attachments,
    file,
    'print.png',
  );

  assert.equal(SMALL_ATTACHMENT_FORM_FILE_FIELD, 'attachment');
  assert.equal(form.get('handle'), 'safe-handle');
  assert.equal(form.get('index'), '0');
  assert.equal(form.get('mensagem'), 'Resposta');
  assert.equal(form.get('attachments'), JSON.stringify(attachments));
  assert.equal((form.get('attachment') as Blob).size, 100 * 1024);
  assert.equal(form.get('file'), null);

  const request = new Request('http://localhost/upload', { method: 'POST', body: form });
  assert.match(request.headers.get('content-type') || '', /^multipart\/form-data; boundary=/i);
});

test('interceptor de autenticação não força JSON sobre FormData', () => {
  const source = readFileSync(
    new URL('../src/app/core/interceptors/auth.interceptor.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /setHeaders\s*:\s*\{[^}]*Content-Type/is);
  assert.doesNotMatch(source, /headers\.set\(\s*['"]Content-Type['"]/i);
});

test('falha troca todo anexo não concluído para erro e não mantém upload em 0%', () => {
  const file = { size: 100 * 1024 } as File;
  const uploading = updateAttachmentProgress(
    [{ file, uploaded: 0, progress: 0, state: 'pending' }],
    0,
    0,
    'uploading',
  );
  const failed = markUnfinishedAttachments(uploading, false);
  assert.equal(failed[0].state, 'error');
  assert.equal(
    failed.some((item) => item.state === 'uploading'),
    false,
  );
});

test('arquivo de 10 MB é dividido em chunks sequenciais com Content-Range correto', async () => {
  const total = 10 * 1024 * 1024;
  const requests: Array<{ range: string | null; size: number; authorization: string | null }> = [];
  await uploadFileToMicrosoft(
    'https://upload.example/secret',
    virtualBlob(total),
    ['0-'],
    new AbortController().signal,
    () => {},
    async (_url, options) => {
      const headers = new Headers(options?.headers);
      const body = options?.body as Blob;
      requests.push({
        range: headers.get('Content-Range'),
        size: body.size,
        authorization: headers.get('Authorization'),
      });
      const uploaded = requests.reduce((sum, request) => sum + request.size, 0);
      return new Response(
        JSON.stringify(uploaded < total ? { nextExpectedRanges: [`${uploaded}-`] } : {}),
        {
          status: uploaded < total ? 202 : 201,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  assert.equal(requests.length, 4);
  assert.equal(requests[0].range, `bytes 0-${GRAPH_CHUNK_SIZE - 1}/${total}`);
  assert.equal(requests.at(-1)?.range, `bytes ${GRAPH_CHUNK_SIZE * 3}-${total - 1}/${total}`);
  assert.equal(
    requests.every((request) => request.authorization === null),
    true,
  );
});

test('arquivo virtual de 100 MB nunca é enviado inteiro nem passa pela Vercel', async () => {
  const total = 100 * 1024 * 1024;
  let offset = 0;
  let largestBody = 0;
  let target = '';
  await uploadFileToMicrosoft(
    'https://upload.example/capability',
    virtualBlob(total),
    ['0-'],
    new AbortController().signal,
    () => {},
    async (url, options) => {
      target = String(url);
      const size = (options?.body as Blob).size;
      largestBody = Math.max(largestBody, size);
      offset += size;
      return new Response(
        JSON.stringify(offset < total ? { nextExpectedRanges: [`${offset}-`] } : {}),
        {
          status: offset < total ? 202 : 201,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  );
  assert.equal(target, 'https://upload.example/capability');
  assert.equal(largestBody <= GRAPH_CHUNK_SIZE, true);
  assert.equal(largestBody < total, true);
});

test('nextExpectedRanges retornado pela Microsoft define o próximo offset', async () => {
  const total = 10 * 1024 * 1024;
  const ranges: string[] = [];
  let call = 0;
  await uploadFileToMicrosoft(
    'https://upload.example/session',
    virtualBlob(total),
    ['327680-'],
    new AbortController().signal,
    () => {},
    async (_url, options) => {
      ranges.push(new Headers(options?.headers).get('Content-Range') || '');
      call += 1;
      return new Response(JSON.stringify(call === 1 ? { nextExpectedRanges: ['6553600-'] } : {}), {
        status: call === 1 ? 202 : 201,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );
  assert.equal(ranges[0].startsWith('bytes 327680-'), true);
  assert.equal(ranges[1].startsWith('bytes 6553600-'), true);
  assert.equal(nextExpectedOffset(['12345-'], 0), 12345);
});

test('429 respeita Retry-After e tenta no máximo três vezes', async () => {
  let calls = 0;
  await uploadFileToMicrosoft(
    'https://upload.example/session',
    virtualBlob(1024),
    ['0-'],
    new AbortController().signal,
    () => {},
    async () => {
      calls += 1;
      if (calls < 3) return new Response('{}', { status: 429, headers: { 'Retry-After': '0' } });
      return new Response('{}', { status: 201, headers: { 'Content-Type': 'application/json' } });
    },
  );
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(
    uploadFileToMicrosoft(
      'https://upload.example/session',
      virtualBlob(1024),
      ['0-'],
      new AbortController().signal,
      () => {},
      async () => {
        calls += 1;
        return new Response('{}', { status: 503, headers: { 'Retry-After': '0' } });
      },
    ),
  );
  assert.equal(calls, 3);
});

test('cancelamento aborta antes do próximo PUT', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(
    uploadFileToMicrosoft(
      'https://upload.example/session',
      virtualBlob(1024),
      ['0-'],
      controller.signal,
      () => {},
      async () => {
        called = true;
        return new Response('{}', { status: 201 });
      },
    ),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
  assert.equal(called, false);
});

test('erro CORS do PUT direto vira erro controlado', async () => {
  let calls = 0;
  await assert.rejects(
    uploadFileToMicrosoft(
      'https://upload.example/session',
      virtualBlob(5 * 1024 * 1024),
      ['0-'],
      new AbortController().signal,
      () => {},
      async () => {
        calls += 1;
        throw new TypeError('Failed to fetch');
      },
    ),
    /O upload direto para o Microsoft Outlook foi bloqueado\./,
  );
  assert.equal(calls, 3);
});
