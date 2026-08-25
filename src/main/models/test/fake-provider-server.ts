import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeProviderRequest = Readonly<{
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}>;

export type FakeProviderHandler = (
  request: FakeProviderRequest,
  response: ServerResponse
) => void | Promise<void>;

export type FakeProviderServer = Readonly<{
  baseUrl: string;
  requests: FakeProviderRequest[];
  close(): Promise<void>;
}>;

export async function startFakeProviderServer(handler: FakeProviderHandler): Promise<FakeProviderServer> {
  const requests: FakeProviderRequest[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const received: FakeProviderRequest = {
      method: request.method ?? "",
      path: request.url ?? "",
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8")
    };
    requests.push(received);
    await handler(received, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

export function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
