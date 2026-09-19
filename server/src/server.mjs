import "dotenv/config";
import { createServer as createHttpServer } from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { Stitch, StitchToolClient } from "@google/stitch-sdk";
import * as z from "zod/v4";
import { PROMPT_POLICY } from "./prompt-policy.mjs";
import { readProjects, readScreens, readScreenContent } from "./stitch-read.mjs";
import { formatGenerationResult, runGenerationFlow } from "./stitch-generate.mjs";

const VERSION = "0.2.6";
const PORT = Number(process.env.PORT || 3000);
const MAX_HTML_CHARS = Number(process.env.MAX_HTML_CHARS || 60000);
const configuredGenerationTimeout = Number(process.env.STITCH_GENERATION_TIMEOUT_MS || 45000);
const STITCH_GENERATION_TIMEOUT_MS = Number.isFinite(configuredGenerationTimeout) && configuredGenerationTimeout >= 5000
  ? configuredGenerationTimeout
  : 45000;
const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN?.trim() || "";
const GOOGLE_OAUTH_SCOPE = "https://www.googleapis.com/auth/aida";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

let cachedOAuthToken = {
  accessToken: "",
  expiresAt: 0,
};

function oauthConfig() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID?.trim() || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() || "",
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN?.trim() || "",
    projectId: process.env.GOOGLE_CLOUD_PROJECT?.trim() || "",
  };
}

function authStatus() {
  const oauth = oauthConfig();
  const hasOAuthBase = Boolean(oauth.clientId && oauth.clientSecret && oauth.projectId);
  const hasRefreshOAuth = Boolean(hasOAuthBase && oauth.refreshToken);
  const hasStaticAccessToken = Boolean(
    process.env.STITCH_ACCESS_TOKEN?.trim() && oauth.projectId
  );
  const hasApiKey = Boolean(process.env.STITCH_API_KEY?.trim());

  return {
    configured: hasRefreshOAuth || hasStaticAccessToken || hasApiKey,
    mode: hasRefreshOAuth
      ? "oauth_refresh_token"
      : hasStaticAccessToken
        ? "static_access_token"
        : hasApiKey
          ? "api_key"
          : "none",
    oauthReadyForAuthorization: hasOAuthBase,
    oauthRefreshTokenConfigured: Boolean(oauth.refreshToken),
    googleCloudProjectConfigured: Boolean(oauth.projectId),
    scope: GOOGLE_OAUTH_SCOPE,
  };
}

function oauthStateSecret() {
  const { clientSecret } = oauthConfig();
  if (!clientSecret) throw new Error("GOOGLE_CLIENT_SECRET não configurado");
  return clientSecret;
}

function createOAuthState() {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + 10 * 60 * 1000 }),
    "utf8"
  ).toString("base64url");
  const signature = createHmac("sha256", oauthStateSecret())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function verifyOAuthState(state) {
  if (!state || !state.includes(".")) return false;
  const [payload, signature] = state.split(".", 2);
  const expected = createHmac("sha256", oauthStateSecret())
    .update(payload)
    .digest("base64url");

  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  if (!timingSafeEqual(actualBuffer, expectedBuffer)) return false;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number(parsed.exp) > Date.now();
  } catch {
    return false;
  }
}

function externalOrigin(req) {
  const proto =
    req.headers["x-forwarded-proto"]?.toString().split(",")[0]?.trim() ||
    (req.socket.encrypted ? "https" : "http");
  const host =
    req.headers["x-forwarded-host"]?.toString().split(",")[0]?.trim() ||
    req.headers.host ||
    "localhost";
  return `${proto}://${host}`;
}

function oauthRedirectUri(req) {
  return (
    process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim() ||
    `${externalOrigin(req)}/oauth/callback`
  );
}

async function tokenRequest(params) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.error_description || body.error || `HTTP ${response.status}`;
    throw new Error(`Falha OAuth Google: ${detail}`);
  }
  return body;
}

async function refreshGoogleAccessToken() {
  const { clientId, clientSecret, refreshToken, projectId } = oauthConfig();

  if (!clientId || !clientSecret || !refreshToken || !projectId) {
    throw new Error(
      "OAuth incompleto. Configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN e GOOGLE_CLOUD_PROJECT."
    );
  }

  const now = Date.now();
  if (
    cachedOAuthToken.accessToken &&
    cachedOAuthToken.expiresAt > now + 60_000
  ) {
    return cachedOAuthToken.accessToken;
  }

  const token = await tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  if (!token.access_token) {
    throw new Error("Google OAuth não retornou access_token");
  }

  cachedOAuthToken = {
    accessToken: token.access_token,
    expiresAt: now + Number(token.expires_in || 3600) * 1000,
  };

  return cachedOAuthToken.accessToken;
}

async function createStitchSession({ timeout } = {}) {
  const status = authStatus();
  const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim() || "";
  const timeoutOptions = Number.isFinite(timeout) ? { timeout } : {};

  let client;

  if (status.mode === "oauth_refresh_token") {
    const accessToken = await refreshGoogleAccessToken();
    client = new StitchToolClient({ accessToken, projectId, ...timeoutOptions });
  } else if (status.mode === "static_access_token") {
    client = new StitchToolClient({
      accessToken: process.env.STITCH_ACCESS_TOKEN.trim(),
      projectId,
      ...timeoutOptions,
    });
  } else if (status.mode === "api_key") {
    client = new StitchToolClient({
      apiKey: process.env.STITCH_API_KEY.trim(),
      ...timeoutOptions,
    });
  } else {
    throw new Error(
      "Nenhuma credencial Stitch configurada. Configure OAuth renovável no Render."
    );
  }

  return { client, stitch: new Stitch(client) };
}

