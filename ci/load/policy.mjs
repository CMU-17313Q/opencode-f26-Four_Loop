export function isHealthy(status, body) {
  return status === 200 && body !== null && typeof body === "object" && body.healthy === true
}
export function assertLoopback(value) {
  const url = new URL(value)
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw new Error("Load tests must target a disposable local HTTP server, never the shared VM")
  }
  return url
}
