// App attribution, endpoint patterns and auto-tags for captured requests.

const ANALYTICS = [
  "graph.facebook.com", "facebook.com/tr", "app-measurement.com", "google-analytics.com",
  "firebaselogging", "crashlytics", "appsflyer", "adjust.com", "adjust.world", "branch.io",
  "amplitude.com", "mixpanel.com", "segment.io", "segment.com", "sentry.io", "bugsnag",
  "doubleclick.net", "googlesyndication", "applovin", "unityads", "ironsrc", "onesignal",
  "clarity.ms", "hotjar", "datadoghq", "newrelic", "braze.com", "appboy", "kochava", "singular.net",
  "snapkit.com", "firebaseinstallations.googleapis.com", "firebaseremoteconfig.googleapis.com", "app-analytics-services.com",
];

const SYSTEM = [
  "apple.com", "icloud.com", "icloud-content.com", "mzstatic.com", "apple-cloudkit.com",
  "aaplimg.com", "cdn-apple.com", "apple.news", "itunes.apple.com", "push.apple.com",
];

const STATIC_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|woff2?|ttf|otf|mp4|m3u8|ts|webm|mp3|aac|m4a|heic)(\?|$)/i;

// Generic UA tokens that are never an app name.
const UA_SKIP = new Set(["Mozilla", "CFNetwork", "Darwin", "okhttp", "Dalvik", "com.apple.trustd", "nsurlsessiond"]);

const hostMatches = (host, list) => list.some((d) => host === d || host.endsWith("." + d) || host.includes(d));

export function isSystemHost(host) {
  return hostMatches(host, SYSTEM);
}

export function endpointPattern(path) {
  const clean = (path || "/").split("?")[0];
  return clean
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return ":id";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":uuid";
      if (/^[0-9a-f]{16,}$/i.test(seg)) return ":hash";
      if (seg.length >= 24 && /^[A-Za-z0-9_\-=.]+$/.test(seg) && /\d/.test(seg)) return ":token";
      return seg;
    })
    .join("/");
}

function header(headers, name) {
  const v = headers?.[name];
  return Array.isArray(v) ? v[0] : v;
}

export class AppDetector {
  constructor(store) {
    this.store = store;
    this.hostMap = new Map(store.loadHostMap().map((r) => [r.host, r.app]));
    this.recent = []; // [{app, ts}] strongly-identified requests, for shared SDK domains
  }

  learn(host, app, source = "auto") {
    if (!app || app === "Unknown") return;
    const existing = this.hostMap.get(host);
    if (existing === app) return;
    // Never let a weak signal overwrite a user-confirmed mapping.
    if (existing && source === "auto" && this.store.hostMapSource(host) === "user") return;
    this.hostMap.set(host, app);
    this.store.saveHostMap(host, app, source);
  }

  detect({ host, headers, ts }) {
    const ua = header(headers, "user-agent") || "";
    const shared = hostMatches(host, ANALYTICS);
    const result = this.#detect(host, ua, headers, ts, shared);
    if (result.confidence >= 0.9) {
      this.recent.push({ app: result.app, ts });
      if (this.recent.length > 50) this.recent.shift();
      if (!shared && !isSystemHost(host)) this.learn(host, result.app);
    }
    return result;
  }

  #detect(host, ua, headers, ts, shared) {
    // 1. "AppName/1.2.3 CFNetwork/... Darwin/..." or "AppName/1.2 (iPhone; iOS 17; ...)"
    const m = ua.match(/^([^/\s]+)\/[\w.]+/);
    if (m && !UA_SKIP.has(m[1]) && !/^\d/.test(m[1])) {
      return { app: decodeURIComponent(m[1]).replace(/%20/g, " "), confidence: 0.95 };
    }
    // 2. App identity headers.
    const bundle = header(headers, "x-bundle-id") || header(headers, "x-app-id") ||
      header(headers, "x-app-name") || header(headers, "x-client-app") || header(headers, "x-requested-with");
    if (bundle) return { app: String(bundle), confidence: 0.9 };
    if (header(headers, "x-tt-app") || header(headers, "x-argus") || header(headers, "x-gorgon")) return { app: "TikTok", confidence: 0.9 };

    if (isSystemHost(host)) return { app: "iOS System", confidence: 0.8 };

    // 3. Learned host → app map.
    const known = this.hostMap.get(host);
    if (known && !shared) return { app: known, confidence: 0.8 };

    // 4. Shared SDK domain: attribute to the app that was active most recently.
    if (shared) {
      const last = this.recent[this.recent.length - 1];
      if (last && ts - last.ts < 3000) return { app: last.app, confidence: 0.5 };
    }

    // 5. Browsers.
    if (/CriOS/.test(ua)) return { app: "Chrome", confidence: 0.8 };
    if (/Mobile\/\w+.*Safari/.test(ua)) return { app: "Safari", confidence: 0.7 };
    if (/Mobile\/\w+$/.test(ua) || /\(iPhone;.*Mobile\/\w+\)?$/.test(ua)) return { app: "In-app WebView", confidence: 0.4 };

    return { app: "Unknown", confidence: 0 };
  }
}

export function computeTags({ host, path, reqHeaders, status, contentType, duration, error }) {
  const tags = new Set();
  if (reqHeaders?.authorization || reqHeaders?.cookie || reqHeaders?.["x-api-key"]) tags.add("auth");
  if (hostMatches(host, ANALYTICS)) tags.add("analytics");
  if (isSystemHost(host)) tags.add("system");
  if (STATIC_EXT.test(path || "") || /^(image|font|video|audio)\//.test(contentType || "") || /css|javascript/.test(contentType || "")) tags.add("static");
  else if (/json|graphql|protobuf|grpc|x-www-form-urlencoded/.test(contentType || "")) tags.add("api");
  if (status >= 400) tags.add("error");
  if (duration > 1000) tags.add("slow");
  if (error) tags.add("failed");
  return [...tags];
}
