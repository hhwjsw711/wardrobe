import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "vite";

const ITEM_ID = "import-11111111-1111-4111-8111-111111111111";
const TEST_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(check, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await delay(40);
  }
  throw new Error("Timed out waiting for test condition");
}

test("wardrobe edits and deletes persist for every client", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wardrobe-api-"));
  const importedDir = path.join(dataDir, "imported");
  const garmentFile = path.join(importedDir, `${ITEM_ID}-garment.png`);
  const modeledFile = path.join(importedDir, `${ITEM_ID}-modeled.png`);
  const libraryFile = path.join(dataDir, "library.json");
  const original = {
    id: ITEM_ID,
    name: "Blue shirt",
    part: "upperbody",
    color: "#224466",
    secondaryColor: null,
    palette: ["#224466"],
    tags: ["cotton"],
    image: `/api/import/library/${ITEM_ID}-garment.png`,
    thumbnail: `/api/import/library/${ITEM_ID}-garment.png`,
    modeledImage: `/api/import/library/${ITEM_ID}-modeled.png`,
    importJobId: ITEM_ID.slice("import-".length),
  };

  await mkdir(importedDir, { recursive: true });
  await writeFile(libraryFile, `${JSON.stringify([original], null, 2)}\n`);
  await writeFile(garmentFile, "garment");
  await writeFile(modeledFile, "modeled");
  process.env.WARDROBE_DATA_DIR = dataDir;

  const server = await createServer({
    optimizeDeps: { noDiscovery: true },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  context.after(async () => {
    await server.close();
    delete process.env.WARDROBE_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
  });

  const initialResponse = await fetch(`${baseUrl}/api/import/wardrobe`);
  assert.equal(initialResponse.status, 200);
  assert.deepEqual(await initialResponse.json(), [original]);

  const updateResponse = await fetch(`${baseUrl}/api/import/wardrobe/${ITEM_ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Indigo oxford shirt",
      part: "upperbody",
      color: "#1a365d",
      secondaryColor: "#f4f6f8",
      tags: ["Oxford", "button-down"],
    }),
  });
  assert.equal(updateResponse.status, 200);
  const updated = await updateResponse.json();
  assert.equal(updated.name, "Indigo oxford shirt");
  assert.deepEqual(updated.tags, ["oxford", "button-down"]);
  assert.deepEqual(updated.palette.slice(0, 2), ["#1a365d", "#f4f6f8"]);

  const stored = JSON.parse(await readFile(libraryFile, "utf8"));
  assert.deepEqual(stored, [updated]);

  const deleteResponse = await fetch(`${baseUrl}/api/import/wardrobe/${ITEM_ID}`, { method: "DELETE" });
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(JSON.parse(await readFile(libraryFile, "utf8")), []);
  await assert.rejects(readFile(garmentFile), { code: "ENOENT" });
  await assert.rejects(readFile(modeledFile), { code: "ENOENT" });
});

test("a client can save the private model reference photo", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wardrobe-reference-"));
  const referenceFile = path.join(dataDir, "model-reference.png");
  process.env.WARDROBE_DATA_DIR = dataDir;
  process.env.WARDROBE_MODEL_REFERENCE = referenceFile;
  process.env.OPENAI_API_KEY = "test-project-key";

  const server = await createServer({
    optimizeDeps: { noDiscovery: true },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  context.after(async () => {
    await server.close();
    delete process.env.WARDROBE_DATA_DIR;
    delete process.env.WARDROBE_MODEL_REFERENCE;
    delete process.env.OPENAI_API_KEY;
    await rm(dataDir, { recursive: true, force: true });
  });

  const initialResponse = await fetch(`${baseUrl}/api/import/config`);
  assert.equal(initialResponse.status, 200);
  assert.equal((await initialResponse.json()).hasModelReference, false);

  const referenceResponse = await fetch(`${baseUrl}/api/import/model-reference`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imageDataUrl: `data:image/png;base64,${TEST_PNG_BASE64}`,
    }),
  });
  assert.equal(referenceResponse.status, 200);
  const setup = await referenceResponse.json();
  assert.equal(setup.ready, true);
  assert.equal(setup.hasApiKey, true);
  assert.equal(setup.hasModelReference, true);

  const stored = await readFile(referenceFile);
  assert.equal(stored.subarray(1, 4).toString("ascii"), "PNG");
});

test("uploads become durable background jobs and deleted work cannot crash the service", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wardrobe-queue-"));
  const referenceFile = path.join(dataDir, "model-reference.png");
  await writeFile(referenceFile, Buffer.from(TEST_PNG_BASE64, "base64"));

  let startAnalysis;
  let finishAnalysis;
  let startImage;
  let finishImage;
  const analysisStarted = new Promise((resolve) => { startAnalysis = resolve; });
  const analysisGate = new Promise((resolve) => { finishAnalysis = resolve; });
  const imageStarted = new Promise((resolve) => { startImage = resolve; });
  const imageGate = new Promise((resolve) => { finishImage = resolve; });
  const openAI = createHttpServer((request, response) => {
    void (async () => {
      for await (const _chunk of request) { /* consume request */ }
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/responses") {
        startAnalysis();
        await analysisGate;
        response.end(JSON.stringify({
          output_text: JSON.stringify({
            items: [{
              name: "Test shirt",
              part: "upperbody",
              color: "#224466",
              secondaryColor: null,
              tags: ["test"],
              boundingBox: { x: 0, y: 0, width: 1000, height: 1000 },
            }],
          }),
        }));
        return;
      }
      if (request.url === "/images/edits") {
        startImage();
        await imageGate;
        response.end(JSON.stringify({ data: [{ b64_json: TEST_PNG_BASE64 }] }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { message: "Not found" } }));
    })().catch((error) => {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: { message: error.message } }));
    });
  });
  await new Promise((resolve) => openAI.listen(0, "127.0.0.1", resolve));
  const openAIAddress = openAI.address();

  process.env.WARDROBE_DATA_DIR = dataDir;
  process.env.WARDROBE_MODEL_REFERENCE = referenceFile;
  process.env.WARDROBE_IMPORT_CONCURRENCY = "1";
  process.env.OPENAI_API_KEY = "test-project-key";
  process.env.OPENAI_API_BASE_URL = `http://127.0.0.1:${openAIAddress.port}`;

  const server = await createServer({
    optimizeDeps: { noDiscovery: true },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  context.after(async () => {
    finishAnalysis();
    finishImage();
    await server.close();
    await new Promise((resolve) => openAI.close(resolve));
    delete process.env.WARDROBE_DATA_DIR;
    delete process.env.WARDROBE_MODEL_REFERENCE;
    delete process.env.WARDROBE_IMPORT_CONCURRENCY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_BASE_URL;
    await rm(dataDir, { recursive: true, force: true });
  });

  const uploadRequest = fetch(`${baseUrl}/api/import/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imageDataUrl: `data:image/png;base64,${TEST_PNG_BASE64}`,
      metadata: { name: "phone-photo" },
    }),
  });
  const uploadResponse = await Promise.race([
    uploadRequest,
    delay(1000).then(() => { throw new Error("Upload waited for OpenAI instead of entering the queue"); }),
  ]);
  assert.equal(uploadResponse.status, 202);
  const queuedUpload = (await uploadResponse.json()).jobs[0];
  assert.equal(queuedUpload.kind, "upload");
  assert.ok(["queued", "processing"].includes(queuedUpload.analysis.status));

  await analysisStarted;
  const whileAnalyzing = await (await fetch(`${baseUrl}/api/import/jobs`)).json();
  assert.equal(whileAnalyzing.length, 1);
  assert.equal(whileAnalyzing[0].kind, "upload");

  finishAnalysis();
  const garmentJob = await waitFor(async () => {
    const jobs = await (await fetch(`${baseUrl}/api/import/jobs`)).json();
    return jobs.find((job) => job.kind === "garment");
  });
  assert.equal(garmentJob.stages.crop.status, "review");

  const approveResponse = await fetch(`${baseUrl}/api/import/jobs/${garmentJob.id}/stages/crop/approve`, { method: "POST" });
  assert.equal(approveResponse.status, 200);
  await imageStarted;
  const deleteResponse = await fetch(`${baseUrl}/api/import/jobs/${garmentJob.id}`, { method: "DELETE" });
  assert.equal(deleteResponse.status, 200);
  finishImage();

  await delay(150);
  const healthResponse = await fetch(`${baseUrl}/api/import/config`);
  assert.equal(healthResponse.status, 200);
});

test("queued analysis resumes when the Wardrobe service restarts", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wardrobe-resume-"));
  const referenceFile = path.join(dataDir, "model-reference.png");
  const uploadId = "22222222-2222-4222-8222-222222222222";
  const uploadDir = path.join(dataDir, "jobs", uploadId);
  const originalFile = "original.png";
  await mkdir(uploadDir, { recursive: true });
  await writeFile(referenceFile, Buffer.from(TEST_PNG_BASE64, "base64"));
  await writeFile(path.join(uploadDir, originalFile), Buffer.from(TEST_PNG_BASE64, "base64"));
  await writeFile(path.join(uploadDir, "job.json"), `${JSON.stringify({
    id: uploadId,
    kind: "upload",
    status: "active",
    metadata: { name: "interrupted-phone-photo" },
    analysis: { status: "processing", attempts: 1, detectedCount: null, error: null, updatedAt: new Date().toISOString() },
    stages: {},
    originalAssetUrl: `/api/import/assets/${uploadId}/${originalFile}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    internal: { originalFile, originalMime: "image/png", sourceHash: "resume-test" },
  }, null, 2)}\n`);

  const openAI = createHttpServer((request, response) => {
    void (async () => {
      for await (const _chunk of request) { /* consume request */ }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ output_text: JSON.stringify({ items: [] }) }));
    })();
  });
  await new Promise((resolve) => openAI.listen(0, "127.0.0.1", resolve));
  const openAIAddress = openAI.address();

  process.env.WARDROBE_DATA_DIR = dataDir;
  process.env.WARDROBE_MODEL_REFERENCE = referenceFile;
  process.env.OPENAI_API_KEY = "test-project-key";
  process.env.OPENAI_API_BASE_URL = `http://127.0.0.1:${openAIAddress.port}`;

  const server = await createServer({
    optimizeDeps: { noDiscovery: true },
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  const address = server.httpServer.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  context.after(async () => {
    await server.close();
    await new Promise((resolve) => openAI.close(resolve));
    delete process.env.WARDROBE_DATA_DIR;
    delete process.env.WARDROBE_MODEL_REFERENCE;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_BASE_URL;
    await rm(dataDir, { recursive: true, force: true });
  });

  const resumed = await waitFor(async () => {
    const jobs = await (await fetch(`${baseUrl}/api/import/jobs`)).json();
    return jobs.find((job) => job.id === uploadId && job.analysis.status === "empty");
  });
  assert.equal(resumed.analysis.attempts, 2);
  assert.equal(resumed.analysis.detectedCount, 0);
});
