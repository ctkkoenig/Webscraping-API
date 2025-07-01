import { firefox } from "playwright";
import { Mutex, Semaphore } from "async-mutex";
import { HeaderGenerator } from "header-generator";
import DEV from "./dev";
import sleep from "./sleep";

// In your .env or environment variables, define these:
// PROXY_FIRST_PORT=10000
// PROXY_PORTS=10 (total number of ports to use)
// PROXY_HOSTNAME=some.proxyhost.com
// PROXY_USERNAME=someUser
// PROXY_PASSWORD=somePass
// PROXY_SAME_HOSTNAME_SUCCESS_DELAY=500
// PROXY_SAME_HOSTNAME_ERROR_DELAY=2000
// PROXY_MAX_TRIES=5

export type ProxyRequestOptions = {
  method?: "GET" | "POST";
  // Additional fields can be added if needed (e.g., headers),
  // but for Playwright usage we mostly rely on the browser + page.
};

interface ProxyPort {
  value: number;              // proxy port number
  hostnames: Set<string>;     // hostnames currently "claimed" by this port
  hostnamesMutex: Mutex;      // mutex to guard the hostnames set
}

const FIRST_PORT = parseInt(process.env.PROXY_FIRST_PORT || "10000", 10);

export default class Proxy2 {
  // A shared singleton, if desired
  static shared = new Proxy2({
    ports: Array(parseInt(process.env.PROXY_PORTS || "1", 10))
      .fill(undefined)
      .map((_value, index) => FIRST_PORT + index),
    hostname: process.env.PROXY_HOSTNAME || "127.0.0.1",
    credentials: {
      username: process.env.PROXY_USERNAME || "",
      password: process.env.PROXY_PASSWORD || "",
    },
    sameHostnameSuccessDelay: parseInt(
      process.env.PROXY_SAME_HOSTNAME_SUCCESS_DELAY || "500",
      10
    ),
    sameHostnameErrorDelay: parseInt(
      process.env.PROXY_SAME_HOSTNAME_ERROR_DELAY || "2000",
      10
    ),
    maxTries: parseInt(process.env.PROXY_MAX_TRIES || "5", 10),
    log: DEV, // or true/false
  });

  private headerGenerator = new HeaderGenerator();
  private ports: ProxyPort[];
  private semaphores: Record<string, Semaphore> = {};
  private semaphoresMutex = new Mutex();

  private hostname: string;
  private credentials: { username: string; password: string };
  private sameHostnameSuccessDelay: number;
  private sameHostnameErrorDelay: number;
  private maxTries: number;
  private log: boolean;

  constructor({
    ports,
    hostname,
    credentials,
    sameHostnameSuccessDelay,
    sameHostnameErrorDelay,
    maxTries,
    log = true,
  }: {
    ports: number[];
    hostname: string;
    credentials: { username: string; password: string };
    sameHostnameSuccessDelay: number;
    sameHostnameErrorDelay: number;
    maxTries: number;
    log?: boolean;
  }) {
    this.ports = ports.map((value) => ({
      value,
      hostnames: new Set(),
      hostnamesMutex: new Mutex(),
    }));
    this.hostname = hostname;
    this.credentials = credentials;
    this.sameHostnameSuccessDelay = sameHostnameSuccessDelay;
    this.sameHostnameErrorDelay = sameHostnameErrorDelay;
    this.maxTries = maxTries;
    this.log = log;
  }

  private shuffleArray = <T>(array: T[]): T[] => {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  };

  private async getAvailablePort(hostname: string): Promise<ProxyPort> {
    const shuffled = this.shuffleArray([...this.ports]);
    while (true) {
      for (const port of shuffled) {
        const isAvailable = await port.hostnamesMutex.runExclusive(() => {
          if (port.hostnames.has(hostname)) return false;
          port.hostnames.add(hostname);
          return true;
        });
        if (isAvailable) return port;
      }
      await sleep(50);
    }
  }

