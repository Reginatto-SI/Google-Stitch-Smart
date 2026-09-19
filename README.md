# Google Stitch Smart

Servidor MCP para conectar o ChatGPT ao Google Stitch, com camada de engenharia de prompt para criação, leitura, edição e revisão de telas.

## Deploy no Render

Use os seguintes valores ao criar um Web Service:

- Language: `Node`
- Branch: `main`
- Root Directory: `server`
- Build Command: `npm install`
- Start Command: `npm start`
- Plan: `Free`

Em **Environment Variables**, configure somente:

- `STITCH_API_KEY` = sua chave do Google Stitch

O Render fornece `PORT` automaticamente.

Após o deploy:

- Health: `https://SEU-SERVICO.onrender.com/health`
- MCP: `https://SEU-SERVICO.onrender.com/mcp`

No ChatGPT, crie o plugin usando a URL `/mcp` e, para o primeiro teste, use sem autenticação.

> Nunca coloque a `STITCH_API_KEY` no GitHub. O repositório contém apenas `.env.example`.

## v0.2.2 — correção de transporte

- Cada operação cria sua própria sessão `StitchToolClient` e a fecha ao terminar.
- Evita reutilização de transporte MCP do Stitch entre chamadas independentes.
- Mantém a API key somente nas variáveis de ambiente do Render.


## v0.2.6 — geração resiliente a timeout

- Antes de gerar, o plugin captura um snapshot dos `screenId` existentes.
- `stitch_generate_screen` executa somente uma geração e nunca faz retry cego.
- O timeout interno da geração é configurável por `STITCH_GENERATION_TIMEOUT_MS` (padrão: 45000 ms) para permitir que o servidor devolva um estado seguro antes de timeouts externos mais curtos.
- Em timeout/erro de conexão, o plugin abre uma nova sessão, lista as telas e compara IDs com o snapshot.
- Uma tela nova resulta em `completed_after_timeout`; nenhuma tela confirmada resulta em `generation_pending`; múltiplas telas novas resultam em `generation_ambiguous`.
- O SDK do Stitch foi fixado em `@google/stitch-sdk@0.3.5`, cuja ferramenta oficial de geração é síncrona e não expõe job/polling, request ID ou idempotency key.
- Um timeout continua sendo inconclusivo: antes de repetir uma geração, consulte as telas do projeto. O plugin não usa processamento detached, fire-and-forget ou timers em background.
