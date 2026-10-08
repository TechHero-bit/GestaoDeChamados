# Kanban do SmartDesk — implementação e homologação

## Inspeção realizada em 08/10/2026

- Repositório: `C:\Dev\GestaoDeChamados`, inicialmente limpo na branch `main`. Alterações locais em `feat/dashboard-kanban`.
- Angular standalone 22.1.3, Angular CLI/build 22.1.5, Tailwind 4, Express 4, validação Zod e Supabase somente pelo backend.
- API real: `PUT /api/tickets/:id`; não existe rota `/:id/status`. Toda a árvore tickets usa autenticação de sessão HttpOnly e rate limiting. ADMIN e AGENT já podem atualizar status; essa regra foi mantida.
- O esquema publicado pelo PostgREST foi consultado em modo somente leitura, sem consultar conteúdo dos tickets ou alterar o banco.
- `tickets.status`: enum Aberto / Em Andamento / Resolvido; `prioridade`: Baixa / Normal / Alta; `responsavel_id`: FK users; `data_atualizacao`: timestamptz.
- Não há coluna de prazo no esquema real. O cartão mostra a data de atualização, identificada como tal. Não foi inventado prazo nem criada coluna para isso.
- Há uma diferença anterior a esta mudança: a migration 001 não declara prioridade, embora ela exista no banco real e já seja usada pela aplicação. Antes de reconstruir o banco do zero, reconciliar o histórico de migrations com o schema; não aplicar DDL por suposição.

## Comportamento entregue

O dashboard abre na aba Quadro, com indicadores existentes acima. A aba Visão geral preserva chamados recentes e distribuição por status. A listagem completa permanece em /tickets, com seus filtros e detalhes.

| Coluna | Status persistido |
| --- | --- |
| A fazer | Aberto |
| Em curso | Em Andamento |
| Concluídos | Resolvido |

Os cartões exibem identificador, assunto com link para atendimento, prioridade, solicitante, responsável e data de atualização. O design usa os componentes e cores do SmartDesk, inspirado na organização da referência do Planner.

Mouse e touch usam a alça do cartão. No touch há atraso de 180 ms, evitando iniciar arraste acidentalmente. Colunas mostram destaque de destino e placeholder. O movimento tem animação e respeita prefers-reduced-motion. O seletor nativo Mover para permite a mesma operação por teclado e touch, com anúncio de sucesso/erro e restauração de foco.

Só transferências entre colunas persistem status. Ordenação manual dentro da mesma coluna não é persistida: os cartões seguem atualização mais recente e id como desempate. Voltar um resolvido para Aberto ou Em Andamento continua permitido, seguindo a regra atual da API.

## Consistência e falhas

1. Ao soltar, o cartão muda imediatamente e as contagens das colunas são ajustadas.
2. O Kanban envia apenas status e expected_data_atualizacao pelo serviço HTTP existente, com cookies e interceptor existentes.
3. O backend renova data_atualizacao explicitamente e aplica a comparação de versão na mesma instrução UPDATE. Assim, as escritas desta rota não dependem exclusivamente do trigger histórico para renovar a versão. Se outra escrita mudou a versão, responde 409 / TICKET_CONFLICT sem sobrescrever os dados.
4. Durante a gravação, o quadro bloqueia novas movimentações, filtros, atualização e carregamento adicional. A serialização é do quadro inteiro nesta primeira versão.
5. O retorno da API substitui os dados locais. O quadro reconsulta as páginas carregadas e os indicadores gerais são atualizados.
6. Em erro, cartão e contagens voltam ao snapshot anterior. Novas gravações ficam bloqueadas até Atualizar quadro ter sucesso. Isso cobre também uma falha de rede ocorrida depois de um possível commit.
7. Atualizações sem expected_data_atualizacao continuam aceitas para manter compatibilidade com os editores atuais. A proteção condicional cobre escritas do Kanban; outros clientes podem atualizar depois de uma gravação confirmada.
8. Alterações de outros usuários não aparecem em tempo real nesta etapa; Atualizar quadro reconcilia o estado. O controle de versão protege tentativas feitas a partir de uma visão antiga.

