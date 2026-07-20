import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import test from "node:test";
import { createServer } from "vite";

const ITEM_ID = "import-11111111-1111-4111-8111-111111111111";
const TEST_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const TEST_GARMENT = await sharp({ create: { width: 24, height: 32, channels: 4, background: "#cc2222" } }).png().toBuffer();
const TEST_GARMENT_RESULT = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#00ffff" } })
  .composite([{ input: TEST_GARMENT, left: 20, top: 16 }])
  .png()
  .toBuffer();
const TEST_REFERENCE_TWO = await sharp({ create: { width: 3, height: 4, channels: 3, background: "#805060" } }).png().toBuffer();

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

test("a client can save several private styling reference photos", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wardrobe-reference-"));
  const referenceFile = path.join(dataDir, "model-reference.png");
  const referencesDir = path.join(dataDir, "model-references");
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
      imageDataUrls: [
        `data:image/png;base64,${TEST_PNG_BASE64}`,
        `data:image/png;base64,${TEST_REFERENCE_TWO.toString("base64")}`,
      ],
    }),
  });
  assert.equal(referenceResponse.status, 200);
  const setup = await referenceResponse.json();
  assert.equal(setup.ready, true);
  assert.equal(setup.hasApiKey, true);
  assert.equal(setup.hasModelReference, true);
  assert.equal(setup.modelReferenceCount, 2);
  assert.equal(setup.addedModelReferenceCount, 2);

  const storedReferences = await readdir(referencesDir);
  assert.equal(storedReferences.length, 2);
  const stored = await readFile(path.join(referencesDir, storedReferences[0]));
  assert.equal(stored.subarray(1, 4).toString("ascii"), "PNG");
});

test("an existing wardrobe piece can be matched to a sourced product", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wardrobe-product-"));
  const importedDir = path.join(dataDir, "imported");
  const libraryFile = path.join(dataDir, "library.json");
  const item = {
    id: ITEM_ID,
    name: "red athletic shorts",
    part: "lowerbody",
    color: "#aa2222",
    secondaryColor: null,
    palette: ["#aa2222"],
    tags: ["athletic", "logo"],
    image: `/api/import/library/${ITEM_ID}-garment.png`,
    thumbnail: `/api/import/library/${ITEM_ID}-garment.png`,
    modeledImage: null,
    importJobId: ITEM_ID.slice("import-".length),
  };
  await mkdir(importedDir, { recursive: true });
  await writeFile(path.join(importedDir, `${ITEM_ID}-garment.png`), TEST_GARMENT);
  await writeFile(libraryFile, `${JSON.stringify([item], null, 2)}\n`);

  const productUrl = "https://shop.lululemon.com/p/men-shorts/Pace-Breaker-Short-7-Linerless/";
  const openAI = createHttpServer((request, response) => {
    void (async () => {
      for await (const _chunk of request) { /* consume request */ }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        output_text: JSON.stringify({
          brand: "Lululemon",
          productName: "Pace Breaker Linerless Short 7\"",
          colorway: "Dark Red",
          confidence: "exact",
          identifyingFeatures: ["curved side panel", "zippered pocket"],
          summary: "The visible panel geometry matches the sourced product.",
          sourceUrl: productUrl,
          sourceTitle: "Pace Breaker Linerless Short 7\"",
        }),
        output: [{ type: "web_search_call", action: { sources: [{ url: productUrl, title: "Pace Breaker Linerless Short 7\"" }] } }],
      }));
    })();
  });
  await new Promise((resolve) => openAI.listen(0, "127.0.0.1", resolve));
  const openAIAddress = openAI.address();
  process.env.WARDROBE_DATA_DIR = dataDir;
  process.env.OPENAI_API_KEY = "test-project-key";
  process.env.OPENAI_API_BASE_URL = `http://127.0.0.1:${openAIAddress.port}`;

  const server = await createServer({ optimizeDeps: { noDiscovery: true }, server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const address = server.httpServer.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  context.after(async () => {
    await server.close();
    await new Promise((resolve) => openAI.close(resolve));
    delete process.env.WARDROBE_DATA_DIR;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_BASE_URL;
    await rm(dataDir, { recursive: true, force: true });
  });

  const response = await fetch(`${baseUrl}/api/import/wardrobe/${ITEM_ID}/product-match`, { method: "POST" });
  assert.equal(response.status, 200);
  const matched = await response.json();
  assert.equal(matched.name, "Lululemon Pace Breaker Linerless Short 7\"");
  assert.equal(matched.productConfidence, "exact");
  assert.equal(matched.productUrl, productUrl);
  assert.deepEqual(JSON.parse(await readFile(libraryFile, "utf8")), [matched]);
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
  assert.equal(queuedUpload.autoProcess, true);
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
  assert.equal(garmentJob.autoProcess, true);
  assert.equal(garmentJob.stages.crop.status, "approved");
  await imageStarted;
  const deleteResponse = await fetch(`${baseUrl}/api/import/jobs/${garmentJob.id}`, { method: "DELETE" });
  assert.equal(deleteResponse.status, 200);
  finishImage();

  await delay(150);
  const healthResponse = await fetch(`${baseUrl}/api/import/config`);
  assert.equal(healthResponse.status, 200);
});

