import { createServer as createHttpServer } from "node:http";
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";

const root = dirname(fileURLToPath(import.meta.url));
const publicFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
]);
const services = new Set([
  "IT hardware sales",
  "Server setup and configuration",
  "Network planning and solutions",
  "Telephony solutions",
  "Technical training",
  "Annual maintenance contract",
  "Other IT services",
]);
const sectors = new Set(["Healthcare", "Hospitality", "Commercial", "Other"]);
const maxBodyBytes = 16 * 1024;
const rateWindowMs = 15 * 60 * 1000;
const rateLimit = 5;
const clients = new Map();
const pruneInterval = setInterval(() => {
  const cutoff = Date.now() - rateWindowMs;
  for (const [ip, timestamps] of clients) {
    const current = timestamps.filter((timestamp) => timestamp > cutoff);
    if (current.length) clients.set(ip, current);
    else clients.delete(ip);
  }
}, rateWindowMs);
pruneInterval.unref();

const dataFile = process.env.DATA_FILE || join(root, "data", "enquiries.jsonl");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const isProduction = process.env.NODE_ENV === "production";

function getSiteUrl() {
  const configured = process.env.SITE_URL;
  if (!configured && isProduction) {
    throw new Error("SITE_URL must be set to the canonical HTTPS website URL in production.");
  }

  const siteUrl = new URL(configured || `http://localhost:${port}`);
  if (!["http:", "https:"].includes(siteUrl.protocol) || siteUrl.pathname !== "/" || siteUrl.search || siteUrl.hash) {
    throw new Error("SITE_URL must be an origin such as https://ostechnology.example.");
  }
  if (isProduction && siteUrl.protocol !== "https:") {
    throw new Error("SITE_URL must use HTTPS in production.");
  }
  return siteUrl.origin;
}

function assertProductionConfiguration() {
  getSiteUrl();
  if (isProduction && (!process.env.ADMIN_TOKEN || process.env.ADMIN_TOKEN.length < 32)) {
    throw new Error("Set ADMIN_TOKEN to a random secret of at least 32 characters in production.");
  }
}

function securityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'");
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function allowSameOrigin(request) {
  const origin = request.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== request.headers.host?.toLowerCase()) return false;
    } catch {
      return false;
    }
  }
  return request.headers["sec-fetch-site"] !== "cross-site";
}

function takeRateLimit(request, now = Date.now()) {
  const ip = request.socket.remoteAddress || "unknown";
  const recent = (clients.get(ip) || []).filter((timestamp) => timestamp > now - rateWindowMs);
  if (recent.length >= rateLimit) {
    clients.set(ip, recent);
    return false;
  }
  recent.push(now);
  clients.set(ip, recent);
  return true;
}

async function readJsonBody(request) {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    const error = new Error("Send the enquiry as JSON.");
    error.status = 415;
    throw error;
  }

  const declaredLength = Number(request.headers["content-length"] || 0);
  if (declaredLength > maxBodyBytes) {
    const error = new Error("The enquiry is too large.");
    error.status = 413;
    throw error;
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBodyBytes) {
      const error = new Error("The enquiry is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("The enquiry must contain valid JSON.");
    error.status = 400;
    throw error;
  }
}

function cleanText(value) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
}

function validateEnquiry(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "Please submit a valid enquiry." };
  }
  if (cleanText(input.website)) return { spam: true };

  const enquiry = {
    name: cleanText(input.name),
    email: cleanText(input.email),
    phone: cleanText(input.phone),
    organization: cleanText(input.organization),
    sector: cleanText(input.sector),
    service: cleanText(input.service),
    message: cleanText(input.message),
  };

  if (enquiry.name.length < 2 || enquiry.name.length > 100) {
    return { error: "Enter your name (2 to 100 characters)." };
  }
  if (enquiry.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(enquiry.email)) {
    return { error: "Enter a valid email address." };
  }
  if (enquiry.phone.length > 30 || enquiry.organization.length > 150) {
    return { error: "Check the phone and organization fields." };
  }
  if (!sectors.has(enquiry.sector)) return { error: "Select a valid sector." };
  if (!services.has(enquiry.service)) return { error: "Select a valid service." };
  if (enquiry.message.length < 20 || enquiry.message.length > 4000) {
    return { error: "Describe your requirements in 20 to 4,000 characters." };
  }
  return { enquiry };
}

