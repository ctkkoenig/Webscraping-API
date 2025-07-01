import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Mutex, Semaphore } from "async-mutex";
import { Browser, Credentials } from "puppeteer";
import { BodyInit, fetch, ProxyAgent, Response } from "undici";
import { HeaderGenerator } from "header-generator";
import DEV from "./dev";
import sleep from "./sleep";

puppeteer.use(StealthPlugin());

export type ProxyRequestOptions =
  | {
      method: "BROWSER";
      waitForNetworkIdle?: boolean;
    }
  | {
      method: "GET" | "POST";
      headers?: Record<string, string>;
      body?: BodyInit;
    };

interface ProxyPort {
  value: number;
  browser: Promise<Browser>;
  agent: ProxyAgent;
  hostnames: Set<string>;
  hostnamesMutex: Mutex;
}

const FIRST_PORT = parseInt(process.env.PROXY_FIRST_PORT!, 10);

export default class Proxy {
  static shared = new this({
    ports: Array(parseInt(process.env.PROXY_PORTS!, 10))
      .fill(undefined)
      .map((_value, index) => FIRST_PORT + index),
    hostname: process.env.PROXY_HOSTNAME!,
    credentials: {
      username: process.env.PROXY_USERNAME!,
      password: process.env.PROXY_PASSWORD!,
    },
    sameHostnameSuccessDelay: parseInt(
      process.env.PROXY_SAME_HOSTNAME_SUCCESS_DELAY!,
      10
    ),
    sameHostnameErrorDelay: parseInt(
      process.env.PROXY_SAME_HOSTNAME_ERROR_DELAY!,
      10
    ),
    maxTries: parseInt(process.env.PROXY_MAX_TRIES!, 10),
    log: DEV,
  });

  private headerGenerator = new HeaderGenerator();

  private ports: ProxyPort[];
  private semaphores: Record<string, Semaphore> = {};
  private semaphoresMutex = new Mutex();

  private credentials: Credentials;
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
    credentials: Credentials;
    sameHostnameSuccessDelay: number;
    sameHostnameErrorDelay: number;
    maxTries: number;
    log?: boolean;
  }) {
    this.ports = ports.map((value) => ({
      value,
      browser: puppeteer.launch({
        args: ["--no-sandbox", `--proxy-server=https://${hostname}:${value}`],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH!,
      }),
      agent: new ProxyAgent(
        `https://${credentials.username}:${credentials.password}@${hostname}:${value}`
      ),
      hostnames: new Set(),
      hostnamesMutex: new Mutex(),
    }));

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

  private getAvailablePort = async (hostname: string) => {
    const shuffledPorts = this.shuffleArray([...this.ports]);
    while (true) {
      for (const port of shuffledPorts) {
        const isAvailable = await port.hostnamesMutex.runExclusive(() => {
          if (port.hostnames.has(hostname)) return false;

          port.hostnames.add(hostname);
          return true;
        });

        if (isAvailable) return port;
      }

      await sleep(50);
    }
  };

  fetch = async <Options extends ProxyRequestOptions>(
    url: URL,
    options: Options,
    tries = 0
  ): Promise<Options["method"] extends "BROWSER" ? string : Response> => {
    if (tries >= this.maxTries)
      throw new Error(
        `MAX TRIES ${url.href} ${new Date().toLocaleTimeString()}`
      );

    const semaphore = await this.semaphoresMutex.runExclusive(
      () => (this.semaphores[url.hostname] ??= new Semaphore(this.ports.length))
    );

    const [_value, release] = await semaphore.acquire();

    let port: ProxyPort;

    try {
      port = await this.getAvailablePort(url.hostname);
    } catch (error) {
      release();
      throw error;
    }

    const waitAndRelease = (success = true) => {
      const delay = success
        ? this.sameHostnameSuccessDelay
        : this.sameHostnameErrorDelay;

      sleep(delay)
        .then(() =>
          port.hostnamesMutex.runExclusive(() => {
            port.hostnames.delete(url.hostname);
          })
        )
        .then(release)
        .catch(console.error);
    };

    const sendRequestsToAllPorts = async (): Promise<Response> => {
      const responses = await Promise.all(
        this.ports.map(async (port) => {
          try {
            const response = await fetch(url.href, {
              method: options.method,
              headers:
                "headers" in options
                  ? {
                      ...this.headerGenerator.getHeaders(),
                      ...options.headers,
                    }
                  : undefined,
              body: "body" in options ? options.body : undefined,
              dispatcher: port.agent,
            });
            if (response.ok) {
              return response;
            }
          } catch (error) {
            console.error(
              `ERROR ${url.href} ${
                port.value
              } ${new Date().toLocaleTimeString()}`,
              error
            );
          }
          return null;
        })
      );
      await sleep(10000); // Wait for 10 seconds
      const validResponses = responses.filter((response) => response !== null);
      if (validResponses.length === 0) {
        throw new Error("No valid responses from any port");
      }
      return validResponses[Math.floor(Math.random() * validResponses.length)]!;
    };

    try {
      if (options.method === "BROWSER") {
        const browser = await port.browser;

        if (this.log)
          console.log(
            `RUN ${url.href} ${port.value} ${new Date().toLocaleTimeString()}`
          );

        const page = await browser.newPage();

        try {
          await page.authenticate(this.credentials);

          const response = await page.goto(url.href, {
            waitUntil: options.waitForNetworkIdle
              ? "networkidle0"
              : "domcontentloaded",
            timeout: options.waitForNetworkIdle ? 60000 : 60000,
          });

          const text = await page.content();

          if (this.log)
            console.log(
              `DONE ${url.href} ${
                port.value
              } ${new Date().toLocaleTimeString()}`
            );

          waitAndRelease();

          return text as never;
        } finally {
          page.close().catch(console.error);
        }
      } else {
        if (this.log)
          console.log(
            `RUN ${url.href} ${port.value} ${new Date().toLocaleTimeString()}`
          );

        const response = await fetch(url.href, {
          method: options.method,
          headers:
            "headers" in options
              ? {
                  ...this.headerGenerator.getHeaders(),
                  ...options.headers,
                }
              : undefined,
          body: "body" in options ? options.body : undefined,
          dispatcher: port.agent,
        });

        if (!response.ok) {
          if (
            (await response.text()) ===
            "Error updating item info: Could not find product"
          ) {
            const validResponse = await sendRequestsToAllPorts();
            waitAndRelease();
            return validResponse as never;
          }
        }

        if (this.log)
          console.log(
            `DONE ${url.href} ${port.value} ${new Date().toLocaleTimeString()}`
          );

        waitAndRelease();

        return response as never;
      }
    } catch (error) {
      const typedError = error as Error;

      if (typedError.name === "TimeoutError") {
        console.error(
          `TimeoutError ${url.href} ${
            port.value
          } (TRIES: ${tries}) ${new Date().toLocaleTimeString()}`
        );
      } else {
        console.error(
          `ERROR ${url.href} ${
            port.value
          } (TRIES: ${tries}) ${new Date().toLocaleTimeString()}`,
          typedError.message
        );
      }

      waitAndRelease(false);

      return this.fetch(url, options, tries + 1);
    }
  };
}
