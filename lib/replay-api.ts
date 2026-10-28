import https from "node:https";

export type ReplayApiPayload = Record<string, unknown>;

export function replayApi<T = ReplayApiPayload>(
  endpoint: string,
  method: "GET" | "POST" = "GET",
  body?: ReplayApiPayload,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port: 2999,
        path: endpoint,
        method,
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: body
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : undefined,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`League Replay API returned ${response.statusCode ?? "an error"}.`));
            return;
          }
          try {
            resolve((text ? JSON.parse(text) : {}) as T);
          } catch {
            resolve({} as T);
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("League Replay API timed out.")));
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}