Cada coluna começa com 20 cartões e contagem total do banco. Carregar mais reconsulta todo o prefixo das páginas carregadas, elimina duplicatas por id e mantém o limite existente de até 100 por requisição. Após movimentar, a mesma reconsulta evita saltos causados pelo deslocamento dos offsets. Ainda não é um snapshot transacional de toda a fila: alterações externas simultâneas podem exigir nova atualização.

Busca por assunto/solicitante, prioridade e responsável são filtros no servidor, antes da paginação. Sem responsável é suportado; o dropdown de pessoas segue a lista atual de administradores ativos.

## Contratos incrementais

GET /api/tickets aceita adicionalmente:

- prioridade: Baixa, Normal ou Alta.
- responsavel_id: UUID ou none (IS NULL).
- sort: created (padrão anterior) ou updated (Kanban).

PUT /api/tickets/:id aceita adicionalmente:

```json
{
  "status": "Em Andamento",
  "expected_data_atualizacao": "2026-10-08T12:00:00.123456+00:00"
}
```

Preservar a string original de versão, inclusive precisão de microssegundos. Ela é condição de escrita; não é uma coluna nova nem um campo persistido.

## Dependências, banco e configuração

- Runtime novo: @angular/cdk 22.1.3, com peers compatíveis com Angular 22. O comportamento segue a [documentação oficial de drag-and-drop](https://angular.dev/guide/drag-drop).
- Desenvolvimento: @playwright/test 1.64.0, somente para testes de navegador com API simulada.
- package-lock.json da raiz atualizado; instalar a partir da raiz do monorepo com npm ci.
- Nenhuma migration necessária para o Kanban no esquema real inspecionado.
- Nenhuma variável de ambiente nova para o Kanban.
- Nenhuma migration, publicação Vercel, tarefa Planner ou alteração Power Automate foi executada.

## Executar e validar passo a passo

1. Na raiz: npm ci.
2. Rodar npm test para a suíte do backend e npm run test:uploads para a suíte atual do frontend (também inclui os testes de estado Kanban).
3. Rodar npm run build para validar Angular, templates e orçamento de produção.
4. Para apenas o estado do quadro: npm run test:kanban --workspace=Frontend.
5. Para navegador: npm run test:e2e --workspace=Frontend. O teste inicia o frontend em 127.0.0.1:4207 e simula TODOS os endpoints /api, incluindo autenticação. Não iniciar backend real para esse teste.
6. No Windows, os testes usam Edge instalado; em outros sistemas usam Chromium do Playwright. Instalar com npx playwright install chromium se necessário. PLAYWRIGHT_CHANNEL permite selecionar o canal disponível.
7. Para homologação real, configurar um Supabase separado com migrations/schema validados e backend apontando exclusivamente para esse ambiente. Iniciar backend e frontend conforme README. Nunca reutilizar credenciais de produção para gravações de teste.
8. Com ADMIN e AGENT de homologação, verificar drag-and-drop, teclado, touch, filtros, vários lotes de cartões, erro de rede, sessão expirada e duas janelas com o mesmo chamado.
9. Conferir também atendimento, mensagens, anexos, atribuição e assinatura antes de autorizar deploy.

Os nove testes de navegador cobrem transferência por mouse e gesto touch, teclado, bloqueio durante salvamento, rollback, conflito, persistência simulada após recarga, paginação, filtros, detalhes, descartes sem mudança e prévias desktop/móvel. Os testes de serviço usam banco em memória para a escrita condicional. A gravação ponta a ponta no Supabase de homologação continua necessária antes de publicação.

## Etapa seguinte

A [preparação da sincronização](planner-sync.md) contém política testável e rascunho SQL fora da pasta de migrations. A sincronização ainda não tem rotas, workers ou fluxos ativos.

## Resultado da verificação local

- Backend: 223 testes aprovados.
- Frontend: 18 testes aprovados.
- Navegador (Edge, API simulada): 9 testes aprovados.
- Build de produção Angular aprovado.
- Schema Supabase consultado somente para leitura de metadados; nenhum ticket real foi alterado durante os testes.