test("new uploads automatically finish and enter the wardrobe", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "wardrobe-auto-"));
  const referenceFile = path.join(dataDir, "model-reference.png");
  const referencesDir = path.join(dataDir, "model-references");
  await mkdir(referencesDir, { recursive: true });
  await writeFile(referenceFile, Buffer.from(TEST_PNG_BASE64, "base64"));
  await writeFile(path.join(referencesDir, "second.png"), TEST_REFERENCE_TWO);
  let imageRequests = 0;
  let modeledImageInputCount = 0;
  let productSearchRequests = 0;

  const openAI = createHttpServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const requestBody = Buffer.concat(chunks);
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/responses") {
        const payload = JSON.parse(requestBody.toString("utf8"));
        if (payload.tools?.some((tool) => tool.type === "web_search")) {
          productSearchRequests += 1;
          response.end(JSON.stringify({
            output_text: JSON.stringify({
              brand: "Lululemon",
              productName: "Pace Breaker Linerless Short 7\"",
              colorway: "Dark Red",
              confidence: "exact",
              identifyingFeatures: ["curved side panels", "zippered side pocket", "seven-inch inseam"],
              summary: "The visible panels and pocket placement match the sourced product.",
              sourceUrl: "https://shop.lululemon.com/p/men-shorts/Pace-Breaker-Short-7-Linerless/",
              sourceTitle: "Pace Breaker Linerless Short 7\"",
            }),
            output: [{
              type: "web_search_call",
              action: { sources: [{ url: "https://shop.lululemon.com/p/men-shorts/Pace-Breaker-Short-7-Linerless/", title: "Pace Breaker Linerless Short 7\"" }] },
            }],
          }));
          return;
        }
        response.end(JSON.stringify({
          output_text: JSON.stringify({
            items: [{
              name: "Automatic red shorts",
              part: "lowerbody",
              color: "#cc2222",
              secondaryColor: null,
              tags: ["automatic"],
              boundingBox: { x: 0, y: 0, width: 1000, height: 1000 },
            }],
          }),
        }));
        return;
      }
      if (request.url === "/images/edits") {
        imageRequests += 1;
        if (imageRequests === 2) modeledImageInputCount = (requestBody.toString("latin1").match(/name="image\[\]"/g) || []).length;
        response.end(JSON.stringify({ data: [{ b64_json: TEST_GARMENT_RESULT.toString("base64") }] }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { message: "Not found" } }));
    })();
  });
  await new Promise((resolve) => openAI.listen(0, "127.0.0.1", resolve));
  const openAIAddress = openAI.address();

  process.env.WARDROBE_DATA_DIR = dataDir;
  process.env.WARDROBE_MODEL_REFERENCE = referenceFile;
  process.env.WARDROBE_MODEL_REFERENCES_DIR = referencesDir;
  process.env.WARDROBE_IMPORT_CONCURRENCY = "2";
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
    delete process.env.WARDROBE_MODEL_REFERENCES_DIR;
    delete process.env.WARDROBE_IMPORT_CONCURRENCY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_BASE_URL;
    await rm(dataDir, { recursive: true, force: true });
  });

  const uploadResponse = await fetch(`${baseUrl}/api/import/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      imageDataUrl: `data:image/png;base64,${TEST_PNG_BASE64}`,
      autoProcess: true,
      metadata: { name: "automatic-phone-photo" },
    }),
  });
  assert.equal(uploadResponse.status, 202);

  const imported = await waitFor(async () => {
    const items = await (await fetch(`${baseUrl}/api/import/wardrobe`)).json();
    return items.find((item) => item.productName === "Pace Breaker Linerless Short 7\"" && item.modeledImage);
  }, 5000);
  assert.equal(imported.part, "lowerbody");
  assert.equal(imported.name, "Lululemon Pace Breaker Linerless Short 7\"");
  assert.equal(imported.productConfidence, "exact");
  assert.equal(imported.productUrl, "https://shop.lululemon.com/p/men-shorts/Pace-Breaker-Short-7-Linerless/");
  assert.equal(productSearchRequests, 1);
  assert.equal(imageRequests, 2);
  assert.equal(modeledImageInputCount, 3);
  assert.equal((await readFile(path.join(dataDir, "imported", `${imported.id}-source.png`))).subarray(1, 4).toString("ascii"), "PNG");

  const remainingJobs = await (await fetch(`${baseUrl}/api/import/jobs`)).json();
  assert.equal(remainingJobs.length, 0);
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
