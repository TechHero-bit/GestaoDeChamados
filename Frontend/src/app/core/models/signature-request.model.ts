export type CorporateSignatureStatus = 'Pendente' | 'Revisão necessária' | 'Gerada';

export interface SignatureImageCandidate {
  id: string;
  attachment_id: string;
  file_name: string;
  content_type: string;
  file_size: number;
  is_inline: boolean;
  content_id: string | null;
  processing_status: 'Pendente' | 'Disponivel' | 'Falhou';
  processing_error: string | null;
  available_at: string | null;
  score: number;
  confidence: number;
  classification: 'provavel_foto' | 'incerta' | 'assinatura_remetente';
  reasons: string[];
}

export interface SignatureArtifact {
  id: string;
  file_name: string;
  file_size: number;
  created_at: string;
  created_by: string | null;
}

export interface SignatureRequest {
  id: string;
  source_ticket_id: string | null;
  source_outlook_message_id: string;
  source_sender_email: string;
  source_subject: string;
  employee_name: string | null;
  job_title: string | null;
  phone: string | null;
  corporate_email: string | null;
  status: CorporateSignatureStatus;
  extraction_warnings: string[];
  email_conflict: boolean;
  photo_selection_required: boolean;
  photo_confidence: number | null;
  photo_attachment_id: string | null;
  has_manual_photo: boolean;
  generated_at: string | null;
  created_at: string;
  data_atualizacao: string;
  images: SignatureImageCandidate[];
  history: SignatureArtifact[];
}

export interface SignatureRequestListResponse {
  success: true;
  data: SignatureRequest[];
  total: number;
  page: number;
  page_size: number;
}

export interface SignatureRequestUpdate {
  employee_name?: string;
  job_title?: string;
  phone?: string;
  corporate_email?: string;
  photo_attachment_id?: string | null;
}
