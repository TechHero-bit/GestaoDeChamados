import { HttpClient, HttpErrorResponse, HttpEventType } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom, Subscription, timeout, TimeoutError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiDataResponse, TicketMessage } from '../models/ticket.model';
import {
  createSmallAttachmentFormData,
  replyAttachmentStrategy,
  uploadFileToMicrosoft,
} from '../utils/microsoft-graph-upload';
import { AttachmentUploadState } from '../utils/reply-attachment-state';
export type {
  AttachmentUploadState,
  ReplyAttachmentProgress,
} from '../utils/reply-attachment-state';

export const MAX_REPLY_ATTACHMENT_SIZE = 150 * 1024 * 1024;
const BACKEND_REQUEST_TIMEOUT_MS = 60_000;

interface AttachmentMetadata {
  name: string;
  size: number;
  contentType: string;
}

interface DraftResponse {
  handle: string;
  attachments: Array<{
    index: number;
    name: string;
    size: number;
    content_type: string;
    upload_type: 'simple' | 'upload_session';
  }>;
  signature_added: boolean;
}

interface UploadSessionResponse {
  uploadUrl: string;
  expirationDateTime?: string;
  nextExpectedRanges: string[];
}

type ProgressCallback = (index: number, uploaded: number, state: AttachmentUploadState) => void;

@Injectable({ providedIn: 'root' })
export class ReplyAttachmentUploadService {
  private readonly http = inject(HttpClient);
  private readonly ticketsUrl = `${environment.apiUrl}/tickets`;

