# Helpdesk Central — Frontend

Interface Angular standalone do Help Desk, construída com Angular Router, HttpClient, RxJS e Tailwind CSS 4.

## Executar

```bash
npm install
npm start
```

Abra `http://localhost:4200`. O backend deve estar disponível em `http://localhost:3000`.

## Ambientes

- `src/environments/environment.development.ts`: `http://localhost:3000/api`
- `src/environments/environment.ts`: `/api` para produção

Para outro endereço de desenvolvimento, altere somente o arquivo de ambiente; componentes não contêm URLs hardcoded.

## Rotas

| Rota           | Função                                              |
| -------------- | --------------------------------------------------- |
| `/tickets`     | Busca, filtros, tabela e paginação                  |
| `/tickets/:id` | Timeline, status, solicitante e resposta por e-mail |

## Build

```bash
npm run build
```

A saída é gravada em `dist/frontend`. Sirva o conteúdo por HTTPS e encaminhe `/api` ao backend Express.

## Design

Os tokens do design “Systematic Support” estão em `src/styles.css`. O projeto final não depende dos arquivos originais do Stitch. Funcionalidades ainda sem backend aparecem desabilitadas e com explicação no atributo `title`.
