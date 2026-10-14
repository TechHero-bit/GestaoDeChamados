import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, map, Observable, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  CorporateSignatureStatus,
  SignatureRequest,
  SignatureRequestListResponse,
  SignatureRequestUpdate,
} from '../models/signature-request.model';

interface DataResponse<T> {
  success: true;
  data: T;
}

interface GenerateResponse {
  request: SignatureRequest;
  artifact_id: string;
  file_name: string;
}

@Injectable({ providedIn: 'root' })
export class SignatureRequestService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = `${environment.apiUrl}/signatures`;

  list(status: CorporateSignatureStatus | '' = '', search = ''): Observable<SignatureRequestListResponse> {
    let params = new HttpParams().set('page_size', '50');
    if (status) params = params.set('status', status);
    if (search.trim()) params = params.set('search', search.trim());
    return this.http
      .get<SignatureRequestListResponse>(this.apiUrl, { params })
      .pipe(catchError((error) => this.handleError(error)));
  }

  get(id: string): Observable<SignatureRequest> {
    return this.http.get<DataResponse<SignatureRequest>>(`${this.apiUrl}/${id}`).pipe(
      map((response) => response.data),
      catchError((error) => this.handleError(error)),
    );
  }

  update(id: string, values: SignatureRequestUpdate): Observable<SignatureRequest> {
    return this.http.put<DataResponse<SignatureRequest>>(`${this.apiUrl}/${id}`, values).pipe(
      map((response) => response.data),
      catchError((error) => this.handleError(error)),
    );
  }

  uploadPhoto(id: string, file: File): Observable<SignatureRequest> {
    const body = new FormData();
    body.append('photo', file, file.name);
    return this.http.post<DataResponse<SignatureRequest>>(`${this.apiUrl}/${id}/photo`, body).pipe(
      map((response) => response.data),
      catchError((error) => this.handleError(error)),
    );
  }

  loadPhoto(id: string): Observable<Blob> {
    return this.http
      .get(`${this.apiUrl}/${id}/photo`, { responseType: 'blob' })
      .pipe(catchError((error) => this.handleError(error)));
  }

  loadCandidate(id: string, attachmentId: string): Observable<Blob> {
    return this.http
      .get(`${this.apiUrl}/${id}/images/${attachmentId}`, { responseType: 'blob' })
      .pipe(catchError((error) => this.handleError(error)));
  }

  generate(id: string, png: Blob): Observable<GenerateResponse> {
    const body = new FormData();
    body.append('signature', png, 'assinatura.png');
    return this.http.post<DataResponse<GenerateResponse>>(`${this.apiUrl}/${id}/generate`, body).pipe(
      map((response) => response.data),
      catchError((error) => this.handleError(error)),
    );
  }

  artifactUrl(requestId: string, artifactId: string): string {
    return `${this.apiUrl}/${encodeURIComponent(requestId)}/history/${encodeURIComponent(artifactId)}`;
  }

  private handleError(error: HttpErrorResponse): Observable<never> {
    const message =
      typeof error.error?.message === 'string'
        ? error.error.message
        : 'Não foi possível processar a assinatura. Tente novamente.';
    return throwError(() => new Error(message));
  }
}
