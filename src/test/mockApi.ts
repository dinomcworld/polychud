import { readFileSync } from "node:fs";

/** A request the code under test made while `mockApi` was installed. */
export interface RecordedCall {
  url: URL;
  method: string;
  /** Parsed JSON request body, or null for GETs. */
  body: unknown;
}

/**
 * Returns the response for a request, as either a plain value (serialized to
 * JSON with a 200) or a `Response` when the status or headers matter.
 * Returning `undefined` fails the test with the unrouted URL.
 */
export type Responder = (call: RecordedCall) => unknown;

const realFetch = globalThis.fetch;

/**
 * Swap `globalThis.fetch` for `responder`, recording every request. The service
 * under test calls the global directly, so this exercises its real URL
 * building, retry and parsing code against captured Polymarket payloads.
 */
export function mockApi(responder: Responder): RecordedCall[] {
  const calls: RecordedCall[] = [];

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const raw = input instanceof Request ? input.url : String(input);
    const call: RecordedCall = {
      url: new URL(raw),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);

    const result = await responder(call);
    if (result instanceof Response) return result;
    if (result === undefined) {
      throw new Error(`mockApi: unrouted ${call.method} ${raw}`);
    }
    return Response.json(result);
  }) as typeof fetch;

  return calls;
}

export function restoreApi() {
  globalThis.fetch = realFetch;
}

const cache = new Map<string, unknown>();

/** Load a captured API payload from `src/test/fixtures`. */
export function fixture<T = unknown>(name: string): T {
  let data = cache.get(name);
  if (data === undefined) {
    const path = new URL(`./fixtures/${name}.json`, import.meta.url);
    data = JSON.parse(readFileSync(path, "utf8"));
    cache.set(name, data);
  }
  // Deep-copied so a test mutating a payload cannot leak into another.
  return structuredClone(data) as T;
}
