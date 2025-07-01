// src/index.ts

import express, {
  Request,
  Response as ExpressResponse, // alias Express Response
  NextFunction,
  RequestHandler,
} from "express";
import fs from "fs";
import path from "path";
import os from "os";
import net from "net";
import { URL } from "url";
import "dotenv/config";
import crypto from "crypto";
// Import node-fetch and alias its types so they don’t conflict with Express types.
import fetch, {
  Response as FetchResponse,
  RequestInit as FetchRequestInit,
} from "node-fetch";
// Import the Proxy module for fallback fetching
import Proxy from "./lib/ProxyLegacy";

const app = express();

/**
 * Environment-based configs
 */
const API_KEY = process.env.API_KEY;

const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || "30000", 10);

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

/**
 * Simple helper to require a valid API key
 * for all routes except /github-webhook
 */
function requireApiKey(req: Request, res: ExpressResponse, next: NextFunction) {
  if (req.path === "/github-webhook") {
    next();
    return;
  }

  const apiKey = req.headers["x-api-key"];
  if (apiKey === API_KEY) {
    next();
  } else {
    res
      .status(403)
      .json({ success: false, message: "Forbidden: Invalid API Key" });
    return;
  }
}

app.use(requireApiKey);

/**
 * 1. GitHub Webhook Route (raw body for signature check)
 *    We must cast express.raw(...) to RequestHandler to avoid TS overload errors.
 */
app.post(
  "/github-webhook",
  express.raw({ type: "application/json" }) as RequestHandler,
  (req: Request, res: ExpressResponse) => {
    // 1) Verify signature
    const signatureHeader = req.headers["x-hub-signature-256"];
    if (!signatureHeader) {
      res.status(400).json({ success: false, message: "Missing signature" });
      return;
    }

    const sig = Buffer.from(signatureHeader as string, "utf8");
    const hmac = crypto.createHmac("sha256", GITHUB_WEBHOOK_SECRET);
    hmac.update(req.body);
    const digest = Buffer.from("sha256=" + hmac.digest("hex"), "utf8");
    if (!crypto.timingSafeEqual(digest, sig)) {
      res.status(401).json({ success: false, message: "Invalid signature" });
      return;
    }

    // 2) Check if it's a push event
    const event = req.headers["x-github-event"];
    if (event !== "push") {
      res
        .status(200)
        .json({ success: true, message: "Not a push event, ignoring" });
      return;
    }

    // 3) Just respond immediately. No self-update here.
    res.status(202).json({
      success: true,
      message: "Webhook received. Use host's update.sh.",
    });
    return;
  }
);

// Attach express.json() afterwards
app.use(express.json());

// Health check
app.get("/health", (req: Request, res: ExpressResponse) => {
  res.json({ success: true, message: "OK" });
});

/**
 * Helper to add a timeout to any promise
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  errorMessage = "Request timed out"
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errorMessage)), ms);
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function fetchWithRetry(
  url: string,
  options: FetchRequestInit,
  timeout: number,
  maxRetries: number,
  retryDelay: number
): Promise<FetchResponse> {
  let attempt = 0;
  let response: FetchResponse | undefined;
  while (attempt <= maxRetries) {
    try {
      console.log(`[ROOFTOP] Fetch attempt ${attempt + 1} for: ${url}`);
      response = await withTimeout(
        fetch(url, options),
        timeout,
        `Node-fetch for ${url} timed out after ${timeout} ms`
      );
      // Ensure response is defined before accessing properties
      if (response && response.ok) {
        return response;
      } else if (response) {
        console.error(
          `[ROOFTOP] node-fetch attempt ${
            attempt + 1
          } returned non-ok response: ${response.status} - ${
            response.statusText
          }`
        );
      }
    } catch (err) {
      console.error(
        `[ROOFTOP] node-fetch attempt ${attempt + 1} encountered error:`,
        err
      );
    }
    attempt++;
    if (attempt <= maxRetries) {
      console.log(`[ROOFTOP] Retrying fetch in ${retryDelay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
  throw new Error(`Rooftop fetch error after ${maxRetries + 1} attempts`);
}

/**
 * Main fetch endpoint (POST /api/fetch)
 */
