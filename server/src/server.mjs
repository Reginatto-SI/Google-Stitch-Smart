import "dotenv/config";
import { createServer as createHttpServer } from "node:http";
import { createHash } from "node:crypto";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { stitch } from "@google/stitch-sdk";
import * as z from "zod/v4";
import { PROMPT_POLICY } from "./prompt-policy.mjs";

const VERSION = "0.2.1";
const PORT = Number(process.env.PORT || 3000);
const MAX_HTML_CHARS = Number(process.env.MAX_HTML_CHARS || 60000);
const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN?.trim() || "";

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error) {
  return {
    isError: true,
    content: [{
      type: "text",
      text: JSON.stringify({
        error: true,
        name: error?.name || "Error",
        code: error?.code,
        message: error?.message || String(error),
        recoverable: error?.recoverable,
      }, null, 2),
    }],
  };
}

async function downloadText(url, maxChars = MAX_HTML_CHARS) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Falha ao baixar conteúdo (${response.status})`);
  const original = await response.text();
  return {
    text: original.slice(0, maxChars),
    truncated: original.length > maxChars,
    originalLength: original.length,
  };
}

async function downloadImage(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Falha ao baixar screenshot (${response.status})`);
  const mimeType = response.headers.get("content-type")?.split(";")[0] || "image/png";
  const data = Buffer.from(await response.arrayBuffer()).toString("base64");
  return { type: "image", data, mimeType };
}

