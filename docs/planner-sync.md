# Preparação da sincronização Planner ↔ SmartDesk

## Estado atual e limites

Esta etapa entrega desenho, política pura com testes e rascunho SQL. NÃO há sincronização executável, webhook novo registrado, worker, cron, tarefa criada ou fluxo importado. Nenhuma variável abaixo ativa algo nesta versão.

O módulo Backend/src/services/planner-sync-policy.js não é importado pelo app. O arquivo database/planned/011_planner_sync.sql é rascunho para revisão, fora de database/migrations. Não aplicá-lo junto das migrations atuais.

Sincronizar inicialmente somente STATUS de vínculos explicitamente aprovados. Criação em massa de tarefas, importação de toda a fila, responsáveis, prioridades, prazo, mensagens e anexos ficam fora da ativação inicial. Atribuição no Portal continua independente da conta responsável no Planner.

## Mapeamento e comparação

| Portal | Planner percentComplete |
| --- | --- |
| Aberto | 0 |
| Em Andamento | 50 |
| Resolvido | 100 |

Ao receber valores intermediários válidos do Planner (1–99), normalizar para Em Andamento sem forçar reescrita do percentual para 50. Isso evita ciclos causados por diferença de representação.

Comparar status de negócio com last_synced_status, não apenas timestamps:

- Portal e Planner iguais: no-op; registrar baseline conciliada e versões lidas.
- Só Portal mudou: Portal → Planner.
- Só Planner mudou: Planner → Portal.
- Ambos mudaram para valores distintos: conflito, sem escolher silenciosamente um vencedor.
- Baseline ausente: exigir conciliação inicial explícita antes de escrever.
- Timestamp ou ETag mudou mas o status não mudou: não gerar escrita externa.

A política pura decide essas situações. O worker futuro deverá verificar versões novamente ao efetivar a decisão; testar a política sozinha não torna a integração segura contra corridas.

## Modelo proposto

planner_ticket_links relaciona ticket_id (único), planner_task_id (único) e planner_plan_id. Contém enabled=false por padrão, origem/horário da última conciliação, status conciliado, versão Portal e ETag Planner.

planner_sync_events é a fila durável com idempotency_key única, origem, versão da fonte, status, estado, tentativas, próxima tentativa e lease. planner_sync_logs registra resultado e código de erro seguro, sem corpo de e-mail, tokens, URLs assinadas ou cabeçalhos secretos.

O rascunho habilita RLS e permite operações somente ao service_role, usado exclusivamente no servidor. Não concede acesso às tabelas ao frontend. Não contém trigger de sincronização, RPC ou grants operacionais para um worker: esses itens deverão ser implementados e revisados na etapa 2.

A chave testada é SHA-256 de ticket_id + origem + versão da fonte + status. Usar a string original de data_atualizacao ou o ETag original. SHA-256 aqui identifica evento; NÃO autentica webhooks.

## Fluxo Portal → Planner proposto

