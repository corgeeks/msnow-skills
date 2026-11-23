export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class DaemonUnreachableError extends Error {
  constructor() { super('factory daemon is not running — start it with: factory daemon'); }
}

export interface Client {
  get(path: string): Promise<any>;
  post(path: string, body: unknown): Promise<any>;
  patch(path: string, body: unknown): Promise<any>;
}

export function createClient(port: number): Client {
  async function req(method: string, path: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      const cause = e instanceof Error ? e.cause : undefined;
      if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ECONNREFUSED') throw new DaemonUnreachableError();
      throw e;
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'http_error', data?.error?.message ?? `HTTP ${res.status}`);
    return data;
  }
  return {
    get: (path: string) => req('GET', path),
    post: (path: string, body: unknown) => req('POST', path, body),
    patch: (path: string, body: unknown) => req('PATCH', path, body),
  };
}
