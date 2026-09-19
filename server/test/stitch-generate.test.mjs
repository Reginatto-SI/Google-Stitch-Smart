import test from "node:test";
import assert from "node:assert/strict";
import {
  formatGenerationResult,
  isAmbiguousGenerationError,
  runGenerationFlow,
} from "../src/stitch-generate.mjs";

const projectId = "12034049487696062869";
const oldScreens = {
  projectId,
  count: 2,
  screens: [{ screenId: "old-1" }, { screenId: "old-2" }],
};

function timeoutError() {
  return Object.assign(new Error("Request timed out after 45000ms"), { code: "UNKNOWN_ERROR" });
}

test("geração concluída preserva o retorno normal atual e executa generate uma única vez", async () => {
  let generateCalls = 0;
  let listCalls = 0;
  const normal = {
    projectId,
    screenId: "new-1",
    htmlUrl: "https://example.test/new.html",
    imageUrl: "https://example.test/new.png",
    imageContent: { type: "image", data: "base64", mimeType: "image/png" },
  };

  const result = await runGenerationFlow({
    projectId,
    listScreens: async () => {
      listCalls += 1;
      return oldScreens;
    },
    generateScreen: async () => {
      generateCalls += 1;
      return normal;
    },
  });

  assert.deepEqual(result, normal);
  assert.equal(generateCalls, 1);
  assert.equal(listCalls, 1);
  const formatted = formatGenerationResult(result);
  assert.equal(formatted.content.length, 2);
  assert.deepEqual(JSON.parse(formatted.content[0].text), {
    projectId,
    screenId: "new-1",
    htmlUrl: "https://example.test/new.html",
    imageUrl: "https://example.test/new.png",
  });
});

test("timeout sem nova tela retorna generation_pending e nunca faz retry cego", async () => {
  let generateCalls = 0;
  let listCalls = 0;
  const result = await runGenerationFlow({
    projectId,
    listScreens: async () => {
      listCalls += 1;
      return oldScreens;
    },
    generateScreen: async () => {
      generateCalls += 1;
      throw timeoutError();
    },
  });

  assert.equal(result.status, "generation_pending");
  assert.equal(result.created, null);
  assert.equal(result.retryGeneration, false);
  assert.deepEqual(result.screensBefore, ["old-1", "old-2"]);
  assert.equal(generateCalls, 1);
  assert.equal(listCalls, 2);
});

test("timeout seguido de uma nova tela retorna completed_after_timeout", async () => {
  let listCalls = 0;
  const result = await runGenerationFlow({
    projectId,
    listScreens: async () => {
      listCalls += 1;
      return listCalls === 1
        ? oldScreens
        : { ...oldScreens, count: 3, screens: [...oldScreens.screens, { screenId: "new-1" }] };
    },
    generateScreen: async () => { throw timeoutError(); },
  });

  assert.deepEqual(result, {
    status: "completed_after_timeout",
    projectId,
    created: true,
    screenId: "new-1",
    retryGeneration: false,
    message: "A geração excedeu o tempo inicial de espera, mas a nova tela foi localizada no projeto.",
  });
});

test("timeout seguido de múltiplas telas novas retorna situação ambígua com todos os IDs", async () => {
  let listCalls = 0;
  const result = await runGenerationFlow({
    projectId,
    listScreens: async () => {
      listCalls += 1;
      return listCalls === 1
        ? oldScreens
        : { screens: [...oldScreens.screens, { screenId: "new-a" }, { screenId: "new-b" }] };
    },
    generateScreen: async () => { throw timeoutError(); },
  });

  assert.equal(result.status, "generation_ambiguous");
  assert.equal(result.created, null);
  assert.equal(result.retryGeneration, false);
  assert.deepEqual(result.screenIds, ["new-a", "new-b"]);
});

test("erro definitivo da API continua sendo propagado como falha", async () => {
  let generateCalls = 0;
  let listCalls = 0;
  const definitive = Object.assign(new Error("Permission denied"), { code: "PERMISSION_DENIED" });

  await assert.rejects(
    () => runGenerationFlow({
      projectId,
      listScreens: async () => {
        listCalls += 1;
        return oldScreens;
      },
      generateScreen: async () => {
        generateCalls += 1;
        throw definitive;
      },
    }),
    (error) => error === definitive
  );

  assert.equal(generateCalls, 1);
  assert.equal(listCalls, 1);
});

test("classificação de erro ambíguo cobre timeout/rede sem classificar erro definitivo", () => {
  assert.equal(isAmbiguousGenerationError(timeoutError()), true);
  assert.equal(isAmbiguousGenerationError({ code: "NETWORK_ERROR", message: "fetch failed" }), true);
  assert.equal(isAmbiguousGenerationError({ name: "AbortError", message: "aborted" }), true);
  assert.equal(isAmbiguousGenerationError({ code: "VALIDATION_ERROR", message: "invalid prompt" }), false);
});
