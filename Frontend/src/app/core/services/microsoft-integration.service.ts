import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { MicrosoftConnectionStatus } from '../models/microsoft-connection.model';

@Injectable({ providedIn: 'root' })
export class MicrosoftIntegrationService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = `${environment.apiUrl}/integrations/microsoft`;

  getStatus(): Observable<MicrosoftConnectionStatus> {
    return this.http.get<MicrosoftConnectionStatus>(`${this.apiUrl}/status`);
  }

  disconnect(): Observable<{ success: boolean }> {
    return this.http.post<{ success: boolean }>(`${this.apiUrl}/disconnect`, {});
  }

  connect(): void {
    // A navegação completa preserva o redirect OAuth e evita XHR/interceptor.
    window.location.assign(`${this.apiUrl}/connect`);
  }
}