  async send(
    ticketId: string,
    message: string,
    files: File[],
    signal: AbortSignal,
    onProgress: ProgressCallback,
  ): Promise<TicketMessage> {
    validateSelectedFiles(files);
    const attachments = files.map(fileMetadata);
    let handle: string | null = null;
    const activeUploadUrls = new Set<string>();

    try {
      attachmentFlowDiagnostic({
        file_selected: true,
        draft_created: false,
        small_upload_started: false,
        upload_session_created: false,
        chunk_started: false,
        attachment_completed: false,
        draft_sent: false,
      });
      const draft = await firstValueFrom(
        this.http
          .post<ApiDataResponse<DraftResponse>>(`${this.ticketsUrl}/${ticketId}/reply/draft`, {
            mensagem: message,
            attachments,
          })
          .pipe(timeout(BACKEND_REQUEST_TIMEOUT_MS)),
      );
      if (!draft?.data?.handle || !Array.isArray(draft.data.attachments)) {
        throw new Error('O servidor não retornou um rascunho válido.');
      }
      handle = draft.data.handle;
      attachmentFlowDiagnostic({ draft_created: true });
      signal.throwIfAborted();

      for (const descriptor of draft.data.attachments) {
        const file = files[descriptor.index];
        if (!file) throw new Error('O servidor retornou um anexo que não pertence ao manifesto.');
        const strategy = replyAttachmentStrategy(file.size);
        const serverStrategy = descriptor.upload_type === 'simple' ? 'small' : 'large';
        if (strategy !== serverStrategy) {
          throw new Error(
            'O servidor retornou uma estratégia de upload incompatível com o arquivo.',
          );
        }
        onProgress(descriptor.index, 0, 'uploading');
        if (strategy === 'small') {
          attachmentFlowDiagnostic({ strategy: 'small', small_upload_started: true });
          await this.uploadSmall(
            ticketId,
            handle,
            message,
            attachments,
            descriptor.index,
            file,
            signal,
            (uploaded) => onProgress(descriptor.index, uploaded, 'uploading'),
          );
        } else {
          attachmentFlowDiagnostic({ strategy: 'large' });
          const sessionResponse = await firstValueFrom(
            this.http
              .post<ApiDataResponse<UploadSessionResponse>>(
                `${this.ticketsUrl}/${ticketId}/reply/draft/upload-session`,
                { handle, index: descriptor.index, mensagem: message, attachments },
              )
              .pipe(timeout(BACKEND_REQUEST_TIMEOUT_MS)),
          );
          if (!sessionResponse?.data?.uploadUrl) {
            throw new Error('A Microsoft não retornou uma sessão de upload válida.');
          }
          const uploadUrl = sessionResponse.data.uploadUrl;
          attachmentFlowDiagnostic({ upload_session_created: true, chunk_started: true });
          activeUploadUrls.add(uploadUrl);
          await uploadFileToMicrosoft(
            uploadUrl,
            file,
            sessionResponse.data.nextExpectedRanges,
            signal,
            (uploaded) => onProgress(descriptor.index, uploaded, 'uploading'),
          );
          activeUploadUrls.delete(uploadUrl);
        }
        signal.throwIfAborted();
        onProgress(descriptor.index, file.size, 'done');
        attachmentFlowDiagnostic({ attachment_completed: true });
      }

      const sent = await firstValueFrom(
        this.http
          .post<ApiDataResponse<TicketMessage>>(`${this.ticketsUrl}/${ticketId}/reply/draft/send`, {
            handle,
            mensagem: message,
            attachments,
          })
          .pipe(timeout(BACKEND_REQUEST_TIMEOUT_MS)),
      );
      attachmentFlowDiagnostic({ draft_sent: true });
      return sent.data;
    } catch (error) {
      await this.cleanup(ticketId, handle, activeUploadUrls);
      attachmentFlowDiagnostic({ attachment_completed: false, draft_sent: false });
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        throw new Error('Envio cancelado. O rascunho não foi enviado.');
      }
      throw publicUploadError(error);
    } finally {
      activeUploadUrls.clear();
      handle = null;
    }
  }

  private async uploadSmall(
    ticketId: string,
    handle: string,
    message: string,
    attachments: AttachmentMetadata[],
    index: number,
    file: File,
    signal: AbortSignal,
    onProgress: (uploaded: number) => void,
  ): Promise<void> {
    const form = createSmallAttachmentFormData(
      handle,
      index,
      message,
      attachments,
      file,
      file.name,
    );
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      let settled = false;
      let subscription: Subscription | undefined;
      function finish(callback: () => void) {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        callback();
      }
      function abort() {
        subscription?.unsubscribe();
        finish(() => reject(new DOMException('Aborted', 'AbortError')));
      }
      signal.addEventListener('abort', abort, { once: true });
      subscription = this.http
        .post(`${this.ticketsUrl}/${ticketId}/reply/draft/attachments`, form, {
          reportProgress: true,
          observe: 'events',
        })
        .pipe(timeout(BACKEND_REQUEST_TIMEOUT_MS))
        .subscribe({
          next: (event) => {
            if (event.type === HttpEventType.UploadProgress && event.total) {
              onProgress(Math.min(file.size, Math.floor((event.loaded / event.total) * file.size)));
            }
            if (event.type === HttpEventType.Response) {
              onProgress(file.size);
              finish(resolve);
            }
          },
          error: (error) => finish(() => reject(error)),
        });
    });
  }

  private async cleanup(
    ticketId: string,
    handle: string | null,
    uploadUrls: Set<string>,
  ): Promise<void> {
    await Promise.allSettled(
      [...uploadUrls].map((uploadUrl) =>
        fetch(uploadUrl, {
          method: 'DELETE',
          signal: AbortSignal.timeout(5_000),
        }),
      ),
    );
    if (handle) {
      try {
        await firstValueFrom(
          this.http
            .post(`${this.ticketsUrl}/${ticketId}/reply/draft/cancel`, { handle })
            .pipe(timeout(5_000)),
        );
      } catch {
        // Limpeza é best effort e jamais pode transformar o rascunho em envio.
      }
    }
  }
}

function attachmentFlowDiagnostic(fields: Record<string, boolean | 'small' | 'large'>): void {
  if (environment.production) return;
  const values = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  console.info(`ATTACHMENT_FLOW: ${values}`);
}

function fileMetadata(file: File): AttachmentMetadata {
  return { name: file.name, size: file.size, contentType: file.type || 'application/octet-stream' };
}

function validateSelectedFiles(files: File[]): void {
  if (files.length === 0) throw new Error('Selecione ao menos um arquivo para enviar.');
  if (files.some((file) => !Number.isSafeInteger(file.size) || file.size <= 0)) {
    throw new Error('Não é possível enviar um arquivo vazio.');
  }
}

function publicUploadError(error: unknown): Error {
  if (error instanceof HttpErrorResponse) {
    return new Error(
      error.status === 0
        ? 'Não foi possível comunicar com o servidor para enviar os anexos.'
        : typeof error.error?.message === 'string'
          ? error.error.message
          : 'Não foi possível preparar os anexos.',
    );
  }
  if (error instanceof TimeoutError) {
    return new Error('O envio excedeu o tempo limite e foi cancelado.');
  }
  return error instanceof Error ? error : new Error('Não foi possível enviar os anexos.');
}
