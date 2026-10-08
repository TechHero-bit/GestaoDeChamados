/** O retorno externo entra pela raiz e a navegação interna fica com o Angular. */
export function microsoftOAuthLandingPath(result: unknown): string {
  if (result === 'connected' || result === 'error') {
    return '/settings/integrations?microsoft=' + result;
  }
  return '/dashboard';
}
