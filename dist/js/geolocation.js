// src/js/geolocation.js
(function () {
  const CACHE_KEY = "fsi.clientGeo";
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const DEBUG = true;

  //Localhost 
  //const GEO_ENDPOINT = "http://localhost:5136/api/geolocation"; 

  //Prod 
  //const GEO_ENDPOINT = "${location.origin}/api/geolocation"; 
  const GEO_ENDPOINT = 'https://api.furlaneti.com/api/geolocation';

  function dlog(...a){ if (DEBUG) console.log("[Geo]", ...a); }
  function derr(...a){ if (DEBUG) console.warn("[Geo:warn]", ...a); }
  const now = () => Date.now();

  // ---------- BOT / CRAWLER DETECTION ----------
  function detectBot(uaRaw) {
    const ua = (uaRaw || "").toLowerCase();

    // lista enxuta mas bem efetiva (pode estender depois)
    const patterns = [
      "googlebot", "bingbot", "yandexbot", "duckduckbot", "baiduspider", "applebot",
      "facebot", "facebookexternalhit", "twitterbot", "slackbot", "discordbot",
      "linkedinbot", "semrushbot", "ahrefsbot", "mj12bot", "petalbot", "sogou",
      "exabot", "ia_archiver", "adsbot-google", "apis-google", "mediapartners-google"
    ];

    const match = patterns.find(p => ua.includes(p));
    // alguns crawlers se identificam como “Bot/…”
    const generic = /\b(bot|crawler|spider|preview)\b/.test(ua);

    const isBot = Boolean(match || generic);
    const botName = match || (generic ? "GenericBot" : "");
    return { isBot, botName };
  }

  // ---------- DEVICE TYPE DETECTION ----------
  function detectDevice(uaRaw, hints) {
    const ua = (uaRaw || "").toLowerCase();

    // Client Hints: mobile boolean e model ajudam bastante
    const chMobile = typeof hints?.mobile === "boolean" ? hints.mobile : null;
    const chModel = hints?.model || "";

    // heurísticas por UA
    const isIPad = /ipad/.test(ua) || (/macintosh/.test(ua) && 'ontouchstart' in window); // iPadOS 13+ se identifica como Mac
    const isIPhone = /iphone/.test(ua);
    const isAndroid = /android/.test(ua);
    const isAndroidTablet = isAndroid && !/mobile/.test(ua);
    const isTabletKeyword = /(tablet|tab)/.test(ua);
    const isMobileKeyword = /(mobile|phone)/.test(ua);

    let deviceType = "desktop";
    if (chMobile === true || isIPhone || (isAndroid && !isAndroidTablet) || isMobileKeyword) {
      deviceType = "mobile";
    } else if (isIPad || isAndroidTablet || isTabletKeyword) {
      deviceType = "tablet";
    }

    // modelo: prioriza Client Hints; senão alguns palpites
    let deviceModel = chModel || "";
    if (!deviceModel) {
      if (isIPhone) deviceModel = "iPhone";
      else if (isIPad) deviceModel = "iPad";
      else if (isAndroid) {
        const m = ua.match(/(sm-[\w-]+|moto[\w-]+|pixel [\w-]+|mi [\w-]+|redmi [\w-]+|oneplus [\w-]+)/i);
        if (m) deviceModel = m[0];
      }
    }

    // sinal de toque e ponteiros (mais heurísticas, só para enriquecer)
    const touchPoints = navigator.maxTouchPoints || 0;
    return { deviceType, deviceModel, touchPoints };
  }

  // ---------- UA PARSER (fallback) ----------
  function parseUA(uaRaw) {
    const ua = (uaRaw || "").trim();
    const rx = (r) => r.exec(ua);
    const ver = (m, i=1) => (m && m[i]) ? m[i].replace(/_/g, ".") : "";
    const has = (s) => ua.toLowerCase().includes(s.toLowerCase());

    // Browser
    let browser = "Unknown", browserVersion = "";
    let m;

    if (m = rx(/SamsungBrowser\/([\d.]+)/)) { browser = "Samsung Internet"; browserVersion = ver(m); }
    else if (m = rx(/Edg\/([\d.]+)/))      { browser = "Microsoft Edge";  browserVersion = ver(m); }
    else if (m = rx(/OPR\/([\d.]+)/))      { browser = "Opera";           browserVersion = ver(m); }
    else if (!has("crios") && (m = rx(/Chrome\/([\d.]+)/))) { browser = "Chrome"; browserVersion = ver(m); }
    else if (m = rx(/CriOS\/([\d.]+)/))    { browser = "Chrome (iOS)";    browserVersion = ver(m); }
    else if (m = rx(/Firefox\/([\d.]+)/))  { browser = "Firefox";         browserVersion = ver(m); }
    else if (m = rx(/FxiOS\/([\d.]+)/))    { browser = "Firefox (iOS)";   browserVersion = ver(m); }
    else if (has("safari") && !has("chrome") && (m = rx(/Version\/([\d.]+)/))) { browser = "Safari"; browserVersion = ver(m); }
    else if (has("; wv") || has(" wv)")) {
      browser = "Android WebView";
      m = rx(/Version\/([\d.]+)/);
      browserVersion = ver(m) || "";
    } else if (m = rx(/AppleWebKit\/([\d.]+)/)) {
      browser = "WebKit-based"; browserVersion = ver(m);
    }

    // SO + versão
    let operatingSystem = "Unknown", osVersion = "";
    if (m = rx(/Windows NT ([\d.]+)/)) {
      operatingSystem = "Windows";
      const map = { "10.0":"10/11", "6.3":"8.1", "6.2":"8", "6.1":"7", "6.0":"Vista", "5.1":"XP" };
      const nt = ver(m);
      osVersion = map[nt] ? map[nt] : nt;
    }
    else if (m = rx(/iPhone OS ([\d_]+)/)) { operatingSystem = "iOS";    osVersion = ver(m); }
    else if (m = rx(/CPU OS ([\d_]+)/))    { operatingSystem = "iOS";    osVersion = ver(m); }
    else if (m = rx(/iPad; CPU ([\w ]+) OS ([\d_]+)/)) { operatingSystem = "iPadOS"; osVersion = ver(m, 2); }
    else if (m = rx(/Mac OS X ([\d_]+)/))  { operatingSystem = "macOS";  osVersion = ver(m); }
    else if (m = rx(/Android ([\d.]+)/))   { operatingSystem = "Android";osVersion = ver(m); }
    else if (/Linux/i.test(ua))            { operatingSystem = "Linux";  }

    // Arquitetura
    let architecture = "";
    if (/(WOW64|Win64|x64|amd64)/i.test(ua)) architecture = "x64";
    else if (/(arm64|aarch64)/i.test(ua))    architecture = "arm64";
    else if (/(i686|x86)/i.test(ua))         architecture = "x86";

    return { browser, browserVersion, operatingSystem, osVersion, architecture };
  }

  // ---------- Client Hints + enrich ----------
  async function getEnvInfoAsync() {
    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }})();
    const connRaw = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const connection = connRaw ? {
      effectiveType: connRaw.effectiveType ?? null,
      downlink: connRaw.downlink ?? null,
      rtt: connRaw.rtt ?? null,
      saveData: connRaw.saveData ?? null
    } : null;

    const ua = navigator.userAgent || null;
    let parsed = parseUA(ua);

    // tenta UA Client Hints
    let ch = { brands: [], mobile: null, model: "", uaFullVersion: "", platform: "", platformVersion: "", architecture: "", bitness: "" };
    try {
      if (navigator.userAgentData) {
        ch.brands = navigator.userAgentData.brands || [];
        ch.mobile = navigator.userAgentData.mobile ?? null;

        if (navigator.userAgentData.getHighEntropyValues) {
          const hi = await navigator.userAgentData.getHighEntropyValues([
            "architecture", "bitness", "platform", "platformVersion", "model", "uaFullVersion"
          ]);
          Object.assign(ch, hi);
        }

        // Browser via brands
        if (ch.brands?.length) {
          const brand = ch.brands.find(b => !/Not.*Brand/i.test(b.brand)) || ch.brands[0];
          if (brand?.brand) {
            parsed.browser = parsed.browser === "Unknown" ? brand.brand : parsed.browser;
            parsed.browserVersion = ch.uaFullVersion || brand.version || parsed.browserVersion;
          }
        }
        if (ch.platform) parsed.operatingSystem = parsed.operatingSystem === "Unknown" ? ch.platform : parsed.operatingSystem;
        if (ch.platformVersion) parsed.osVersion = parsed.osVersion || ch.platformVersion;
        if (ch.architecture) parsed.architecture = parsed.architecture || ch.architecture;
        else if (ch.bitness === "64") parsed.architecture = parsed.architecture || "x64";
      }
    } catch { /* silencioso */ }

    const bot = detectBot(ua);
    const device = detectDevice(ua, { mobile: ch.mobile, model: ch.model });

    return {
      ua,
      browser: parsed.browser || "",
      browserVersion: parsed.browserVersion || "",
      operatingSystem: parsed.operatingSystem || "",
      osVersion: parsed.osVersion || "",
      architecture: parsed.architecture || "",
      deviceType: device.deviceType,
      deviceModel: device.deviceModel,
      touchPoints: device.touchPoints,
      isBot: bot.isBot,
      botName: bot.botName,
      language: navigator.language || null,
      languages: navigator.languages || null,
      platform: navigator.platform || null,
      online: typeof navigator.onLine === "boolean" ? navigator.onLine : null,
      timeZone: tz,
      screenWidth: window.screen?.width ?? null,
      screenHeight: window.screen?.height ?? null,
      dpr: window.devicePixelRatio || 1,
      referrer: document.referrer || null,
      page: location?.href || null,
      connection
    };
  }

  function readCache(){
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if(!raw) return null;
      const data = JSON.parse(raw);
      if(!data || !data.ts || (now() - data.ts) > CACHE_TTL_MS) return null;
      dlog("cache hit", data);
      return data;
    } catch(e){ derr("readCache error", e); return null; }
  }
  function writeCache(coords, place){
    try {
      const payload = { ts: now(), coords, place: place || null };
      localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
      dlog("cache write", payload);
    } catch(e){ derr("writeCache error", e); }
  }

  function getPosition(options){
    return new Promise((resolve, reject) => {
      if(!navigator.geolocation?.getCurrentPosition)
        return reject(new Error("Geolocation not supported"));
      let settled = false;
      const opt = Object.assign({ enableHighAccuracy: true, maximumAge: 600000, timeout: 10000 }, options||{});
      dlog("calling geolocation with", opt);
      const timer = setTimeout(() => { if(!settled){ settled = true; reject(new Error("Geolocation timeout")); } }, opt.timeout);
      navigator.geolocation.getCurrentPosition(
        pos => { if(!settled){ settled = true; clearTimeout(timer); resolve(pos); } },
        err => { if(!settled){ settled = true; clearTimeout(timer); reject(err); } },
        opt
      );
    });
  }

  function pickAllFieldsFrom(pos, place){
    const c = pos.coords;
    return {
      lat: c.latitude,
      lon: c.longitude,
      accuracy: c.accuracy ?? null,
      altitude: c.altitude ?? null,
      altitudeAccuracy: c.altitudeAccuracy ?? null,
      speed: c.speed ?? null,
      heading: c.heading ?? null,
      ts: pos.timestamp || Date.now(),
      city: place || null
    };
  }

  function setDom(fields){
    const flat = {
      lat: fields.geo?.lat ?? null,
      lon: fields.geo?.lon ?? null,
      accuracy: fields.geo?.accuracy ?? null,
      altitude: fields.geo?.altitude ?? null,
      altitudeAccuracy: fields.geo?.altitudeAccuracy ?? null,
      speed: fields.geo?.speed ?? null,
      heading: fields.geo?.heading ?? null,
      ts: fields.geo?.ts ?? null,
      city: fields.geo?.city ?? "",
      ua: fields.env?.ua ?? "",
      language: fields.env?.language ?? "",
      timeZone: fields.env?.timeZone ?? "",
      screenWidth: fields.env?.screenWidth ?? null,
      screenHeight: fields.env?.screenHeight ?? null,
      dpr: fields.env?.dpr ?? null,
      online: fields.env?.online ?? null,
      connectionType: fields.env?.connection?.effectiveType ?? "",
      connectionDownlink: fields.env?.connection?.downlink ?? null,
      connectionRtt: fields.env?.connection?.rtt ?? null,
      saveData: fields.env?.connection?.saveData ?? null,
      platform: fields.env?.platform ?? "",
      page: fields.env?.page ?? "",
      referrer: fields.env?.referrer ?? "",
      browser: fields.env?.browser ?? "",
      browserVersion: fields.env?.browserVersion ?? "",
      operatingSystem: fields.env?.operatingSystem ?? "",
      osVersion: fields.env?.osVersion ?? "",
      architecture: fields.env?.architecture ?? "",
      deviceType: fields.env?.deviceType ?? "",
      deviceModel: fields.env?.deviceModel ?? "",
      touchPoints: fields.env?.touchPoints ?? 0,
      isBot: fields.env?.isBot ?? false,
      botName: fields.env?.botName ?? ""
    };

    const map = new Map(Object.entries(flat));
    document.querySelectorAll("[data-geo]").forEach(el => {
      const key = el.getAttribute("data-geo");
      if(!key) return;
      if(key === "lat" && typeof flat.lat === "number") el.textContent = flat.lat.toFixed(6);
      else if(key === "lon" && typeof flat.lon === "number") el.textContent = flat.lon.toFixed(6);
      else if(key === "accuracy" && flat.accuracy != null) el.textContent = Math.round(flat.accuracy).toString();
      else if(key === "altitude" && flat.altitude != null) el.textContent = flat.altitude.toFixed(1);
      else if(key === "altitudeAccuracy" && flat.altitudeAccuracy != null) el.textContent = Math.round(flat.altitudeAccuracy).toString();
      else if(key === "speed" && flat.speed != null) el.textContent = flat.speed.toFixed(2);
      else if(key === "heading" && flat.heading != null) el.textContent = flat.heading.toFixed(0);
      else if(key === "ts" && flat.ts != null) el.textContent = new Date(flat.ts).toLocaleString();
      else if(map.has(key)) el.textContent = String(map.get(key) ?? "");
    });

    window.__fsiGeo = fields;
    dlog("DOM set", fields);
    window.dispatchEvent(new CustomEvent("fsi:geo", { detail: fields }));
  }

  async function postLog(payload){
    try {
      dlog("posting", GEO_ENDPOINT, payload);
      const res = await fetch(GEO_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      dlog("log response", res.status);
    } catch(e){ derr("postLog error (ignored)", e); }
  }

  async function init(){
    dlog("init start");
    const env = await getEnvInfoAsync();

    const cached = readCache();
    if(cached?.coords){
      setDom({ geo: cached.coords, env });
      postLog({ geo: cached.coords, env }).catch(()=>{});
      return;
    }

    try {
      const pos = await getPosition();
      const place = null; // reverse geocoding desativado
      const geo = pickAllFieldsFrom(pos, place);

      writeCache(geo, place);
      setDom({ geo, env });

      await postLog({ geo, env });
    } catch(err){
      derr("Geolocation failed", err?.message || err);
      await postLog({ geo: null, env, error: (err?.message || String(err)) }).catch(()=>{});
    }
  }

  if(document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.addEventListener("fsi:geo", (e) => dlog("ready (event)", e.detail));
})();
