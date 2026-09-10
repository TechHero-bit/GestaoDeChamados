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
  readonly uploaded = input(0);
  readonly progress = input(0);
  readonly state = input<AttachmentUploadState | 'available'>('available');
  readonly removable = input(false);
  readonly disabled = input(false);
  readonly removeRequested = output<void>();

  formatBytes(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