app.post("/api/fetch", async (req: Request, res: ExpressResponse) => {
  try {
    const { url } = req.body;
    if (!url) {
      res
        .status(400)
        .json({ success: false, message: "Missing 'url' in request body." });
      return;
    }

    const targetUrl = new URL(url);
    const hostname = targetUrl.hostname.replace(/^www\./, "");
    const siteHandlerPath = path.resolve(
      __dirname,
      `./lib/sites/${hostname}.js`
    );

    /**
     * If the URL starts with "https://rooftopdefense.com/wp-json/",
     * we skip the normal site handler and do a direct node-fetch.
     * This covers all pages, e.g. page=1, page=2, etc.
     */
    if (url.startsWith("https://rooftopdefense.com/wp-json/")) {
      try {
        console.log(`[ROOFTOP] Doing direct fetch for: ${url}`);

        // Configure retry settings. You may choose to make these configurable via environment variables.
        const MAX_RETRIES = 3; // maximum number of additional attempts
        const RETRY_DELAY_MS = 1000; // wait 1 second between attempts

        // Use our new helper to fetch with retries.
        const response = await fetchWithRetry(
          url,
          {
            method: "GET",
            headers: {
              "Cache-Control": "no-cache, no-store, must-revalidate",
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36",
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9," +
                "image/avif,image/webp,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.9",
              "Accept-Encoding": "identity",
              Referer: "https://www.google.com/",
            },
          },
          FETCH_TIMEOUT_MS,
          MAX_RETRIES,
          RETRY_DELAY_MS
        );

        // Continue processing the successful response.
        const text = await response.text();
        console.log(`[ROOFTOP] Direct fetch => content length: ${text.length}`);

        // Attempt to parse the text as JSON
        try {
          const parsed = JSON.parse(text);
          // If it’s valid JSON, return that array/object directly
          console.log("[ROOFTOP] Successfully parsed JSON array or object");
          res.json(parsed);
          return;
        } catch {
          // If parse fails, fallback to returning the raw string in "html"
          console.error("[ROOFTOP] JSON parse failed, returning raw string");
          res.json({ success: true, html: text });
          return;
        }
      } catch (fetchErr) {
        console.error("[ROOFTOP] node-fetch error:", fetchErr);
        res.status(500).json({
          success: false,
          message: "Error fetching RooftopDefense URL",
          error: String(fetchErr),
        });
        return;
      }
    }

    // Otherwise, proceed with the normal site handler or fallback
    if (fs.existsSync(siteHandlerPath)) {
      const siteHandler = require(siteHandlerPath).default;
      if (typeof siteHandler !== "function") {
        throw new Error(`Handler for ${hostname} is not a function.`);
      }

      const result = await withTimeout(
        siteHandler(targetUrl),
        FETCH_TIMEOUT_MS,
        `Site handler for ${hostname} timed out after ${FETCH_TIMEOUT_MS} ms`
      );
      console.log(`[✅] /api/fetch - Hostname: ${hostname} - URL: ${url}`);

      if (typeof result === "object") {
        res.json(result);
        return;
      } else {
        res.json({ success: true, data: String(result) });
        return;
      }
    } else {
      // No site-specific handler => fallback using the proxy to fetch full HTML.
      try {
        console.log(
          `[PROXY] No handler for ${hostname}. Using proxy to fetch full HTML for: ${url}`
        );
        const proxyResult = await withTimeout(
          Proxy.shared.fetch(targetUrl, {
            method: "BROWSER",
            waitForNetworkIdle: true,
          }),
          FETCH_TIMEOUT_MS,
          `Proxy fetch for ${hostname} timed out after ${FETCH_TIMEOUT_MS} ms`
        );
        res.json({ success: true, html: proxyResult });
        return;
      } catch (proxyErr) {
        console.error(
          `[PROXY] Error fetching via proxy for ${hostname}:`,
          proxyErr
        );
        res.status(500).json({
          success: false,
          message: `Error fetching ${url} via proxy.`,
          error: String(proxyErr),
        });
        return;
      }
    }
  } catch (error: any) {
    if (error instanceof Error && error.message.includes("timed out")) {
      console.error("Timeout in /api/fetch:", error.message);
      res.status(408).json({
        success: false,
        message: "Request Timeout",
        error: error.message,
      });
      return;
    } else {
      console.error("Error in /api/fetch:", error);
      res.status(500).json({
        success: false,
        message: "Internal server error",
        error: String(error),
      });
      return;
    }
  }
});

/**
 * Global error handlers
 */
process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err.code === "ECONNRESET") {
    return;
  }
  console.error("Uncaught Exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

/**
 * Helper: get external/public IP from a third-party service
 */
async function getPublicIP(): Promise<string> {
  try {
    const res = await fetch("https://api.ipify.org?format=json");
    const data = await res.json();
    return data.ip || "unknown";
  } catch (error) {
    console.error("Error getting public IP:", error);
    return "unknown";
  }
}

// Start server
// Updated default port to 52784
const PORT = process.env.PORT || 52784;
app.listen(PORT, async () => {
  console.log(`API server is running on port ${PORT}`);

  const serverIp = await getPublicIP();

  fetch(
    "https://discord.com/api/webhooks/1330410922157805599/PYtDrCzGlerG3tBY6V35t9Srn7RMoEv4-AsynOUsb-wLcW2iiaoA1JlQKVGOd2r2ufqH",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `API server **${serverIp}** is online on port ${PORT}`,
      }),
    }
  )
    .then(() => console.log("Discord webhook sent success!"))
    .catch((err) => console.error("Discord webhook error:", err));
});

const AGENT_PORT = parseInt(process.env.AGENT_PORT || "60123", 10);
const agentServer = net.createServer((socket) => {
  socket.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ECONNRESET") {
      // Ignore
    } else {
      console.error("Socket error:", err);
    }
  });

  try {
    const load1 = os.loadavg()[0];
    const cpuCores = os.cpus().length;
    const cpuLoadPct = (load1 / cpuCores) * 100;

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMemPct = ((totalMem - freeMem) / totalMem) * 100;

    const combinedPct = (cpuLoadPct + usedMemPct) / 2;

    let weight = 256 - combinedPct * 2;
    if (weight < 1) weight = 1;
    if (weight > 256) weight = 256;

    socket.write(`up ${Math.round(weight)}\n`);
  } catch (err) {
    socket.write("down\n");
  } finally {
    socket.end();
  }
});

agentServer.listen(AGENT_PORT, () => {
  console.log(`TCP Agent server is listening on port ${AGENT_PORT}`);
});