async function fullText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Falha ao baixar HTML (${response.status})`);
  return response.text();
}

function hash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function screenInfo(screen) {
  return {
    screenId: screen.screenId,
    id: screen.id,
    projectId: screen.projectId,
  };
}

async function screenContent(projectId, screenId, { includeImage = true, includeHtml = false } = {}) {
  const project = stitch.project(projectId);
  const screen = await project.getScreen(screenId);
  const htmlUrl = await screen.getHtml();
  const imageUrl = await screen.getImage();

  const content = [{
    type: "text",
    text: JSON.stringify({ projectId, screenId, htmlUrl, imageUrl }, null, 2),
  }];

  if (includeImage && imageUrl) content.push(await downloadImage(imageUrl));

  if (includeHtml && htmlUrl) {
    const html = await downloadText(htmlUrl);
    content.push({
      type: "text",
      text: `HTML da tela ${screenId}${html.truncated ? ` (truncado em ${MAX_HTML_CHARS} caracteres de ${html.originalLength})` : ""}\n\n${html.text}`,
    });
  }

  return { content };
}

function buildServer() {
  const server = new McpServer(
    { name: "google-stitch-smart", version: VERSION },
    {
      instructions: [
        "Use este servidor para consultar e operar o Google Stitch.",
        "Antes de qualquer ação de escrita, refine internamente a solicitação do usuário usando a política retornada por stitch_prompt_policy.",
        "Priorize: instrução atual do usuário, PRD/documentação funcional fornecida, design system/Design.md, tela de referência e padrões existentes.",
        "Não invente regras de negócio, campos, permissões ou fluxos não solicitados.",
        "Em edição, altere apenas o que foi pedido e preserve todo o restante.",
        "Depois de gerar ou editar, analise a imagem retornada antes de afirmar que o resultado ficou correto.",
        "Não execute uma segunda alteração automaticamente sem novo pedido do usuário.",
      ].join(" "),
    }
  );

  server.registerTool(
    "stitch_health",
    {
      description: "Verifica se o conector está online e se uma credencial do Google Stitch foi configurada.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => textResult({
      ok: true,
      version: VERSION,
      stitchCredentialConfigured: Boolean(process.env.STITCH_API_KEY || process.env.STITCH_ACCESS_TOKEN),
    })
  );

  server.registerTool(
    "stitch_prompt_policy",
    {
      description: "Retorna as regras de engenharia de prompt que devem ser aplicadas antes de criar, editar ou gerar variantes no Stitch.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => textResult(PROMPT_POLICY)
  );

  server.registerTool(
    "stitch_list_projects",
    {
      description: "Lista os projetos Google Stitch acessíveis pela credencial configurada.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      try {
        const projects = await stitch.projects();
        return textResult({
          count: projects.length,
          projects: projects.map((p) => ({ projectId: p.projectId, id: p.id })),
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "stitch_create_project",
    {
      description: "Cria um novo projeto no Google Stitch. Use somente quando o usuário pedir explicitamente.",
      inputSchema: z.object({ title: z.string().min(1).max(200) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ title }) => {
      try {
        const project = await stitch.createProject(title);
        return textResult({ projectId: project.projectId, id: project.id, title });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "stitch_list_screens",
    {
      description: "Lista as telas existentes de um projeto Stitch.",
      inputSchema: z.object({ projectId: z.string().min(1) }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ projectId }) => {
      try {
        const screens = await stitch.project(projectId).screens();
        return textResult({
          projectId,
          count: screens.length,
          screens: await Promise.all(screens.map(screenInfo)),
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "stitch_get_screen",
    {
      description: "Obtém uma tela do Stitch. Pode retornar screenshot para análise visual e HTML opcional.",
      inputSchema: z.object({
        projectId: z.string().min(1),
        screenId: z.string().min(1),
        includeImage: z.boolean().default(true),
        includeHtml: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        return await screenContent(args.projectId, args.screenId, args);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "stitch_generate_screen",
    {
      description: "Gera uma nova tela em um projeto Stitch. O prompt deve estar refinado e coerente com o PRD/design system disponíveis.",
      inputSchema: z.object({
        projectId: z.string().min(1),
        prompt: z.string().min(1),
        deviceType: z.enum(["MOBILE", "DESKTOP", "TABLET", "AGNOSTIC"]).optional(),
        returnImage: z.boolean().default(true),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ projectId, prompt, deviceType, returnImage }) => {
      try {
        const project = stitch.project(projectId);
        const screen = await project.generate(prompt, deviceType);
        const htmlUrl = await screen.getHtml();
        const imageUrl = await screen.getImage();
        const content = [{
          type: "text",
          text: JSON.stringify({ projectId, screenId: screen.screenId, htmlUrl, imageUrl }, null, 2),
        }];
        if (returnImage && imageUrl) content.push(await downloadImage(imageUrl));
        return { content };
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "stitch_edit_screen",
    {
      description: "Edita uma tela existente. A alteração deve ser pontual; todo elemento não citado deve ser preservado.",
      inputSchema: z.object({
        projectId: z.string().min(1),
        screenId: z.string().min(1),
        prompt: z.string().min(1),
        deviceType: z.enum(["MOBILE", "DESKTOP", "TABLET", "AGNOSTIC"]).optional(),
        modelId: z.enum(["GEMINI_3_PRO", "GEMINI_3_FLASH"]).optional(),
        returnImage: z.boolean().default(true),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ projectId, screenId, prompt, deviceType, modelId, returnImage }) => {
      try {
        const source = await stitch.project(projectId).getScreen(screenId);
        const beforeHtmlUrl = await source.getHtml();
        const beforeHtml = await fullText(beforeHtmlUrl);
        const refinedPrompt = `${prompt.trim()}\n\n${PROMPT_POLICY.editPreservationClause}`;
        const edited = await source.edit(refinedPrompt, deviceType, modelId);
        const htmlUrl = await edited.getHtml();
        const imageUrl = await edited.getImage();

        let persistenceVerified = null;
        try {
          const afterHtml = await fullText(htmlUrl);
          persistenceVerified = hash(beforeHtml) !== hash(afterHtml);
        } catch {
          persistenceVerified = null;
        }

        const content = [{
          type: "text",
          text: JSON.stringify({
            projectId,
            sourceScreenId: screenId,
            resultScreenId: edited.screenId,
            htmlUrl,
            imageUrl,
            persistenceVerified,
            warning: persistenceVerified === false
              ? "O Stitch respondeu à edição, mas o HTML não mudou. Não considere a alteração aplicada sem revisão visual."
              : undefined,
          }, null, 2),
        }];
        if (returnImage && imageUrl) content.push(await downloadImage(imageUrl));
        return { ...(persistenceVerified === false ? { isError: true } : {}), content };
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "stitch_generate_variants",
    {
      description: "Gera variantes visuais de uma tela. Use apenas quando o usuário pedir alternativas ou exploração visual.",
      inputSchema: z.object({
        projectId: z.string().min(1),
        screenId: z.string().min(1),
        prompt: z.string().min(1),
        variantCount: z.number().int().min(1).max(5).default(3),
        creativeRange: z.enum(["REFINE", "EXPLORE", "REIMAGINE"]).default("EXPLORE"),
        aspects: z.array(z.enum(["LAYOUT", "COLOR_SCHEME", "IMAGES", "TEXT_FONT", "TEXT_CONTENT"])).optional(),
        returnImages: z.boolean().default(true),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ projectId, screenId, prompt, variantCount, creativeRange, aspects, returnImages }) => {
      try {
        const source = await stitch.project(projectId).getScreen(screenId);
        const variants = await source.variants(prompt, {
          variantCount,
          creativeRange,
          ...(aspects?.length ? { aspects } : {}),
        });
        const rows = [];
        for (const variant of variants) {
          rows.push({
            screenId: variant.screenId,
            htmlUrl: await variant.getHtml(),
            imageUrl: await variant.getImage(),
          });
        }
        const content = [{ type: "text", text: JSON.stringify({ projectId, sourceScreenId: screenId, variants: rows }, null, 2) }];
        if (returnImages) {
          for (const row of rows) {
            content.push({ type: "text", text: `VARIANTE screenId=${row.screenId}` });
            content.push(await downloadImage(row.imageUrl));
          }
        }
        return { content };
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  return server;
}

function authorized(req) {
  if (!MCP_BEARER_TOKEN) return true;
  return req.headers.authorization === `Bearer ${MCP_BEARER_TOKEN}`;
}

const handler = createMcpHandler(() => buildServer());
const nodeHandler = toNodeHandler(handler);

const httpServer = createHttpServer(async (req, res) => {
  try {
    const host = req.headers.host || "localhost";
    const url = new URL(req.url || "/", `http://${host}`);

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        service: "Google Stitch Smart MCP",
        version: VERSION,
        health: "/health",
        mcp: "/mcp",
      }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true,
        service: "google-stitch-smart",
        version: VERSION,
        stitchCredentialConfigured: Boolean(process.env.STITCH_API_KEY || process.env.STITCH_ACCESS_TOKEN),
      }));
      return;
    }

    if (url.pathname === "/mcp") {
      if (!authorized(req)) {
        res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      await nodeHandler(req, res);
      return;
    }

    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not_found" }));
  } catch (error) {
    console.error("[google-stitch-smart] HTTP error", error);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    if (!res.writableEnded) res.end(JSON.stringify({ error: "internal_server_error" }));
  }
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[google-stitch-smart] v${VERSION} listening on port ${PORT}`);
});