async function storeEnquiry(enquiry) {
  const record = {
    id: randomUUID(),
    receivedAt: new Date().toISOString(),
    ...enquiry,
  };
  await mkdir(dirname(dataFile), { recursive: true, mode: 0o700 });
  await appendFile(dataFile, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(dataFile, 0o600);
  return record;
}

function authorized(request) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const provided = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!provided) return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}

async function listEnquiries() {
  let contents;
  try {
    contents = await readFile(dataFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return contents.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function xmlEscape(value) {
  return value.replace(/[<>&'"]/g, (character) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;",
  })[character]);
}

export function createServer() {
  assertProductionConfiguration();
  const siteUrl = getSiteUrl();

  return createHttpServer(async (request, response) => {
    securityHeaders(response);
    let pathname;
    try {
      pathname = new URL(request.url, "http://localhost").pathname;
    } catch {
      sendJson(response, 400, { error: "Invalid request URL." });
      return;
    }

    if (pathname === "/api/health") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendJson(response, 405, { error: "Method not allowed." });
        return;
      }
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (pathname === "/api/enquiries") {
      if (request.method === "GET") {
        if (!process.env.ADMIN_TOKEN) {
          sendJson(response, 503, { error: "Enquiry administration is not configured." });
          return;
        }
        if (!authorized(request)) {
          sendJson(response, 401, { error: "A valid administrator token is required." });
          return;
        }
        try {
          sendJson(response, 200, { enquiries: await listEnquiries() });
        } catch (error) {
          console.error("Unable to read enquiry records:", error.message);
          sendJson(response, 500, { error: "Enquiry records are temporarily unavailable." });
        }
        return;
      }

      if (request.method !== "POST") {
        response.setHeader("Allow", "GET, POST");
        sendJson(response, 405, { error: "Method not allowed." });
        return;
      }
      if (!allowSameOrigin(request)) {
        sendJson(response, 403, { error: "Cross-origin submissions are not allowed." });
        return;
      }
      if (!takeRateLimit(request)) {
        sendJson(response, 429, { error: "Too many enquiries from this connection. Please try again later." });
        return;
      }

      try {
        const result = validateEnquiry(await readJsonBody(request));
        if (result.spam) {
          sendJson(response, 201, { received: true });
          return;
        }
        if (result.error) {
          sendJson(response, 400, { error: result.error });
          return;
        }
        const record = await storeEnquiry(result.enquiry);
        sendJson(response, 201, { received: true, id: record.id });
      } catch (error) {
        if (error.status) {
          sendJson(response, error.status, { error: error.message });
          return;
        }
        console.error("Unable to store enquiry:", error.message);
        sendJson(response, 500, { error: "We could not save your enquiry. Please try again later." });
      }
      return;
    }

    if (pathname === "/robots.txt") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        response.writeHead(405);
        response.end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      });
      response.end(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${siteUrl}/sitemap.xml\n`);
      return;
    }

    if (pathname === "/sitemap.xml") {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        response.writeHead(405);
        response.end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      });
      response.end(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${xmlEscape(`${siteUrl}/`)}</loc></url></urlset>\n`);
      return;
    }

    const publicFile = publicFiles.get(pathname);
    if (!publicFile) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    if (!["GET", "HEAD"].includes(request.method)) {
      response.setHeader("Allow", "GET, HEAD");
      response.writeHead(405);
      response.end();
      return;
    }

    try {
      let contents = await readFile(join(root, publicFile[0]), "utf8");
      if (publicFile[0] === "index.html") {
        contents = contents.replaceAll("__SITE_URL__", siteUrl);
      }
      response.writeHead(200, {
        "Content-Type": publicFile[1],
        "Cache-Control": publicFile[0] === "index.html" ? "no-cache" : "public, max-age=86400",
      });
      response.end(request.method === "HEAD" ? undefined : contents);
    } catch (error) {
      console.error("Unable to serve website:", error.message);
      sendJson(response, 500, { error: "The website is temporarily unavailable." });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`OS Technology website listening on http://${host}:${port}`);
  });
  server.on("error", (error) => {
    console.error("Unable to start OS Technology website:", error.message);
    process.exitCode = 1;
  });
}
