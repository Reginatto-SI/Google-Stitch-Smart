function requireId(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} deve ser uma string não vazia`);
  }
  return value.trim();
}

export async function readProjects(stitch) {
  const projects = await stitch.projects();
  return {
    count: projects.length,
    projects: projects.map((project) => ({
      projectId: project.projectId,
      id: project.id,
    })),
  };
}

export async function readScreens(stitch, projectId) {
  const normalizedProjectId = requireId(projectId, "projectId");
  const screens = await stitch.project(normalizedProjectId).screens();
  return {
    projectId: normalizedProjectId,
    count: screens.length,
    screens: screens.map((screen) => ({
      screenId: screen.screenId,
      id: screen.id,
      projectId: screen.projectId,
    })),
  };
}

export async function readScreenContent(
  client,
  projectId,
  screenId,
  { includeImage = true, includeHtml = false } = {},
  { downloadImage, downloadText, maxHtmlChars = 60000 } = {}
) {
  const normalizedProjectId = requireId(projectId, "projectId");
  const normalizedScreenId = requireId(screenId, "screenId");

  // The current get_screen schema uses the canonical resource name.
  // projectId and screenId are retained only to build that resource name.
  const screen = await client.callTool("get_screen", {
    name: `projects/${normalizedProjectId}/screens/${normalizedScreenId}`,
  });

  const htmlUrl = screen?.htmlCode?.downloadUrl || "";
  const imageUrl = screen?.screenshot?.downloadUrl || "";

  const content = [{
    type: "text",
    text: JSON.stringify({
      projectId: normalizedProjectId,
      screenId: normalizedScreenId,
      name: screen?.name,
      title: screen?.title,
      width: screen?.width,
      height: screen?.height,
      deviceType: screen?.deviceType,
      htmlUrl,
      imageUrl,
    }, null, 2),
  }];

  if (includeImage && imageUrl) {
    if (typeof downloadImage !== "function") {
      throw new TypeError("downloadImage não configurado");
    }
    content.push(await downloadImage(imageUrl));
  }

  if (includeHtml && htmlUrl) {
    if (typeof downloadText !== "function") {
      throw new TypeError("downloadText não configurado");
    }
    const html = await downloadText(htmlUrl, maxHtmlChars);
    content.push({
      type: "text",
      text: `HTML da tela ${normalizedScreenId}${html.truncated ? ` (truncado em ${maxHtmlChars} caracteres de ${html.originalLength})` : ""}\n\n${html.text}`,
    });
  }

  return { content };
}
