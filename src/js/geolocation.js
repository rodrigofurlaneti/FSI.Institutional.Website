// src/js/geolocation.js
(function () {
  const CACHE_KEY = "fsi.clientGeo";
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const DEBUG = true;

  // 👇 ajude-se com variáveis de ambiente (mesmo domínio vs. API externa)
  const GEO_ENDPOINT = "https://localhost:7136/api/geolocation";
  // Ex.: const GEO_ENDPOINT = "https://api.seudominio.com/api/geolocation";

  function dlog(...a){ if (DEBUG) console.log("[Geo]", ...a); }
  function derr(...a){ if (DEBUG) console.warn("[Geo:warn]", ...a); }
  const now = () => Date.now();

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

  function getEnvInfo(){
    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; }})();
    const connRaw = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const conn = connRaw ? {
      effectiveType: connRaw.effectiveType ?? null,
      downlink: connRaw.downlink ?? null,
      rtt: connRaw.rtt ?? null,
      saveData: connRaw.saveData ?? null
    } : null;

    return {
      ua: navigator.userAgent || null,
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
      connection: conn
    };
  }

  function setDom(fields){
    // fields = { geo: {...}, env: {...} }
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
      referrer: fields.env?.referrer ?? ""
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
      // Se API estiver em outro domínio, use mode:'cors' e configure CORS no backend.
      const res = await fetch(GEO_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // credentials: "include", // só se precisar enviar cookies
        body: JSON.stringify(payload)
      });
      dlog("log response", res.status);
    } catch(e){ derr("postLog error (ignored)", e); }
  }

  async function init(){
    dlog("init start");
    const env = getEnvInfo();

    const cached = readCache();
    if(cached?.coords){
      setDom({ geo: cached.coords, env });
      // ainda assim envia para o backend se quiser contabilizar pageview com cache
      postLog({ geo: cached.coords, env }).catch(()=>{});
      return;
    }

    try {
      // Em debug, para fix fresca: const pos = await getPosition({ maximumAge: 0, timeout: 8000 });
      const pos = await getPosition();
      const place = null; // reverse geocoding desativado
      const geo = pickAllFieldsFrom(pos, place);

      writeCache(geo, place);
      setDom({ geo, env });

      await postLog({ geo, env });
    } catch(err){
      derr("Geolocation failed", err?.message || err);
      // Mesmo se GEO falhar, ainda é útil enviar ENV (sem JWT)
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
