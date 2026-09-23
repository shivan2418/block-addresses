// The page's side of search.worker.ts: the same calls as search.ts, answered by the worker.
import type { Request, Response } from "./search.worker";

// The worker is named after the page's base URL: it can't see the page's location itself, and
// the data lives next to the page.
const worker = new Worker(new URL("./search.worker.ts", import.meta.url), {
  type: "module",
  name: new URL(import.meta.env.BASE_URL, location.href).href,
});
const pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
let nextId = 0;

worker.onmessage = ({ data }: MessageEvent<Response>) => {
  const call = pending.get(data.id);
  pending.delete(data.id);
  if (data.ok) call?.resolve(data.value as never);
  else call?.reject(new Error(data.error));
};

type WithoutId<R> = R extends unknown ? Omit<R, "id"> : never;

function ask<T>(request: WithoutId<Request>): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: never) => void, reject });
    worker.postMessage({ ...request, id } as Request);
  });
}

/** Formatted addresses, or null while the input can't be searched yet. See search() in search.ts. */
export const search = (input: string) => ask<string[] | null>({ kind: "search", input });
export const totalAddresses = () => ask<number>({ kind: "total" });
