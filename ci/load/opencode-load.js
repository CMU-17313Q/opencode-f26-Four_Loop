import http from "k6/http"
import { check, sleep } from "k6"

const base = __ENV.P3_BASE_URL
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base || "")) {
  throw new Error("P3_BASE_URL must be an explicit loopback URL; never load-test the shared VM")
}
const fixture = __ENV.P3_SELFTEST === "1"
export const options = {
  vus: fixture ? 1 : 5,
  duration: fixture ? "3s" : "60s",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    checks: ["rate>=0.99"],
    http_req_duration: ["p(95)<500"],
    http_reqs: [fixture ? "count>=2" : "count>=100"],
  },
}
export default function () {
  const response = http.get(`${base}/global/health`, { timeout: "5s", redirects: 0 })
  check(response, {
    "HTTP 200": (r) => r.status === 200,
    "healthy JSON": (r) => {
      try { return r.json("healthy") === true } catch { return false }
    },
  })
  sleep(fixture ? 0.2 : 1)
}
export function handleSummary(data) {
  return { [__ENV.P3_SUMMARY_PATH || "summary.json"]: JSON.stringify(data, null, 2) }
}
