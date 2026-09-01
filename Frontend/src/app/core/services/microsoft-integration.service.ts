import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { MicrosoftConnectionStatus } from '../models/microsoft-connection.model';
import { AuthService } from './auth.service';

@Injectable({ providedIn: 'root' })
export class MicrosoftIntegrationService {
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);
  private readonly apiUrl = `${environment.apiUrl}/integrations/microsoft`;

  getStatus(): Observable<MicrosoftConnectionStatus> {
    return this.http.get<MicrosoftConnectionStatus>(`${this.apiUrl}/status`);
  }

  disconnect(): Observable<{ success: boolean }> {
    return this.http.post<{ success: boolean }>(`${this.apiUrl}/disconnect`, {});
  }

  sendTestEmail(payload: {
    destinatario: string;
    assunto: string;
    mensagem: string;
  }): Observable<{ success: boolean; message: string }> {
    return this.http.post<{ success: boolean; message: string }>(
      `${this.apiUrl}/test-email`,
      payload,
    );
  }

  connect(): void {
    // A navegação completa preserva o redirect OAuth e evita XHR/interceptor.
    this.authService.beginExternalAuth();
    try {
      window.location.assign(`${this.apiUrl}/connect`);
    } catch {
      // Permite que o monitor volte a funcionar se a navegação for bloqueada.
      this.authService.cancelExternalAuth();
      throw new Error('Não foi possível iniciar a conexão Microsoft.');
    }
  }
}
