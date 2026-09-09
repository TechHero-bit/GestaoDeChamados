import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ApiDataResponse, TicketMessage } from '../models/ticket.model';
import { uploadFileToMicrosoft } from '../utils/microsoft-graph-upload';

export const MAX_REPLY_ATTACHMENT_SIZE = 150 * 1024 * 1024;
const SMALL_ATTACHMENT_LIMIT = 3 * 1024 * 1024;

export type AttachmentUploadState = 'pending' | 'uploading' | 'done' | 'error';

export interface ReplyAttachmentProgress {
  file: File;
  uploaded: number;
  progress: number;
  state: AttachmentUploadState;
}

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
    const attachments = files.map(fileMetadata);
    let handle: string | null = null;
    const activeUploadUrls = new Set<string>();

    try {
      const draft = await firstValueFrom(
        this.http.post<ApiDataResponse<DraftResponse>>(`${this.ticketsUrl}/${ticketId}/reply/draft`, {
          mensagem: message,
          attachments,
        }),
      );
      handle = draft.data.handle;
      signal.throwIfAborted();

      for (const descriptor of draft.data.attachments) {
        const file = files[descriptor.index];
        onProgress(descriptor.index, 0, 'uploading');
        if (file.size < SMALL_ATTACHMENT_LIMIT) {
          await this.uploadSmall(ticketId, handle, message, attachments, descriptor.index, file);
        } else {
          const sessionResponse = await firstValueFrom(
            this.http.post<ApiDataResponse<UploadSessionResponse>>(
              `${this.ticketsUrl}/${ticketId}/reply/draft/upload-session`,
              { handle, index: descriptor.index, mensagem: message, attachments },
            ),
          );
          const uploadUrl = sessionResponse.data.uploadUrl;
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
      }

      const sent = await firstValueFrom(
        this.http.post<ApiDataResponse<TicketMessage>>(
          `${this.ticketsUrl}/${ticketId}/reply/draft/send`,
          { handle, mensagem: message, attachments },
        ),
      );
      return sent.data;
    } catch (error) {
      await this.cleanup(ticketId, handle, activeUploadUrls);
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
  ): Promise<void> {
    const form = new FormData();
    form.append('handle', handle);
    form.append('index', String(index));
    form.append('mensagem', message);
    form.append('attachments', JSON.stringify(attachments));
    form.append('attachment', file, file.name);
    await firstValueFrom(
      this.http.post(`${this.ticketsUrl}/${ticketId}/reply/draft/attachments`, form),
    );
  }

  private async cleanup(ticketId: string, handle: string | null, uploadUrls: Set<string>): Promise<void> {
    await Promise.allSettled(
      [...uploadUrls].map((uploadUrl) => fetch(uploadUrl, { method: 'DELETE' })),
    );
    if (handle) {
      try {
        await firstValueFrom(
          this.http.post(`${this.ticketsUrl}/${ticketId}/reply/draft/cancel`, { handle }),
        );
      } catch {
        // Limpeza é best effort e jamais pode transformar o rascunho em envio.
      }
    }
  }
}

function fileMetadata(file: File): AttachmentMetadata {
  return { name: file.name, size: file.size, contentType: file.type || 'application/octet-stream' };
}

function publicUploadError(error: unknown): Error {
  if (error instanceof HttpErrorResponse) {
    return new Error(
      typeof error.error?.message === 'string'
        ? error.error.message
        : 'Não foi possível preparar os anexos.',
    );
  }
  if (error instanceof TypeError) {
    return new Error(
      'O navegador não conseguiu acessar o upload da Microsoft. Verifique a política CORS da conta Outlook.',
    );
  }
  return error instanceof Error ? error : new Error('Não foi possível enviar os anexos.');
}
