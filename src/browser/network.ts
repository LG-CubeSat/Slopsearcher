import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import ipaddr from "ipaddr.js";

function publicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

function resolveHost(hostname: string, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<{ address: string; family: number }[]>(
    (resolve, reject) => {
      const abort = () =>
        reject(new Error("Browser DNS lookup timed out or was cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      void lookup(hostname, { all: true }).then(
        (addresses) => {
          signal.removeEventListener("abort", abort);
          resolve(addresses);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    },
  );
}

export function publicWebUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && url.port !== (url.protocol === "https:" ? "443" : "80")) ||
    hostname.endsWith(".") ||
    /(?:^|\.)(?:localhost|local|internal|home|lan|onion)$/.test(hostname) ||
    (!hostname.includes(".") && !hostname.includes(":")) ||
    (ipaddr.isValid(hostname) && !publicAddress(hostname))
  )
    throw new Error(
      "Only public HTTP/HTTPS pages on standard ports are allowed",
    );
  return url;
}

/** Resolve once, reject every nonpublic answer, and pin the connection to that IP.
 * Never let the HTTP client resolve the hostname again (DNS rebinding).
 * Redirects are returned to Chromium and rechecked as separate requests.
 */
export async function fetchPublicResource(
  value: string,
  method: "GET" | "HEAD",
  headers: Record<string, string>,
  limit: number,
  signal: AbortSignal,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  signal.throwIfAborted();
  const url = publicWebUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = ipaddr.isValid(hostname)
    ? [
        {
          address: hostname,
          family: ipaddr.parse(hostname).kind() === "ipv4" ? 4 : 6,
        },
      ]
    : await resolveHost(hostname, signal);
  signal.throwIfAborted();
  if (
    !addresses.length ||
    addresses.some(({ address }) => !publicAddress(address))
  )
    throw new Error(
      "Browser access to local, private or reserved networks is blocked",
    );
  const address = addresses.find((a) => a.family === 4) ?? addresses[0]!;
  const forwarded: Record<string, string> = { "accept-encoding": "identity" };
  for (const name of ["accept", "accept-language", "user-agent", "cookie"])
    if (headers[name]) forwarded[name] = headers[name];
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method,
        headers: forwarded,
        agent: false,
        family: address.family,
        signal,
        lookup: (_host, _options, callback) => {
          callback(null, address.address, address.family);
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            request.destroy(
              new Error("Browser resource exceeded the size limit"),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const outputHeaders: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (
              value === undefined ||
              [
                "connection",
                "transfer-encoding",
                "content-length",
                "keep-alive",
                "upgrade",
              ].includes(name)
            )
              continue;
            outputHeaders[name] = Array.isArray(value)
              ? value.join("\n")
              : value;
          }
          resolve({
            status: response.statusCode ?? 502,
            headers: outputHeaders,
            body: Buffer.concat(chunks, size),
          });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}
