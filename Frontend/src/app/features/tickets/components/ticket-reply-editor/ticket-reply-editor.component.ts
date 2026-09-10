import { Component, computed, inject, input, OnDestroy, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription, finalize } from 'rxjs';
import { TicketMessage } from '../../../../core/models/ticket.model';
import { TicketService } from '../../../../core/services/ticket.service';
import {
  MAX_REPLY_ATTACHMENT_SIZE,
  ReplyAttachmentProgress,
  ReplyAttachmentUploadService,
} from '../../../../core/services/reply-attachment-upload.service';
import {
  markUnfinishedAttachments,
  updateAttachmentProgress,
} from '../../../../core/utils/reply-attachment-state';
import { FileAttachmentComponent } from '../../../../shared/components/file-attachment/file-attachment.component';

const ALLOWED_EXTENSIONS = new Set([
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'txt',
  'csv',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'zip',
  'rtf',
  'odt',
  'ods',
  'odp',
  'json',
  'xml',
  'eml',
]);
const BLOCKED_EXTENSIONS = new Set([
  'exe',
  'bat',
  'cmd',
  'ps1',
  'vbs',
  'scr',
  'com',
  'msi',
  'js',
  'jse',
  'wsf',
  'wsh',
  'hta',
  'cpl',
  'reg',
  'lnk',
]);

@Component({
  selector: 'app-ticket-reply-editor',
  imports: [FormsModule, FileAttachmentComponent],
  templateUrl: './ticket-reply-editor.component.html',
})
export class TicketReplyEditorComponent implements OnDestroy {
  private readonly ticketService = inject(TicketService);
  private readonly attachmentUpload = inject(ReplyAttachmentUploadService);
  private request?: Subscription;
  private uploadAbort?: AbortController;

  readonly ticketId = input.required<string>();
  readonly requester = input('solicitante');
  readonly messageSent = output<TicketMessage>();
  readonly sending = signal(false);
  readonly error = signal('');
  readonly sentNotice = signal(false);
  readonly attachments = signal<ReplyAttachmentProgress[]>([]);
  readonly uploadInProgress = computed(
    () =>
      this.sending() &&
      this.attachments().some((item) => item.state === 'pending' || item.state === 'uploading'),
  );
  message = '';

  send(): void {
    const message = this.message.trim();
    if (!message || this.sending()) return;
    this.error.set('');
    this.sentNotice.set(false);
    this.sending.set(true);
    if (this.attachments().length > 0) {
      void this.sendWithAttachments(message);
      return;
    }
    this.request = this.ticketService
      .responder(this.ticketId(), message)
      .pipe(finalize(() => this.sending.set(false)))
      .subscribe({
        next: (createdMessage) => {
          this.message = '';
          this.sentNotice.set(true);
          this.messageSent.emit(createdMessage);
        },
        error: (error: Error) => this.error.set(error.message),
      });
  }

  selectFiles(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files || [])];
    input.value = '';
    if (this.sending() || files.length === 0) return;
    if (this.attachments().length + files.length > 20) {
      this.error.set('Selecione no máximo 20 anexos por resposta.');
      return;
    }
    for (const file of files) {
      if (file.size <= 0) {
        this.error.set('Não é possível enviar um arquivo vazio.');
        return;
      }
      if (file.size > MAX_REPLY_ATTACHMENT_SIZE) {
        this.error.set('Este arquivo excede o limite máximo suportado pelo Outlook.');
        return;
      }
      const extension = file.name.split('.').pop()?.toLowerCase() || '';
      if (BLOCKED_EXTENSIONS.has(extension)) {
        this.error.set('Este tipo de arquivo não é permitido.');
        return;
      }
      if (!ALLOWED_EXTENSIONS.has(extension)) {
        this.error.set('Este tipo de arquivo não é suportado.');
        return;
      }
    }
    this.error.set('');
    this.attachments.update((current) => [
      ...current,
      ...files.map((file) => ({ file, uploaded: 0, progress: 0, state: 'pending' as const })),
    ]);
  }

  removeFile(index: number): void {
    if (this.sending()) return;
    this.attachments.update((files) => files.filter((_, currentIndex) => currentIndex !== index));
  }

  cancel(): void {
    this.uploadAbort?.abort();
  }

  private async sendWithAttachments(message: string): Promise<void> {
    const selected = this.attachments();
    this.uploadAbort = new AbortController();
    try {
      const createdMessage = await this.attachmentUpload.send(
        this.ticketId(),
        message,
        selected.map(({ file }) => file),
        this.uploadAbort.signal,
        (index, uploaded, state) =>
          this.attachments.update((items) =>
            updateAttachmentProgress(items, index, uploaded, state),
          ),
      );
      this.message = '';
      this.attachments.set([]);
      this.sentNotice.set(true);
      this.messageSent.emit(createdMessage);
    } catch (error) {
      const cancelled = this.uploadAbort?.signal.aborted === true;
      this.attachments.update((items) => markUnfinishedAttachments(items, cancelled));
      this.error.set(error instanceof Error ? error.message : 'Não foi possível enviar os anexos.');
    } finally {
      this.uploadAbort = undefined;
      this.sending.set(false);
    }
  }

  ngOnDestroy(): void {
    this.request?.unsubscribe();
    this.uploadAbort?.abort();
  }
}
