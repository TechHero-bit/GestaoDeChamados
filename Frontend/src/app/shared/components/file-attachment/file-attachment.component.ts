import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { AttachmentUploadState } from '../../../core/utils/reply-attachment-state';

@Component({
  selector: 'app-file-attachment',
  templateUrl: './file-attachment.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FileAttachmentComponent {
  readonly name = input.required<string>();
  readonly size = input.required<number>();
  readonly contentType = input<string | null>(null);
  readonly uploaded = input(0);
  readonly progress = input(0);
  readonly state = input<AttachmentUploadState | 'available'>('available');
  readonly removable = input(false);
  readonly disabled = input(false);
  readonly actionLabel = input<string | null>(null);
  readonly secondaryActionLabel = input<string | null>(null);
  readonly actionDisabled = input(false);
  readonly removeRequested = output<void>();
  readonly actionRequested = output<void>();
  readonly secondaryActionRequested = output<void>();

  formatBytes(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  formatType(): string | null {
    const type = this.contentType()?.trim().toLowerCase();
    if (!type) return null;
    if (type === 'application/pdf') return 'PDF';
    if (type.startsWith('image/')) return 'Imagem';
    if (type.includes('word') || type === 'application/msword') return 'Word';
    if (type.includes('sheet') || type.includes('excel')) return 'Planilha';
    if (type.includes('presentation') || type.includes('powerpoint')) return 'Apresentação';
    if (type === 'text/csv') return 'CSV';
    if (type === 'text/plain') return 'TXT';
    if (type === 'application/zip' || type === 'application/x-zip-compressed') return 'ZIP';
    return type.split('/')[1]?.toUpperCase() || null;
  }

  iconName(): string {
    return this.contentType()?.startsWith('image/') ? 'image' : 'description';
  }
}
