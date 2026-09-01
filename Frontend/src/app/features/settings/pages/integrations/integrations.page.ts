import { Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { finalize } from 'rxjs';
import { MicrosoftConnectionStatus } from '../../../../core/models/microsoft-connection.model';
import { MicrosoftIntegrationService } from '../../../../core/services/microsoft-integration.service';

@Component({
  selector: 'app-integrations-page',
  standalone: true,
  templateUrl: './integrations.page.html',
})
export class IntegrationsPage implements OnInit {
  private readonly integrationService = inject(MicrosoftIntegrationService);
  private readonly route = inject(ActivatedRoute);

  readonly status = signal<MicrosoftConnectionStatus | null>(null);
  readonly loading = signal(true);
  readonly disconnecting = signal(false);
  readonly errorMessage = signal('');
  readonly feedbackMessage = signal('');

  ngOnInit(): void {
    const result = this.route.snapshot.queryParamMap.get('microsoft');
    if (result === 'connected') this.feedbackMessage.set('Conta Microsoft conectada com sucesso.');
    if (result === 'error') this.errorMessage.set('Não foi possível conectar a conta Microsoft. Tente novamente.');
    this.loadStatus();
  }

  loadStatus(): void {
    this.loading.set(true);
    this.errorMessage.set('');
    this.integrationService
      .getStatus()
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (status) => this.status.set(status),
        error: () => this.errorMessage.set('Não foi possível consultar o status da integração.'),
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
}
