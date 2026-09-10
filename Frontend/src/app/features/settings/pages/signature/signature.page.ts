import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { finalize } from 'rxjs';
import { SignatureStatus } from '../../../../core/models/auth.model';
import { SignatureService } from '../../../../core/services/signature.service';

@Component({
  selector: 'app-signature-page',
  templateUrl: './signature.page.html',
})
export class SignaturePage implements OnInit, OnDestroy {
  private readonly signatureService = inject(SignatureService);
  readonly signature = signal<SignatureStatus | null>(null);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly removing = signal(false);
  readonly toggling = signal(false);
  readonly selectedFile = signal<File | null>(null);
  readonly localPreviewUrl = signal<string | null>(null);
  readonly errorMessage = signal('');
  readonly feedbackMessage = signal('');

  ngOnInit(): void {
    this.loadSignature();
  }

  ngOnDestroy(): void {
    this.releaseLocalPreview();
  }

  loadSignature(): void {
    this.loading.set(true);
    this.signatureService
      .get()
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (signature) => this.signature.set(signature),
        error: (error) =>
          this.errorMessage.set(
            this.getBackendErrorMessage(
              error,
              'Não foi possível consultar a assinatura de e-mail.',
            ),
          ),
      });
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] || null;
    this.releaseLocalPreview();
    if (!file) {
      this.selectedFile.set(null);
      return;
    }
    if (!file.name.toLowerCase().endsWith('.png') || file.type !== 'image/png') {
      input.value = '';
      this.selectedFile.set(null);
      this.errorMessage.set('Escolha um arquivo PNG.');
      return;
    }
    this.errorMessage.set('');
    this.selectedFile.set(file);
    this.localPreviewUrl.set(URL.createObjectURL(file));
  }

  saveSignature(): void {
    const file = this.selectedFile();
    if (!file) return;
    this.saving.set(true);
    this.errorMessage.set('');
    this.signatureService
      .upload(file)
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: (signature) => {
          this.signature.set(signature);
          this.selectedFile.set(null);
          this.releaseLocalPreview();
          this.feedbackMessage.set('Assinatura salva com sucesso.');
        },
        error: (error) =>
          this.errorMessage.set(
            this.getBackendErrorMessage(error, 'Não foi possível salvar a assinatura.'),
          ),
      });
  }

  toggleSignature(event: Event): void {
    const enabled = (event.target as HTMLInputElement).checked;
    this.toggling.set(true);
    this.errorMessage.set('');
    this.signatureService
      .updateSettings(enabled)
      .pipe(finalize(() => this.toggling.set(false)))
      .subscribe({
        next: (signature) => this.signature.set(signature),
        error: (error) =>
          this.errorMessage.set(
            this.getBackendErrorMessage(error, 'Não foi possível atualizar a assinatura.'),
          ),
      });
  }

  removeSignature(): void {
    this.removing.set(true);
    this.errorMessage.set('');
    this.signatureService
      .remove()
      .pipe(finalize(() => this.removing.set(false)))
      .subscribe({
        next: () => {
          this.signature.set({ enabled: false, has_signature: false, image_url: null });
          this.selectedFile.set(null);
          this.releaseLocalPreview();
          this.feedbackMessage.set('Assinatura removida.');
        },
        error: (error) =>
          this.errorMessage.set(
            this.getBackendErrorMessage(error, 'Não foi possível remover a assinatura.'),
          ),
      });
  }

  private getBackendErrorMessage(error: unknown, fallback: string): string {
    const response = error as { error?: unknown; message?: unknown };
    const payload = response?.error;
    if (payload && typeof payload === 'object' && 'message' in payload) {
      const message = (payload as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim()) return message;
    }
    if (typeof payload === 'string' && payload.trim()) return payload;
    if (typeof response?.message === 'string' && response.message.trim()) return response.message;
    return fallback;
  }

  private releaseLocalPreview(): void {
    const previewUrl = this.localPreviewUrl();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    this.localPreviewUrl.set(null);
  }
}
