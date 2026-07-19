import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "vite";

const ITEM_ID = "import-11111111-1111-4111-8111-111111111111";

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
      imageDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
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