async function withStitchSession(operation, options) {
  const { client, stitch } = await createStitchSession(options);
  try {
    return await operation(stitch, client);
  } finally {
    try {
      await client.close();
    } catch (closeError) {
      console.warn(
        "[google-stitch-smart] falha ao fechar sessão Stitch",
        closeError?.message || closeError
      );
    }
  }
}

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
        "Em stitch_generate_screen, timeout ou erro de conexão é inconclusivo: não repita a geração automaticamente; liste e reconcilie as telas antes de qualquer nova tentativa.",
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
      stitchCredentialConfigured: authStatus().configured,
      auth: authStatus(),
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
        return await withStitchSession(async (stitch) =>
          textResult(await readProjects(stitch))
        );
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
        return await withStitchSession(async (stitch) => {
          const project = await stitch.createProject(title);
          return textResult({ projectId: project.projectId, id: project.id, title });
        });
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
        return await withStitchSession(async (stitch) =>
          textResult(await readScreens(stitch, projectId))
        );
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
        return await withStitchSession((_stitch, client) =>
          readScreenContent(
            client,
            args.projectId,
            args.screenId,
            args,
            { downloadImage, downloadText, maxHtmlChars: MAX_HTML_CHARS }
          )
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "stitch_generate_screen",
    {
      description: "Gera uma nova tela em um projeto Stitch. Operações podem levar minutos. Timeout ou erro de conexão não significa falha definitiva: não repita a geração imediatamente. O retorno pode indicar completed_after_timeout, generation_pending ou generation_ambiguous; nesses casos consulte/reconcilie as telas antes de nova tentativa.",
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
        const result = await runGenerationFlow({
          projectId,
          listScreens: (targetProjectId) =>
            withStitchSession(async (stitch) =>
              readScreens(stitch, targetProjectId)
            ),
          generateScreen: () =>
            withStitchSession(async (stitch) => {
              const project = stitch.project(projectId);
              const screen = await project.generate(prompt, deviceType);
              let htmlUrl = "";
              let imageUrl = "";
              let imageContent;
              const warnings = [];

              try {
                htmlUrl = await screen.getHtml();
              } catch (assetError) {
                warnings.push(`HTML não pôde ser obtido após a criação: ${assetError?.message || assetError}`);
              }

              try {
                imageUrl = await screen.getImage();
              } catch (assetError) {
                warnings.push(`Screenshot não pôde ser obtido após a criação: ${assetError?.message || assetError}`);
              }

              if (returnImage && imageUrl) {
                try {
                  imageContent = await downloadImage(imageUrl);
                } catch (assetError) {
                  warnings.push(`Screenshot foi criada, mas não pôde ser baixada pelo plugin: ${assetError?.message || assetError}`);
                }
              }

              return {
                projectId,
                screenId: screen.screenId,
                htmlUrl,
                imageUrl,
                imageContent,
                ...(warnings.length ? {
                  warning: `A tela foi criada, porém houve falha ao obter alguns artefatos. ${warnings.join(" ")}`,
                } : {}),
              };
            }, { timeout: STITCH_GENERATION_TIMEOUT_MS }),
        });

        return formatGenerationResult(result);
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
        return await withStitchSession(async (stitch) => {
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
        });
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
        return await withStitchSession(async (stitch) => {
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
        });
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
        oauthStart: "/oauth/start",
        oauthCallback: "/oauth/callback",
      }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true,
        service: "google-stitch-smart",
        version: VERSION,
        stitchCredentialConfigured: authStatus().configured,
        auth: authStatus(),
      }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/oauth/start") {
      const { clientId, clientSecret, projectId } = oauthConfig();
      if (!clientId || !clientSecret || !projectId) {
        res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          error: "oauth_not_configured",
          message: "Configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_CLOUD_PROJECT no Render antes de iniciar o OAuth.",
          redirectUri: oauthRedirectUri(req),
          requiredScope: GOOGLE_OAUTH_SCOPE,
        }));
        return;
      }

      const authorizationUrl = new URL(GOOGLE_AUTH_URL);
      authorizationUrl.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: oauthRedirectUri(req),
        response_type: "code",
        scope: GOOGLE_OAUTH_SCOPE,
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state: createOAuthState(),
      }).toString();

      res.writeHead(302, { location: authorizationUrl.toString() });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/oauth/callback") {
      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          error: "oauth_denied",
          detail: oauthError,
        }));
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (!code || !verifyOAuthState(state)) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          error: "invalid_oauth_callback",
          message: "Código OAuth ausente ou state inválido/expirado. Reinicie em /oauth/start.",
        }));
        return;
      }

      const { clientId, clientSecret } = oauthConfig();
      const token = await tokenRequest({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: oauthRedirectUri(req),
        grant_type: "authorization_code",
      });

      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        pragma: "no-cache",
      });
      res.end(JSON.stringify({
        ok: true,
        message: token.refresh_token
          ? "OAuth concluído. Copie GOOGLE_REFRESH_TOKEN para as Environment Variables do Render e faça novo deploy."
          : "OAuth concluído, mas o Google não retornou refresh_token. Revogue o consentimento anterior ou reinicie /oauth/start; o fluxo já usa prompt=consent.",
        GOOGLE_REFRESH_TOKEN: token.refresh_token || null,
        scope: token.scope || GOOGLE_OAUTH_SCOPE,
        expiresIn: token.expires_in || null,
        tokenType: token.token_type || null,
        important: "Não coloque este refresh token no GitHub nem compartilhe publicamente.",
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
