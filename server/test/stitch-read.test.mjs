import test from "node:test";
import assert from "node:assert/strict";
import {
  readProjects,
  readScreens,
  readScreenContent,
} from "../src/stitch-read.mjs";

test("readProjects preserva o contrato de list_projects", async () => {
  const result = await readProjects({
    projects: async () => [
      { projectId: "123", id: "123" },
      { projectId: "456", id: "456" },
    ],
  });

  assert.deepEqual(result, {
    count: 2,
    projects: [
      { projectId: "123", id: "123" },
      { projectId: "456", id: "456" },
    ],
  });
});

test("readScreens preserva o contrato de list_screens", async () => {
  const stitch = {
    project(projectId) {
      assert.equal(projectId, "12034049487696062869");
      return {
        screens: async () => [{
          screenId: "8201923b79164cc4b4297aafdb4dd30c",
          id: "8201923b79164cc4b4297aafdb4dd30c",
          projectId,
        }],
      };
    },
  };

  const result = await readScreens(stitch, "12034049487696062869");
  assert.equal(result.count, 1);
  assert.equal(result.screens[0].screenId, "8201923b79164cc4b4297aafdb4dd30c");
});

test("readScreenContent usa callTool get_screen com resource name canônico", async () => {
  const calls = [];
  const client = {
    async callTool(name, args) {
      calls.push({ name, args });
      return {
        name: "projects/12034049487696062869/screens/8201923b79164cc4b4297aafdb4dd30c",
        title: "Dashboard",
        width: "1440",
        height: "1024",
        deviceType: "DESKTOP",
        screenshot: { downloadUrl: "https://example.test/screen.png" },
        htmlCode: { downloadUrl: "https://example.test/screen.html" },
      };
    },
  };

  const result = await readScreenContent(
    client,
    "12034049487696062869",
    "8201923b79164cc4b4297aafdb4dd30c",
    { includeImage: false, includeHtml: false }
  );

  assert.deepEqual(calls, [{
    name: "get_screen",
    args: {
      name: "projects/12034049487696062869/screens/8201923b79164cc4b4297aafdb4dd30c",
    },
  }]);
  assert.equal(result.content.length, 1);
  const metadata = JSON.parse(result.content[0].text);
  assert.equal(metadata.title, "Dashboard");
  assert.equal(metadata.imageUrl, "https://example.test/screen.png");
  assert.equal(metadata.htmlUrl, "https://example.test/screen.html");
});

test("includeImage adiciona screenshot e includeHtml adiciona HTML", async () => {
  const client = {
    async callTool() {
      return {
        screenshot: { downloadUrl: "https://example.test/screen.png" },
        htmlCode: { downloadUrl: "https://example.test/screen.html" },
      };
    },
  };
  const downloaded = [];

  const result = await readScreenContent(
    client,
    "123",
    "abc",
    { includeImage: true, includeHtml: true },
    {
      downloadImage: async (url) => {
        downloaded.push(["image", url]);
        return { type: "image", data: "base64", mimeType: "image/png" };
      },
      downloadText: async (url, maxChars) => {
        downloaded.push(["html", url, maxChars]);
        return { text: "<html></html>", truncated: false, originalLength: 13 };
      },
      maxHtmlChars: 1000,
    }
  );

  assert.deepEqual(downloaded, [
    ["image", "https://example.test/screen.png"],
    ["html", "https://example.test/screen.html", 1000],
  ]);
  assert.equal(result.content[1].type, "image");
  assert.match(result.content[2].text, /<html><\/html>/);
});

test("IDs inválidos são rejeitados antes de chamar o SDK", async () => {
  let called = false;
  const client = {
    async callTool() {
      called = true;
      return {};
    },
  };

  await assert.rejects(
    () => readScreenContent(client, " ", "abc", { includeImage: false }),
    /projectId/
  );
  await assert.rejects(
    () => readScreenContent(client, "123", "", { includeImage: false }),
    /screenId/
  );
  assert.equal(called, false);
});
