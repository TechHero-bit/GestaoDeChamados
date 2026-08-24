import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, map, Observable, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  ApiDataResponse,
  Ticket,
  TicketDetail,
  TicketListFilters,
  TicketListResponse,
  TicketMessage,
  TicketStatus,
} from '../models/ticket.model';

@Injectable({ providedIn: 'root' })
export class TicketService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = `${environment.apiUrl}/tickets`;

  listar(filters: TicketListFilters = {}): Observable<TicketListResponse> {
    let params = new HttpParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        params = params.set(key, String(value));
      }
    });

    return this.http
      .get<TicketListResponse>(this.apiUrl, { params })
      .pipe(catchError((error) => this.handleError(error)));
  }

  buscarPorId(id: string): Observable<TicketDetail> {
    return this.http.get<ApiDataResponse<TicketDetail>>(`${this.apiUrl}/${id}`).pipe(
      map((response) => response.data),
      catchError((error) => this.handleError(error)),
    );
  }

  atualizarStatus(id: string, status: TicketStatus): Observable<Ticket> {
    return this.http.put<ApiDataResponse<Ticket>>(`${this.apiUrl}/${id}`, { status }).pipe(
      map((response) => response.data),
      catchError((error) => this.handleError(error)),
    );
  }

  excluir(id: string): Observable<void> {
    return this.http
      .delete<void>(`${this.apiUrl}/${id}`)
      .pipe(catchError((error) => this.handleError(error)));
  }

  responder(id: string, mensagem: string): Observable<TicketMessage> {
    return this.http
      .post<ApiDataResponse<TicketMessage>>(`${this.apiUrl}/${id}/reply`, { mensagem })
      .pipe(
        map((response) => response.data),
        catchError((error) => this.handleError(error)),
      );
  }

  private handleError(error: HttpErrorResponse): Observable<never> {
    const message =
      typeof error.error?.message === 'string'
        ? error.error.message
        : 'Não foi possível comunicar com o Help Desk. Tente novamente.';
    return throwError(() => new Error(message));
  }
}
