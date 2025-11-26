#!/usr/bin/env node
/**
 * OpenBCI WiFi Shield -> Virtual COM bridge for BioEra
 *
 * Data path:
 *   WiFiShield (TCP RAW 33-byte frames) -> this TCP server -> SerialPort (com0com) -> BioEra
 *
 * Command path:
 *   BioEra -> SerialPort -> this -> HTTP POST /command -> WiFiShield -> Cyton
 *
 * Config:
 *   - Reads from .env (dotenv). CLI args override env for base params.
 *
 * Node >= 18 recommended (built-in fetch).
 */

 require("dotenv").config();

 const net = require("net");
 const os = require("os");
 const { SerialPort } = require("serialport");
 
 // ---------------- CLI ----------------
 function arg(name, def = undefined) {
   const i = process.argv.indexOf(`--${name}`);
   if (i === -1) return def;
   const v = process.argv[i + 1];
   if (!v || v.startsWith("--")) return true;
   return v;
 }
 
 // env-first, args override
 const shieldIp = arg("shieldIp", process.env.SHIELD_IP);
 const serialPath = arg("serial", process.env.SERIAL_PORT);
 const tcpPort = Number(arg("tcpPort", process.env.TCP_PORT ?? "9000"));
 const localIp = arg("localIp", process.env.LOCAL_IP);
 const latencyUs = Number(arg("latencyUs", process.env.LATENCY_US ?? "200"));
 const initCmd = String(arg("init", process.env.INIT_CMD ?? "") || "").trim();
 const verbose = !!(
   arg("verbose", false) ||
   process.env.VERBOSE === "1" ||
   process.env.VERBOSE === "true"
 );
 const statsMs = Number(arg("statsMs", process.env.STATS_MS ?? "1000"));
 
 if (!shieldIp || !serialPath || !localIp) {
   console.error(`
 Usage:
   node bridge.js
 
 Or with args (override .env):
   node bridge.js --shieldIp 192.168.10.106 --localIp 192.168.10.101 --tcpPort 9000 --serial COM7 --latencyUs 200 --init "/0d~6" --verbose
 
 Required (via .env or args):
   - SHIELD_IP / --shieldIp
   - LOCAL_IP  / --localIp
   - SERIAL_PORT / --serial
 
 Optional:
   - TCP_PORT / --tcpPort (default 9000)
   - LATENCY_US / --latencyUs (default 200)
   - INIT_CMD / --init (default empty)
   - CH1..CHn (channel config commands, optional)
   - VERBOSE / --verbose (default false)
   - STATS_MS / --statsMs (default 1000)
 `);
   process.exit(1);
 }
 
 const LOG = (...a) => console.log(...a);
 const VLOG = (...a) => {
   if (verbose) console.log(...a);
 };
 
 // ---------------- Helpers ----------------
 function guessLocalIps() {
   const ifs = os.networkInterfaces();
   const ips = [];
   for (const [name, entries] of Object.entries(ifs)) {
     for (const e of entries || []) {
       if (e.family === "IPv4" && !e.internal) ips.push({ name, ip: e.address });
     }
   }
   return ips;
 }
 
 function toHex(buf, max = 64) {
   const b = Buffer.from(buf);
   const take = b.subarray(0, max);
   const hex = [...take].map((x) => x.toString(16).padStart(2, "0")).join(" ");
   const more = b.length > max ? ` …(+${b.length - max})` : "";
   return hex + more;
 }
 
 function toAscii(buf, max = 64) {
   const b = Buffer.from(buf);
   const take = b.subarray(0, max);
   const s = [...take]
     .map((x) => (x >= 32 && x <= 126 ? String.fromCharCode(x) : "."))
     .join("");
   const more = b.length > max ? ` …(+${b.length - max})` : "";
   return s + more;
 }
 
 function logHttp(prefix, r) {
   LOG(`${prefix} => ${r.status} ${r.ok ? "OK" : "FAIL"} ${r.text || ""}`);
 }
 
 // Read sequential channel commands from env: CH1, CH2, ... until missing
 function readChannelCmdsFromEnv() {
   const out = [];
   for (let i = 1; i <= 32; i++) {
     const key = `CH${i}`;
     const v = process.env[key];
     if (v === undefined) break; // stop on first missing
     const cmd = String(v).trim();
     if (!cmd) break;
     out.push({ ch: i, cmd });
   }
   return out;
 }
 
 const channelCmds = readChannelCmdsFromEnv();
 
 async function httpJson(url, body) {
   const r = await fetch(url, {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify(body),
   });
   const txt = await r.text().catch(() => "");
   return { ok: r.ok, status: r.status, text: txt };
 }
 
 async function httpGet(url) {
   const r = await fetch(url, { method: "GET" });
   const txt = await r.text().catch(() => "");
   return { ok: r.ok, status: r.status, text: txt };
 }
 
 // /command schema differs between firmware versions; try JSON then fallback to text/plain
 async function sendShieldCommand(cmd) {
   const url = `http://${shieldIp}/command`;
   VLOG(`[HTTP] -> /command JSON: ${JSON.stringify(cmd)}`);
   let r = await httpJson(url, { command: cmd });
   if (r.ok) return r;
 
   VLOG(`[HTTP] -> /command text/plain fallback: ${String(cmd)}`);
   const rr = await fetch(url, {
     method: "POST",
     headers: { "Content-Type": "text/plain" },
     body: String(cmd),
   });
   const txt = await rr.text().catch(() => "");
   return { ok: rr.ok, status: rr.status, text: txt };
 }
 
 // Serialize commands to preserve order
 let cmdQ = Promise.resolve();
 let cmdQueueDepth = 0;
 function queueCmd(cmd) {
   cmdQueueDepth++;
   const queuedAt = Date.now();
   VLOG(`[Queue] +1 depth=${cmdQueueDepth} cmd=${JSON.stringify(cmd)}`);
 
   cmdQ = cmdQ
     .then(async () => {
       const age = Date.now() - queuedAt;
       VLOG(`[Queue] run age=${age}ms cmd=${JSON.stringify(cmd)}`);
       const r = await sendShieldCommand(cmd);
       logHttp(`[HTTP] /command "${cmd}"`, r);
     })
     .catch((e) => {
       LOG(`[HTTP] /command "${cmd}" ERROR:`, e?.message || e);
     })
     .finally(() => {
       cmdQueueDepth = Math.max(0, cmdQueueDepth - 1);
       VLOG(`[Queue] -1 depth=${cmdQueueDepth}`);
     });
 
   return cmdQ;
 }
 
 // ---------------- Serial ----------------
 const serial = new SerialPort({
   path: serialPath,
   baudRate: 115200,
   dataBits: 8,
   stopBits: 1,
   parity: "none",
   autoOpen: false,
 });
 
 let currentSocket = null;
 let serverStarted = false;
 let tcpBuffer = Buffer.alloc(0);
 let pausedBySerialBackpressure = false;
 
 // Stats
 const stats = {
   startedAt: Date.now(),
   tcpConnects: 0,
   tcpBytes: 0,
   tcpFramesOk: 0,
   tcpFramesBad: 0,
   serialBytes: 0,
   serialFrames: 0,
   serialBackpressure: 0,
   lastTcpAt: 0,
   lastSerialAt: 0,
   lastBioAt: 0,
   lastStartAt: 0,
   lastStopAt: 0,
 };
 
 // Basic OpenBCI command aggregator
 let cmdBuf = "";
 const singleCharCmd = new Set([
   "b",
   "s",
   "v",
   "?",
   "~",
   "0",
   "1",
   "2",
   "3",
   "4",
   "5",
   "6",
   "7",
   "8",
   "9",
   "!",
   "@",
   "#",
   "$",
   "%",
   "^",
   "&",
   "*",
   "(",
   ")",
   "<",
   ">",
   ",",
   ".",
 ]);
 
 function feedCmdBytes(buf) {
   stats.lastBioAt = Date.now();
   VLOG(`[BioEra->COM] len=${buf.length} hex=${toHex(buf)} ascii="${toAscii(buf)}"`);
 
   for (const byte of buf) {
     const ch = String.fromCharCode(byte);
     if (byte === 0x00) continue;
 
     cmdBuf += ch;
 
     if (ch === "\n" || ch === "\r") {
       const cmd = cmdBuf.trim();
       cmdBuf = "";
       if (cmd) queueCmd(cmd);
       continue;
     }
 
     if (cmdBuf.length === 1 && singleCharCmd.has(cmdBuf)) {
       const cmd = cmdBuf;
       cmdBuf = "";
       queueCmd(cmd);
       continue;
     }
 
     if (ch === "X" || ch === "Z") {
       const cmd = cmdBuf.trim();
       cmdBuf = "";
       if (cmd) queueCmd(cmd);
       continue;
     }
 
     if (cmdBuf.length > 256) {
       VLOG("[BioEra->COM] cmdBuf overflow, reset");
       cmdBuf = "";
     }
   }
 }
 
 function writeToSerial(data) {
   if (!serial.writable) return;
   const ok = serial.write(data);
 
   stats.serialBytes += data.length;
   stats.serialFrames += 1;
   stats.lastSerialAt = Date.now();
 
   if (!ok && currentSocket && !pausedBySerialBackpressure) {
     currentSocket.pause();
     pausedBySerialBackpressure = true;
     stats.serialBackpressure += 1;
     LOG("[Serial] backpressure -> TCP paused");
   }
 }
 
 serial.on("drain", () => {
   if (currentSocket && pausedBySerialBackpressure) {
     currentSocket.resume();
     pausedBySerialBackpressure = false;
     LOG("[Serial] drain -> TCP resumed");
   }
 });
 
 // Parse TCP stream into 33-byte OpenBCI frames
 function processTcpBuffer() {
   while (tcpBuffer.length >= 33) {
     if (tcpBuffer[0] !== 0xa0) {
       const idx = tcpBuffer.indexOf(0xa0);
       if (idx === -1) {
         tcpBuffer = Buffer.alloc(0);
         return;
       }
       tcpBuffer = tcpBuffer.slice(idx);
       continue;
     }
 
     if (tcpBuffer.length < 33) return;
     const frame = tcpBuffer.subarray(0, 33);
     const stop = frame[32];
 
     if ((stop & 0xf0) !== 0xc0) {
       stats.tcpFramesBad += 1;
       tcpBuffer = tcpBuffer.slice(1);
       continue;
     }
 
     stats.tcpFramesOk += 1;
     writeToSerial(frame);
     tcpBuffer = tcpBuffer.slice(33);
   }
 }
 
 // ---------------- TCP server ----------------
 const server = net.createServer((socket) => {
   stats.tcpConnects += 1;
   LOG(`[TCP] Shield connected from ${socket.remoteAddress}:${socket.remotePort} (connects=${stats.tcpConnects})`);
 
   currentSocket = socket;
   socket.setNoDelay(true);
 
   socket.on("data", (chunk) => {
     stats.tcpBytes += chunk.length;
     stats.lastTcpAt = Date.now();
     if (verbose && chunk.length <= 64) {
       VLOG(`[TCP] chunk len=${chunk.length} hex=${toHex(chunk)} ascii="${toAscii(chunk)}"`);
     }
     tcpBuffer = tcpBuffer.length ? Buffer.concat([tcpBuffer, chunk]) : chunk;
     processTcpBuffer();
   });
 
   socket.on("close", () => {
     LOG("[TCP] Shield disconnected");
     if (currentSocket === socket) currentSocket = null;
     tcpBuffer = Buffer.alloc(0);
   });
 
   socket.on("error", (e) => LOG("[TCP] error:", e.message));
 });
 
 server.on("error", (e) => {
   console.error("[TCP server] error:", e.message);
   process.exit(1);
 });
 
 // ---------------- Shield config ----------------
 async function configureShieldTcp() {
   const url = `http://${shieldIp}/tcp`;
   const body = { ip: localIp, port: tcpPort, delimiter: false, latency: latencyUs, output: "raw" };
 
   VLOG(`[HTTP] -> /tcp body=${JSON.stringify(body)}`);
   const r = await httpJson(url, body);
   if (!r.ok) {
     console.warn(`[HTTP] /tcp config failed (${r.status}). Response: ${r.text || "(empty)"}`);
     console.warn(`[HTTP] Retrying without "output"...`);
     const body2 = { ...body };
     delete body2.output;
     const r2 = await httpJson(url, body2);
     logHttp("[HTTP] /tcp retry", r2);
     return r2.ok;
   }
   logHttp("[HTTP] /tcp", r);
   return true;
 }
 
 async function stopStream() {
   stats.lastStopAt = Date.now();
   const r = await httpGet(`http://${shieldIp}/stream/stop`);
   logHttp("[HTTP] /stream/stop", r);
   return r.ok;
 }
 
 async function startStream() {
  stats.lastStartAt = Date.now();

  await stopStream();

  if (initCmd) {
    const init = await sendShieldCommand(initCmd);
    logHttp(`[HTTP] /command init "${initCmd}"`, init);
  } else {
    VLOG("[Init] skipped (initCmd empty)");
  }

  if (channelCmds.length) {
    for (const { ch, cmd } of channelCmds) {
      const r = await sendShieldCommand(cmd);
      logHttp(`[HTTP] /command ch${ch} "${cmd}"`, r);
    }
  } else {
    VLOG("[Channels] skipped (no CH1..CHn in .env)");
  }

  return new Promise((res) => {
    setTimeout(async () => {
      const r = await httpGet(`http://${shieldIp}/stream/start`);
      logHttp("[HTTP] /stream/start", r);
      res(r.ok);
    }, 1000);
  });
}
 
 const startServer = () => {
   if (serverStarted) {
     VLOG("[TCP server] already listening");
     return;
   }
   serverStarted = true;
 
   server.listen(tcpPort, "0.0.0.0", async () => {
     LOG(`[TCP server] listening on 0.0.0.0:${tcpPort}`);
     const ok = await configureShieldTcp();
     if (!ok) console.warn("[Warn] Shield TCP config failed; data may not arrive.");
     LOG(`[Tip] Press Play in BioEra (it should send 'b').`);
   });
 };
 
 // ---------------- Periodic stats ----------------
 setInterval(() => {
   const now = Date.now();
   const up = now - stats.startedAt;
   const ageTcp = stats.lastTcpAt ? now - stats.lastTcpAt : -1;
   const ageSer = stats.lastSerialAt ? now - stats.lastSerialAt : -1;
   const ageBio = stats.lastBioAt ? now - stats.lastBioAt : -1;
 
   LOG(
     `[Stats] up=${up}ms server=${serverStarted ? "ON" : "OFF"} socket=${currentSocket ? "YES" : "NO"} Q=${cmdQueueDepth} | ` +
       `TCP bytes=${stats.tcpBytes} ok=${stats.tcpFramesOk} bad=${stats.tcpFramesBad} age=${ageTcp}ms | ` +
       `SER bytes=${stats.serialBytes} frames=${stats.serialFrames} backpr=${stats.serialBackpressure} age=${ageSer}ms | ` +
       `BioAge=${ageBio}ms`
   );
 }, statsMs);
 
 // ---------------- Main ----------------
 (async () => {
   LOG(`[Info] shieldIp=${shieldIp}, localIp=${localIp}, tcpPort=${tcpPort}, serial=${serialPath}, latencyUs=${latencyUs}`);
   LOG(`[Info] local IPs: ${guessLocalIps().map((x) => `${x.name}:${x.ip}`).join(" | ")}`);
   LOG(`[Info] initCmd=${initCmd ? JSON.stringify(initCmd) : "(none)"} chCmds=${channelCmds.length} verbose=${verbose} statsMs=${statsMs}`);
 
   if (channelCmds.length && verbose) {
     for (const { ch, cmd } of channelCmds) VLOG(`[Channels] CH${ch}=${cmd}`);
   }
 
   await new Promise((res, rej) => serial.open((err) => (err ? rej(err) : res())));
   LOG(`[Serial] opened ${serialPath} @115200`);
 
   serial.on("error", (e) => LOG("[Serial] error:", e.message));
 
   serial.on("data", (buf) => {
     feedCmdBytes(buf);
 
     for (const byte of buf) {
       if (byte === "b".charCodeAt(0)) {
         VLOG("[BioEra] detected 'b' -> scheduling startServer + startStream in 1000ms");
         setTimeout(() => {
           startServer();
           startStream().catch(() => {});
         }, 1000);
       }
       if (byte === "s".charCodeAt(0)) {
         VLOG("[BioEra] detected 's' -> scheduling stopStream in 1000ms");
         setTimeout(() => {
           stopStream().catch(() => {});
         }, 1000);
       }
     }
   });
 })().catch((e) => {
   console.error("[Fatal]", e);
   process.exit(1);
 });
 