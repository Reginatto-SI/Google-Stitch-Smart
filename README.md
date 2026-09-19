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