1. Implementar captura transacional: o UPDATE do ticket e a inserção na outbox devem participar da mesma transação PostgreSQL, por RPC ou trigger revisado. Não usar um POST externo após UPDATE como único registro.
2. Enfileirar somente mudança real de status, com vínculo enabled=true e plano na allowlist aprovada. Não criar tarefa se não existir vínculo.
3. Executar dispatcher com lease/lock, concorrência controlada por ticket e lotes limitados; não depender de processo em memória da Vercel.
4. Antes de enviar, reler ticket e Planner. Evento antigo é superseded; duas alterações divergentes viram conflict.
5. Enviar evento autenticado ao fluxo HTTP com event_id, idempotency_key, ticket_id, planner_task_id, planner_plan_id, status, versão e origem portal.
6. No fluxo, obter tarefa atual, comparar percentComplete e atualizar apenas se houver diferença real. Confirmar o resultado antes de ACK.
7. Se usar Graph, enviar If-Match com ETag lido e tratar 412 como necessidade de reler e avaliar conflito; a [API oficial de atualização](https://learn.microsoft.com/en-us/graph/api/plannertask-update?view=graph-rest-1.0) exige esse cabeçalho.
8. Persistir ACK e baseline por comparação de versão. Um ACK atrasado não pode marcar como sincronizada uma revisão mais nova.

## Fluxo Planner → Portal proposto

1. Criar fluxo agendado, inicialmente a cada 5 minutos, em plano de homologação. Validar limites do tenant antes de ativar.
2. Usar List tasks no plano aprovado, seguir paginação e comparar somente tarefas vinculadas/enabled. O [conector oficial](https://learn.microsoft.com/en-us/connectors/planner/) documenta gatilhos de criação, atribuição e conclusão, sem gatilho genérico de qualquer atualização; também limita suporte a planos básicos.
3. Para alteração candidata, consultar tarefa atual, normalizar percentComplete e enviar evento autenticado ao futuro endpoint de integração.
4. O endpoint valida plano, vínculo, origem, identidade/versionamento e idempotência. Não aceitar ticket_id arbitrário para tarefa não vinculada.
5. Comparar novamente Portal/Planner com baseline. Aplicar status por UPDATE condicional da versão Portal; registrar evento aplicado, origem planner e baseline na mesma transação.
6. Na captura de saída, alterações de origem planner não devem reenfileirar o mesmo status. A comparação de valores continua obrigatória: origem, sozinha, não impede todos os loops.
7. Eventos fora de ordem não podem desfazer revisão nova. ETags não são números ordenáveis: buscar estado atual e rejeitar snapshot divergente. Em dúvida, marcar conflito.
8. Tarefa excluída, vínculo inválido ou ticket removido deve pausar a sincronização do vínculo e registrar falha; não recriar automaticamente.

## Segurança a implementar antes de ativar

- Endpoint próprio de integração, sem reaproveitar cookie de usuário nem segredo do webhook Outlook.
- Autenticação Entra com validação de emissor, audiência, tenant e aplicação autorizada, quando disponível no ambiente.
- Alternativa, a validar com as capacidades/licenças do fluxo: HMAC-SHA256 calculado por componente confiável, sobre timestamp + event_id + corpo bruto, com segredo exclusivo no servidor e comparação em tempo constante. Um segredo estático isolado não substitui a proteção de replay.
- Timestamp com janela curta, event_id/nonce durável, corpo/tamanho/schema estritos, allowlist de planos e limitação de requisições.
- Assinatura inválida, plano desconhecido ou replay: recusar antes de acessar/escrever dados de ticket.
- Segredos somente em configuração segura do backend e conexão do fluxo; nunca no Angular, logs, migration, documentação ou URL pública. Rotação com período controlado de duas chaves.
- Guardar idempotência antes do efeito e ACK transacional após confirmação. Retries devem reutilizar a mesma identidade.
- Verificar permissões mínimas da identidade Microsoft e eventual consentimento de administrador separadamente da integração Outlook atual.

## Falhas, conflitos e operação

Aplicar backoff exponencial com jitter, respeitar Retry-After em 429 e limitar tentativas. Após esgotar tentativas, marcar failed para revisão, mantendo histórico. Em timeout com resultado externo incerto, consultar estado externo antes de repetir.

Claims de processamento usam lease com prazo e retomada após interrupção. Não executar o mesmo vínculo simultaneamente em dois workers. Um processamento antigo não pode substituir ACK mais novo.

Conflitos exigem escolha explícita de responsável: manter Portal ou manter Planner, registrando autor, valores vistos e novas versões. Não decidir por relógio de máquinas distintas. Quando os valores convergirem naturalmente, registrar no-op conciliado.

Logs operacionais: event_id, ticket_id, direção, tentativa, latência, resultado e código seguro. Definir retenção (proposta: 30 dias), alertas para conflitos/falhas e um meio administrativo de reinspeção e reprocessamento controlado.

## Configuração futura — ainda não consumida pelo app

| Variável proposta | Finalidade |
| --- | --- |
| PLANNER_SYNC_ENABLED=false | Desligamento global; ativar somente após aprovação |
| PLANNER_ALLOWED_PLAN_IDS | Allowlist de planos homologados |
| POWER_AUTOMATE_PLANNER_URL | Endpoint seguro de saída; tratar URL SAS como segredo |
| PLANNER_WEBHOOK_SIGNING_SECRET | Segredo exclusivo, se escolhido HMAC |
| PLANNER_WEBHOOK_MAX_AGE_SECONDS=300 | Janela de replay |
| PLANNER_SYNC_MAX_ATTEMPTS=5 | Limite de retries |
| PLANNER_SYNC_BATCH_SIZE=20 | Lote inicial limitado |

O agendamento de entrada é configurado no Power Automate, não na sessão do navegador. As variáveis de identidade Entra dependem da autenticação escolhida e serão registradas quando implementadas.

## Sequência de implementação e ativação

1. Confirmar tenant, grupo, plan_id, tipo de plano, identidade de conexão, licenças para ações HTTP e dono dos fluxos.
2. Criar ambientes separados de homologação: Supabase, API e plano Planner com tarefas fictícias.
3. Revisar rascunho SQL, promover para migrations somente após schema e rollback/backups validados.
4. Implementar outbox transacional, endpoints autenticados, leasing, ACKs, logs, deduplicação e interface operacional de conflitos; integração desligada por padrão.
5. Criar os dois fluxos em solução exportável com connection references/environment variables; documentar importação e permissões.
6. Testar dry-run sem escritas, depois somente 1–3 vínculos fictícios criados manualmente, sem criação de tarefas em lote.
7. Validar ida e volta, repetir eventos, trocar ordem, mudar os dois lados ao mesmo tempo, simular 429/5xx/timeout, sessão/chave inválida, replay e interrupção depois da escrita antes do ACK.
8. Confirmar que nova execução sem mudanças não produz nenhuma escrita, que tickets não vinculados não são alterados e que mensagens/anexos/assinaturas permanecem independentes.
9. Apresentar resultados e pedir aprovação antes de migrations/fluxos/deploy/ativação de produção. Habilitar plano e vínculos progressivamente.
10. Para desligar: desabilitar flag global e vínculos, pausar os fluxos e dispatcher; manter fila/logs para diagnóstico. Não desfazer status em lote automaticamente.

## Testes disponíveis nesta etapa

Backend/test/planner-sync-policy.test.js cobre mapeamento, no-op, direção, ausência de baseline, conflito e identidade de eventos. Ainda faltam testes de integração de webhook, transação/outbox, leases, Power Automate e Graph porque esses componentes não foram implementados nem ativados.