  /**
   * Fetch the full HTML from a page using Playwright with a system proxy.
   * 
   * Implementing suggestion #1 (block images/fonts), #2 (light browser context),
   * and #4 (use waitUntil: "networkidle").
   * 
   * @param url - The target URL to visit
   * @param options - Additional request options
   * @param tries - Internal usage for recursion
   * @returns The full HTML string
   */
  public async fetch(
    url: URL,
    options: ProxyRequestOptions = {},
    tries = 0
  ): Promise<string> {
    if (tries >= this.maxTries) {
      throw new Error(
        `Max tries exceeded for ${url.href} at ${new Date().toLocaleTimeString()}`
      );
    }

    // Acquire the semaphore for this hostname
    const semaphore = await this.semaphoresMutex.runExclusive(() => {
      if (!this.semaphores[url.hostname]) {
        this.semaphores[url.hostname] = new Semaphore(this.ports.length);
      }
      return this.semaphores[url.hostname];
    });
    const [_, release] = await semaphore.acquire();

    let portObj: ProxyPort;
    try {
      portObj = await this.getAvailablePort(url.hostname);
    } catch (err) {
      release();
      throw err;
    }

    const waitAndRelease = (success: boolean) => {
      const delay = success
        ? this.sameHostnameSuccessDelay
        : this.sameHostnameErrorDelay;
      sleep(delay)
        .then(() => {
          return portObj.hostnamesMutex.runExclusive(() => {
            portObj.hostnames.delete(url.hostname);
          });
        })
        .finally(release)
        .catch((err) => {
          console.error("Error releasing semaphore slot:", err);
        });
    };

    const attemptStr = `Attempt #${tries + 1}`;
    let browser;
    let page;

    try {
      // Generate a random user-agent
      const userAgentHeaders = this.headerGenerator.getHeaders();
      const userAgent =
        userAgentHeaders["user-agent"] || "Mozilla/5.0 (compatible; Chrome)";

      if (this.log) {
        console.log(
          `[Proxy2] ${attemptStr} => ${url.href} using port ${portObj.value}`
        );
      }

      // Launch a new Firefox instance with minimal flags (headless + disable-sandbox).
      // Suggestion #2: "lighter" context
      browser = await firefox.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"], 
        proxy: {
          server: `http://${this.hostname}:${portObj.value}`,
          username: this.credentials.username,
          password: this.credentials.password,
        },
      });

      const context = await browser.newContext({ userAgent });

      // Suggestion #1: block images, fonts, and possibly large media
      // to speed up the load
      await context.route("**/*", async (route) => {
        const req = route.request();
        const urlLower = req.url().toLowerCase();

        // Block images, fonts, CSS. (Adjust as needed.)
        if (
          urlLower.endsWith(".png") ||
          urlLower.endsWith(".jpg") ||
          urlLower.endsWith(".jpeg") ||
          urlLower.endsWith(".gif") ||
          urlLower.endsWith(".webp") ||
          urlLower.endsWith(".ico") ||
          urlLower.endsWith(".svg") ||
          urlLower.endsWith(".woff") ||
          urlLower.endsWith(".woff2") ||
          urlLower.endsWith(".ttf") ||
          urlLower.endsWith(".css")
        ) {
          return route.abort();
        }

        // For everything else:
        return route.continue();
      });

      page = await context.newPage();

      // Suggestion #4: waitUntil: "networkidle" => ensures there's no ongoing requests
      await page.goto(url.href, { waitUntil: "networkidle" });

      const html = await page.content();

      if (this.log) {
        console.log(
          `[Proxy2] [OK] => (port: ${portObj.value}, code: 200) for ${
            url.href
          }  ${attemptStr}`
        );
      }
      waitAndRelease(true);

      await page.close();
      await context.close();
      await browser.close();

      return html;
    } catch (err: any) {
      const msg = err.message || err.toString();

      if (this.log) {
        console.error(
          `[Proxy2] [FAIL] => (port: ${portObj.value}) for ${url.href}  ${attemptStr}`,
          msg
        );
      }

      waitAndRelease(false);

      if (browser) {
        try {
          if (page && !page.isClosed()) await page.close();
          await browser.close();
        } catch {
          // ignore errors on close
        }
      }

      if (tries + 1 < this.maxTries) {
        await sleep(1000); // slight back-off
        return this.fetch(url, options, tries + 1);
      } else {
        throw new Error(`Proxy2 failed after ${tries + 1} tries: ${msg}`);
      }
    }
  }
}
