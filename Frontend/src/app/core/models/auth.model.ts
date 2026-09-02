export type UserRole = 'ADMIN' | 'AGENT';

export interface User {
  id: string;
  nome: string;
  email: string;
  role: UserRole;
  data_criacao?: string;
}


export interface SignatureStatus {
  success?: boolean;
  enabled: boolean;
  has_signature: boolean;
  image_url: string | null;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface AuthResponse {
  success: boolean;
  message?: string;
  user: User;
}

export type AuthState = 'checking' | 'authenticated' | 'unauthenticated';
