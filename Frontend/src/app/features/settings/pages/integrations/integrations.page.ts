import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { finalize } from 'rxjs';
import { MicrosoftConnectionStatus } from '../../../../core/models/microsoft-connection.model';
import { SignatureStatus } from '../../../../core/models/auth.model';
import { MicrosoftIntegrationService } from '../../../../core/services/microsoft-integration.service';
import { SignatureService } from '../../../../core/services/signature.service';

@Component({
  selector: 'app-integrations-page',
  standalone: true,
  templateUrl: './integrations.page.html',
})
export class IntegrationsPage implements OnInit, OnDestroy {
  private readonly integrationService = inject(MicrosoftIntegrationService);
  private readonly signatureService = inject(SignatureService);
  private readonly route = inject(ActivatedRoute);

  readonly status = signal<MicrosoftConnectionStatus | null>(null);
  readonly signature = signal<SignatureStatus | null>(null);
  readonly loading = signal(true);
  readonly signatureLoading = signal(true);
  readonly disconnecting = signal(false);
  readonly signatureSaving = signal(false);
  readonly signatureRemoving = signal(false);
  readonly signatureToggling = signal(false);
  readonly selectedFile = signal<File | null>(null);
  readonly localPreviewUrl = signal<string | null>(null);
  readonly errorMessage = signal('');
  readonly feedbackMessage = signal('');

  ngOnInit(): void {
    const result = this.route.snapshot.queryParamMap.get('microsoft');
    if (result === 'connected') this.feedbackMessage.set('Conta Microsoft conectada com sucesso.');
    if (result === 'error') this.errorMessage.set('Não foi possível conectar a conta Microsoft. Tente novamente.');
    this.loadStatus();
    this.loadSignature();
  }

  ngOnDestroy(): void {
    this.releaseLocalPreview();
  }

  loadStatus(): void {
    this.loading.set(true);
    this.integrationService
      .getStatus()
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (status) => this.status.set(status),
        error: () => this.errorMessage.set('Não foi possível consultar o status da integração.'),
      });
  }

  loadSignature(): void {
    this.signatureLoading.set(true);
    this.signatureService
      .get()
      .pipe(finalize(() => this.signatureLoading.set(false)))
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

  connect(): void {
    this.integrationService.connect();
  }

  disconnect(): void {
    this.disconnecting.set(true);
    this.errorMessage.set('');
    this.integrationService
      .disconnect()
      .pipe(finalize(() => this.disconnecting.set(false)))
      .subscribe({
        next: () => {
          this.feedbackMessage.set('Conta Microsoft desconectada.');
          this.loadStatus();
        },
        error: () => this.errorMessage.set('Não foi possível desconectar a conta Microsoft.'),
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

    this.signatureSaving.set(true);
    this.errorMessage.set('');
    this.signatureService
      .upload(file)
      .pipe(finalize(() => this.signatureSaving.set(false)))
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
    this.signatureToggling.set(true);
    this.errorMessage.set('');
    this.signatureService
      .updateSettings(enabled)
      .pipe(finalize(() => this.signatureToggling.set(false)))
      .subscribe({
        next: (signature) => this.signature.set(signature),
        error: (error) => {
          this.errorMessage.set(
            this.getBackendErrorMessage(error, 'Não foi possível atualizar a assinatura.'),
          );
        },
      });
  }

  removeSignature(): void {
    this.signatureRemoving.set(true);
    this.errorMessage.set('');
    this.signatureService
      .remove()
      .pipe(finalize(() => this.signatureRemoving.set(false)))
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
