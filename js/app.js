// 水溶液光穿透率量測：MQTT 即時儀表板
// 主題：stu/transmittance/<裝置ID>/{status,event,result,battery,cmd}
(() => {
  const BROKER = "wss://broker.emqx.io:8084/mqtt";   // GitHub Pages 為 HTTPS，需使用 WSS
  const DEFAULT_ID = "Jenny";                         // 須與韌體 DEVICE_ID 相同
  const BAT_STALE_MS = 100000;                        // 超過此時間未收到電池資料視為逾時
  const CH = ["R", "G", "B"];
  const $ = id => document.getElementById(id) || document.createElement("div");   // 缺少元素時不丟例外
  const store = {
    get(k){ try { return localStorage.getItem(k); } catch(e){ return null; } },
    set(k,v){ try { localStorage.setItem(k,v); } catch(e){} }
  };

  const urlId = new URLSearchParams(location.search).get("id");
  let devId = urlId || store.get("devId") || DEFAULT_ID;
  $("devId").value = devId;

  let history = [];
  try { history = JSON.parse(store.get("history") || "[]"); } catch(e){}
  let client = null, devOnline = false, busy = false;
  let bat = null, batAt = 0;

  const fmt = (v,d=3) => (v === null || v === undefined || isNaN(v)) ? "—" : Number(v).toFixed(d);
  const hhmmss = d => new Date(d).toLocaleTimeString("zh-TW",{hour12:false});

  function log(msg){
    const d = document.createElement("div");
    d.innerHTML = `<b>${hhmmss(Date.now())}</b>　${msg}`;
    $("log").prepend(d);
    while ($("log").children.length > 60) $("log").lastChild.remove();
  }

  function setPills(){
    $("pBroker").className = "pill " + (client && client.connected ? "on" : "bad");
    $("pDev").className = "pill " + (devOnline ? "on" : "bad");
    $("pDev").lastChild.textContent = devOnline ? "裝置在線" : "裝置離線";
    $("bRef").disabled = $("bMeas").disabled = !(client && client.connected && devOnline) || busy;
    if (!devOnline && !busy) $("state").textContent = "等待裝置…";
    renderBattery();
  }

  // ---- 電池 ----
  function renderBattery(){
    const el = $("bat");
    el.classList.remove("low","na","stale");
    const stale = bat && (Date.now() - batAt > BAT_STALE_MS);
    if (!bat || !devOnline && !bat) { el.classList.add("na"); $("batPct").textContent = "--"; $("batMv").textContent = "未偵測"; $("batFill").style.width = "0"; $("lowBanner").hidden = true; return; }
    if (!bat.present) { el.classList.add("na"); $("batPct").textContent = "--"; $("batMv").textContent = "未接電池"; $("batFill").style.width = "0"; $("lowBanner").hidden = true; return; }
    $("batPct").textContent = bat.pct + "%";
    $("batMv").textContent = (bat.mv / 1000).toFixed(2) + " V" + (stale || !devOnline ? "（舊）" : "");
    $("batFill").style.width = Math.max(4, Math.min(100, bat.pct)) + "%";
    if (stale || !devOnline) el.classList.add("stale"); else if (bat.low) el.classList.add("low");
    $("lowBanner").hidden = !(bat.low && devOnline && !stale);
  }
  setInterval(renderBattery, 10000);

  // ---- 步驟與結果 ----
  function setSteps(active, finished){
    document.querySelectorAll(".step").forEach(s => {
      s.classList.toggle("act", s.dataset.c === active);
      s.classList.toggle("fin", finished.includes(s.dataset.c));
    });
  }
  const QTXT = { ok:"", low:"訊號過低（<150 mV）", sat:"訊號接近飽和", weak:"亮暗差太小", gt1:"T 大於 1，請確認參考值" };
  function showResult(r){
    CH.forEach((c,i) => {
      $("d"+c).textContent = (r.D && r.L) ? `暗 ${r.D[i]}／亮 ${r.L[i]} mV` : "";
      $("w"+c).textContent = QTXT[(r.q || [])[i]] || "";
      $("t"+c).textContent = fmt(r.T[i]);
      $("a"+c).textContent = "A = " + fmt(r.A[i]);
      const t = r.T[i] === null ? 0 : Math.max(0, Math.min(1, r.T[i]));
      $("bar"+c).style.width = (t*100) + "%";
    });
  }
  const flash = el => { el.classList.add("flash"); setTimeout(()=>el.classList.remove("flash"), 900); };

  // ---- MQTT ----
  function connect(){
    if (client) { client.removeAllListeners(); client.end(true); }
    devOnline = false; busy = false; bat = null; setPills();
    const base = `stu/transmittance/${devId}`;
    $("topicNote").textContent = base + "/…";
    client = mqtt.connect(BROKER, { reconnectPeriod: 3000, connectTimeout: 8000,
      clientId: "web-" + Math.random().toString(16).slice(2,10) });
    client.on("connect", () => {
      log("已連上 broker");
      client.subscribe(["status","event","result","battery"].map(k => `${base}/${k}`), {qos:1});
      setPills();
    });
    client.on("close", () => { devOnline = false; setPills(); });
    client.on("error", e => log("連線錯誤：" + e.message));
    client.on("message", (topic, payload, pkt) => {
     try {
      const s = payload.toString(); const k = topic.slice(base.length+1);
      let j = null; if (k !== "status") { try { j = JSON.parse(s); } catch(_) { return; } }
      if (k === "status") {
        devOnline = (s === "online"); busy = false; setPills();
        log("裝置狀態：<b>" + s + "</b>");
        if (devOnline) $("state").textContent = "待機";
      } else if (k === "event") onEvent(j);
      else if (k === "battery") {
        const wasLow = bat && bat.low;
        bat = j; batAt = Date.now(); renderBattery();
        if (j.low && !wasLow && !pkt.retain) log("電池電量偏低：<b>" + j.pct + "%</b>");
      } else if (k === "result") {
        showResult(j);
        if (pkt.retain) { log("載入最後一筆結果 #" + j.seq); return; }
        const bad = CH.filter((c,i) => j.q && j.q[i] && j.q[i] !== "ok").map(c => c + "：" + QTXT[j.q[CH.indexOf(c)]]);
        if (bad.length) log("訊號品質警告　" + bad.join("；"));
        if (j.kind === "meas") addRow(j);
      }
     } catch (err) { log("訊息處理錯誤：" + err.message); }
    });
  }

  const finished = [];
  function onEvent(e){
    const who = {device:"實體按鈕", web:"網頁", serial:"序列埠"}[e.src] || e.src;
    const what = e.name === "ref" ? "記錄參考值" : "量測樣品";
    if (e.type === "btn") {
      finished.length = 0; busy = true; setPills(); setSteps(null, []);
      $("state").textContent = what + "…";
      $("srcNote").textContent = "由「" + who + "」觸發";
      if (e.src === "device") flash(e.name === "ref" ? $("ledRef") : $("ledMeas"));
      log(who + " 按下 <b>" + (e.name === "ref" ? "REF" : "MEAS") + "</b>");
    } else if (e.type === "progress") {
      const i = CH.indexOf(e.ch); finished.length = 0; for (let j=0;j<i;j++) finished.push(CH[j]);
      setSteps(e.ch, finished);
      $("state").textContent = what + "：" + e.ch + " 通道";
    } else if (e.type === "done") {
      busy = false; setSteps(null, CH); setPills();
      $("state").textContent = e.name === "ref" ? "參考值已記錄" : "量測完成";
      log(what + "完成");
    } else if (e.type === "error") {
      busy = false; setPills(); setSteps(null, []);
      $("state").textContent = e.name === "no_ref" ? "請先記錄純水參考值" : e.name === "btn_short" ? "按鈕接線異常：GPIO18、19 短路" : "發生錯誤";
      log("錯誤：" + e.name);
    }
  }

  function send(cmd){
    if (!client || !client.connected) return;
    client.publish(`stu/transmittance/${devId}/cmd`, cmd, {qos:1});
    log("網頁送出指令 <b>" + cmd + "</b>");
  }
  $("bRef").onclick = () => send("ref");
  $("bMeas").onclick = () => send("meas");
  $("bApply").onclick = () => { devId = $("devId").value.trim() || DEFAULT_ID; store.set("devId", devId); connect(); };

  // ---- 紀錄 ----
  function addRow(r){
    history.push({ n: (history.length ? history[history.length-1].n : 0) + 1, ts: Date.now(), label: $("label").value.trim(), T: r.T, A: r.A });
    store.set("history", JSON.stringify(history.slice(-200)));
    renderTable(); drawChart();
  }
  function renderTable(){
    const tb = $("tbl").tBodies[0]; tb.innerHTML = "";
    history.slice().reverse().forEach(h => {
      const tr = document.createElement("tr");
      [h.n, hhmmss(h.ts), h.label || "", ...h.T.map(v=>fmt(v)), ...h.A.map(v=>fmt(v))].forEach(c => {
        const td = document.createElement("td"); td.textContent = c; tr.appendChild(td); });
      tb.appendChild(tr);
    });
    $("empty").style.display = history.length ? "none" : "block";
  }
  $("bClear").onclick = () => { if (history.length && !confirm("確定清除全部紀錄？")) return; history = []; store.set("history","[]"); renderTable(); drawChart(); };
  $("bCsv").onclick = () => {
    const q = s => '"' + String(s).replace(/"/g,'""') + '"';
    const body = history.map(h => [h.n, new Date(h.ts).toISOString(), q(h.label||""), ...h.T, ...h.A].join(",")).join("\n");
    const blob = new Blob(["﻿n,time,label,T_R,T_G,T_B,A_R,A_G,A_B\n"+body], {type:"text/csv;charset=utf-8"});
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = "transmittance_" + new Date().toISOString().slice(0,19).replace(/[:T]/g,"") + ".csv"; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
  };

  // ---- 圖表 ----
  function drawChart(){
    const cv = $("chart"), dpr = devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight; if (!w) return;
    cv.width = w*dpr; cv.height = h*dpr;
    const g = cv.getContext("2d"); g.setTransform(dpr,0,0,dpr,0,0); g.clearRect(0,0,w,h);
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue("--muted").trim(), line = css.getPropertyValue("--line").trim();
    const cols = ["--r","--g","--b"].map(v => css.getPropertyValue(v).trim());
    const L=38,R=10,T=8,B=24, pw=w-L-R, ph=h-T-B;
    let max = 0.4; history.forEach(x => x.A.forEach(v => { if (v !== null && v > max) max = v; }));
    max = Math.ceil(max/0.4)*0.4;
    g.font = "11px system-ui"; g.fillStyle = ink; g.strokeStyle = line; g.lineWidth = 1;
    for (let i=0;i<=4;i++){ const y = T+ph-ph*i/4; g.beginPath(); g.moveTo(L,y); g.lineTo(w-R,y); g.stroke();
      g.textAlign="right"; g.fillText((max*i/4).toFixed(1), L-5, y+4); }
    g.textAlign="center";
    if (!history.length) { g.fillText("尚無資料", L+pw/2, T+ph/2); return; }
    const n = history.length, xs = i => L + (n===1 ? pw/2 : pw*i/(n-1));
    for (let c=0;c<3;c++){
      g.strokeStyle = cols[c]; g.fillStyle = cols[c]; g.lineWidth = 2; g.beginPath(); let st = false;
      history.forEach((x,i) => { const v = x.A[c]; if (v === null) return;
        const px = xs(i), py = T+ph-ph*Math.min(v,max)/max; if (!st) { g.moveTo(px,py); st = true; } else g.lineTo(px,py); });
      g.stroke();
      history.forEach((x,i) => { const v = x.A[c]; if (v===null) return; g.beginPath(); g.arc(xs(i), T+ph-ph*Math.min(v,max)/max, 3, 0, 7); g.fill(); });
    }
    g.fillStyle = ink; const step = Math.max(1, Math.ceil(n/8));
    history.forEach((x,i) => { if (i % step === 0) g.fillText(x.n, xs(i), T+ph+15); });
  }
  addEventListener("resize", drawChart);

  // ---- PWA ----
  if ("serviceWorker" in navigator && (location.protocol === "https:" || ["localhost","127.0.0.1"].includes(location.hostname))) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  renderTable(); drawChart(); setPills(); connect();
})();
