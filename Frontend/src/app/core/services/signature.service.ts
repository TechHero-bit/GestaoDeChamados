import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { SignatureStatus } from '../models/auth.model';

@Injectable({ providedIn: 'root' })
export class SignatureService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = `${environment.apiUrl}/profile/signature`;

  get(): Observable<SignatureStatus> {
    return this.http.get<SignatureStatus>(this.apiUrl);
  }

  upload(file: File): Observable<SignatureStatus> {
    const formData = new FormData();
    formData.append('signature', file, file.name);
    return this.http.post<SignatureStatus>(this.apiUrl, formData);
  }

  updateSettings(enabled: boolean): Observable<SignatureStatus> {
    return this.http.put<SignatureStatus>(`${this.apiUrl}/settings`, { enabled });
  }

  remove(): Observable<{ success: boolean; enabled: boolean; has_signature: boolean; image_url: null }> {
    return this.http.delete<{ success: boolean; enabled: boolean; has_signature: boolean; image_url: null }>(this.apiUrl);
  }
}
