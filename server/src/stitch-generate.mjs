function screenIds(value) {
  const rows = Array.isArray(value) ? value : value?.screens;
  if (!Array.isArray(rows)) return [];
  return [...new Set(rows.map((screen) => screen?.screenId || screen?.id).filter(Boolean))];
}

export function isAmbiguousGenerationError(error) {
  const code = String(error?.code || error?.cause?.code || "").toUpperCase();
  const name = String(error?.name || error?.cause?.name || "").toLowerCase();
  const message = String(error?.message || "") + " " + String(error?.cause?.message || "");
  const normalizedMessage = message.toLowerCase();

  if (["NETWORK_ERROR", "ETIMEDOUT", "ECONNRESET", "ECONNABORTED", "UND_ERR_SOCKET"].includes(code)) {
    return true;
  }

  return (
    name.includes("timeout") ||
    name === "aborterror" ||
    /\b(timeout|timed out|request timed out|econnreset|etimedout|econnaborted|socket hang up|fetch failed)\b/.test(normalizedMessage) ||
    /connection (?:was )?(?:closed|reset|terminated|aborted)/.test(normalizedMessage)
  );
}

export async function reconcileGeneratedScreen({ projectId, screensBefore, listScreens }) {
  const beforeIds = screenIds(screensBefore);
  const current = await listScreens(projectId);
  const currentIds = screenIds(current);
  const beforeSet = new Set(beforeIds);
  const newScreenIds = currentIds.filter((id) => !beforeSet.has(id));

  if (newScreenIds.length === 1) {
    return {
      status: "completed_after_timeout",
      projectId,
      created: true,
      screenId: newScreenIds[0],
      retryGeneration: false,
      message: "A geração excedeu o tempo inicial de espera, mas a nova tela foi localizada no projeto.",
    };
  }

  if (newScreenIds.length > 1) {
    return {
      status: "generation_ambiguous",
      projectId,
      created: null,
      retryGeneration: false,
      screenIds: newScreenIds,
      message: "Mais de uma tela nova foi localizada após a operação demorada. Não foi possível determinar com segurança qual pertence a esta geração.",
    };
  }

  return {
    status: "generation_pending",
    projectId,
    created: null,
    retryGeneration: false,
    screensBefore: beforeIds,
    message: "A geração pode continuar em processamento. Consulte as telas do projeto antes de tentar gerar novamente.",
  };
}

export async function runGenerationFlow({ projectId, listScreens, generateScreen }) {
  const screensBefore = await listScreens(projectId);

  try {
    return await generateScreen();
  } catch (error) {
    if (!isAmbiguousGenerationError(error)) throw error;

    try {
      return await reconcileGeneratedScreen({ projectId, screensBefore, listScreens });
    } catch (reconciliationError) {
      return {
        status: "generation_pending",
        projectId,
        created: null,
        retryGeneration: false,
        screensBefore: screenIds(screensBefore),
        reconciliationError: reconciliationError?.message || String(reconciliationError),
        message: "A geração pode continuar em processamento, mas a reconciliação imediata das telas não pôde ser concluída. Consulte as telas do projeto antes de tentar gerar novamente.",
      };
    }
  }
}

export function formatGenerationResult(result) {
  if (result?.status) {
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }

  const { projectId, screenId, htmlUrl, imageUrl, imageContent, warning } = result;
  const payload = {
    projectId,
    screenId,
    htmlUrl,
    imageUrl,
    ...(warning ? { warning } : {}),
  };
  const content = [{
    type: "text",
    text: JSON.stringify(payload, null, 2),
  }];
  if (imageContent) content.push(imageContent);
  return { content };
}
