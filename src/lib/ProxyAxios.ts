import axios from "axios";
import { Mutex, Semaphore } from "async-mutex";
import { HeaderGenerator } from "header-generator";
import DEV from "./dev";
import sleep from "./sleep";
import https from "https";

export type ProxyRequestOptions = {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  decompress?: boolean;
};

interface ProxyPort {
  value: number;
  hostnames: Set<string>;
  hostnamesMutex: Mutex;
}

const FIRST_PORT = parseInt(process.env.PROXY_FIRST_PORT!, 10);

export default class Proxy {
  static shared = new Proxy({
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

  private hostname: string;
  private credentials: { username: string; password: string };
  private sameHostnameSuccessDelay: number;
  private sameHostnameErrorDelay: number;
  private maxTries: number;
  private log: boolean;

  private agent = new https.Agent({
    keepAlive: true,
    maxSockets: 100,
    rejectUnauthorized: false,
  });

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

  private getAvailablePort = async (hostname: string): Promise<ProxyPort> => {
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

  fetch = async (
    url: URL,
    options: ProxyRequestOptions,
    tries = 0
  ): Promise<any> => {
    if (tries >= this.maxTries)
      throw new Error(
        `MAX TRIES EXCEEDED: ${url.href} at ${new Date().toLocaleTimeString()}`
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

    try {
      if (this.log)
        console.log(
          `RUNNING ${url.href} on port ${
            port.value
          } at ${new Date().toLocaleTimeString()}`
        );

      const userAgentHeaders = this.headerGenerator.getHeaders();
      const headers: Record<string, string> = {
        ...userAgentHeaders,
        ...options.headers,
        "User-Agent": userAgentHeaders["user-agent"] || "Mozilla/5.0",
      };

      // Adjust the Accept-Encoding header
      if (options.decompress) {
        headers["Accept-Encoding"] = "gzip, deflate, br";
      } else {
        headers["Accept-Encoding"] = "identity";
      }

      const response = await axios({
        method: options.method,
        url: url.href,
        headers,
        data: options.body,
        proxy: {
          host: this.hostname,
          port: port.value,
          auth: {
            username: this.credentials.username,
            password: this.credentials.password,
          },
        },
        timeout: 70000,
        httpsAgent: this.agent,
        responseType: options.decompress ? "arraybuffer" : "text",
        // Removed the invalid 'decompress' option
      });

      let decodedHtml = response.data;

      if (options.decompress) {
        // Convert the ArrayBuffer to a string
        decodedHtml = Buffer.from(response.data).toString("utf-8");
      }

      if (this.log)
        console.log(
          `SUCCESS: ${url.href} on port ${
            port.value
          } at ${new Date().toLocaleTimeString()}`
        );

      waitAndRelease();

      return decodedHtml;
    } catch (error: any) {
      console.error(
        `ERROR ${url.href} on port ${
          port.value
        } (TRIES: ${tries}) at ${new Date().toLocaleTimeString()}`,
        error.message
      );

      waitAndRelease(false);

      // Retry the request if the error is recoverable
      if (tries < this.maxTries - 1) {
        await sleep(1000); // Wait a bit before retryin
        return this.fetch(url, options, tries + 1);
      }

      throw new Error(
        `Request to ${url.href} failed with status ${
          error.response?.status || "Unknown"
        }: ${error.message}`
      );
    }
  };
}
