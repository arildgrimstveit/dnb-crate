export type HttpResponse = {
  status: number;
  body: string;
  headers: Record<string, string>;
};

export type HttpClient = {
  get: (url: string, headers?: Record<string, string>) => Promise<HttpResponse>;
};

export function createFetchHttpClient(timeoutMs = 20_000): HttpClient {
  return {
    async get(url, headers = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: "GET",
          headers,
          signal: controller.signal,
        });
        const body = await response.text();
        const outHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          outHeaders[key.toLowerCase()] = value;
        });
        return { status: response.status, body, headers: outHeaders };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function redactUrl(url: string): string {
  return url.replace(/([?&]client=)[^&]*/gi, "$1[redacted]");
}

export type FakeHttpRoute = {
  match: string | RegExp;
  status?: number;
  body?: string | Record<string, unknown>;
  headers?: Record<string, string>;
  responses?: Array<{
    status?: number;
    body: string | Record<string, unknown>;
    headers?: Record<string, string>;
  }>;
};

export function createFakeHttpClient(routes: FakeHttpRoute[]): HttpClient & { calls: string[] } {
  const calls: string[] = [];
  const remaining = routes.map((route) => ({
    ...route,
    queue: route.responses ? [...route.responses] : null,
  }));
  return {
    calls,
    async get(url) {
      calls.push(url);
      const hit = remaining.find((route) =>
        typeof route.match === "string" ? url.includes(route.match) : route.match.test(url),
      );
      if (!hit) {
        return { status: 404, body: "{\"error\":\"not found\"}", headers: {} };
      }
      const next = hit.queue?.shift();
      const status = next?.status ?? hit.status ?? 200;
      const raw = next?.body ?? hit.body ?? {};
      const body = typeof raw === "string" ? raw : JSON.stringify(raw);
      return { status, body, headers: next?.headers ?? hit.headers ?? {} };
    },
  };
}
