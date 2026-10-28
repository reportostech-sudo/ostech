import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server;
let origin;
let dataFile;
let temporaryDirectory;
let administratorToken;
let createServer;

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "os-technology-test-"));
  dataFile = join(temporaryDirectory, "private", "enquiries.jsonl");
  administratorToken = "test-administrator-token-long-enough-123456";
  process.env.DATA_FILE = dataFile;
  process.env.ADMIN_TOKEN = administratorToken;
  process.env.SITE_URL = "https://ostechnology.example";
  ({ createServer } = await import("../server.mjs"));
  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(temporaryDirectory, { recursive: true, force: true });
  delete process.env.DATA_FILE;
  delete process.env.ADMIN_TOKEN;
  delete process.env.SITE_URL;
});

test("serves crawlable company metadata, canonical URL, and structured data", async () => {
  const response = await fetch(origin);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /<title>OS Technology Nepal \| IT Hardware, Networking &amp; AMC Support<\/title>/);
  assert.match(html, /IT hardware sales/);
  assert.match(html, /<link rel="canonical" href="https:\/\/ostechnology\.example\/">/);
  const structuredData = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(structuredData);
  assert.equal(JSON.parse(structuredData[1])["@type"], "ComputerStore");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

test("serves robots policy and production sitemap", async () => {
  const [robots, sitemap] = await Promise.all([
    fetch(`${origin}/robots.txt`),
    fetch(`${origin}/sitemap.xml`),
  ]);
  assert.match(await robots.text(), /Sitemap: https:\/\/ostechnology\.example\/sitemap\.xml/);
  assert.match(await sitemap.text(), /<loc>https:\/\/ostechnology\.example\/<\/loc>/);
});

test("stores valid enquiries and only exposes them with the admin token", async () => {
  const enquiry = {
    name: "Test Visitor",
    email: "test@example.com",
    phone: "+977 9800000000",
    organization: "Example Clinic",
    sector: "Healthcare",
    service: "Annual maintenance contract",
    message: "We need an annual maintenance plan for our office IT equipment.",
    website: "",
  };
  const submitted = await fetch(`${origin}/api/enquiries`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(enquiry),
  });
  assert.equal(submitted.status, 201);
  const result = await submitted.json();
  assert.equal(result.received, true);
  assert.ok(result.id);

  const unauthorized = await fetch(`${origin}/api/enquiries`);
  assert.equal(unauthorized.status, 401);
  const authorized = await fetch(`${origin}/api/enquiries`, {
    headers: { Authorization: `Bearer ${administratorToken}` },
  });
  assert.equal(authorized.status, 200);
  const records = (await authorized.json()).enquiries;
  assert.equal(records.length, 1);
  assert.equal(records[0].id, result.id);
  assert.equal(records[0].email, enquiry.email);
  assert.ok(records[0].receivedAt);
  assert.match(await readFile(dataFile, "utf8"), /Example Clinic/);
});

test("rejects malformed, invalid, and cross-origin enquiries", async () => {
  const wrongOrigin = await fetch(`${origin}/api/enquiries`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
    body: "{}",
  });
  assert.equal(wrongOrigin.status, 403);

  const invalid = await fetch(`${origin}/api/enquiries`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ name: "A", email: "not-an-email" }),
  });
  assert.equal(invalid.status, 400);
});

test("serves the enquiry endpoint without disclosing records publicly", async () => {
  const response = await fetch(`${origin}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  const missingPage = await fetch(`${origin}/missing`);
  assert.equal(missingPage.status, 404);
});
