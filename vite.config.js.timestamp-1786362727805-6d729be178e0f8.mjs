// vite.config.js
import { defineConfig } from "file:///C:/Users/karth/testDevOrg/node_modules/vite/dist/node/index.js";
import react from "file:///C:/Users/karth/testDevOrg/node_modules/@vitejs/plugin-react/dist/index.js";
import { exec } from "child_process";
import util from "util";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";
var execPromise = util.promisify(exec);
function loadEnv() {
  try {
    const envPath = resolve(process.cwd(), ".env");
    const lines = readFileSync(envPath, "utf8").split("\n");
    const env = {};
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx > 0) env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
    return env;
  } catch {
    return {};
  }
}
var ENV = loadEnv();
var AGENT_ID = "0Xxak000003KiWDCA0";
var AGENT_API_BASE = "https://api.salesforce.com/einstein/ai-agent/v1";
var INSTANCE_URL = ENV.SF_INSTANCE_URL || "https://orgfarm-cba377a47c-dev-ed.develop.my.salesforce.com";
var CLIENT_ID = ENV.SF_CLIENT_ID;
var CLIENT_SECRET = ENV.SF_CLIENT_SECRET;
var ccToken = null;
var ccTokenExpiry = 0;
var cliAuth = null;
var cliAuthTimestamp = 0;
async function getClientCredentialsToken() {
  const now = Date.now();
  if (ccToken && now < ccTokenExpiry) return ccToken;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn("[CC Flow] Missing SF_CLIENT_ID or SF_CLIENT_SECRET in .env");
    return null;
  }
  try {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    });
    const res = await fetch(`${INSTANCE_URL}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    if (!res.ok) {
      const err = await res.text();
      console.warn("[CC Flow] Token request failed:", res.status, err);
      return null;
    }
    const data = await res.json();
    ccToken = data.access_token;
    ccTokenExpiry = now + (7200 - 300) * 1e3;
    console.log("[CC Flow] \u2705 Client Credentials token obtained.");
    return ccToken;
  } catch (e) {
    console.error("[CC Flow] Error:", e.message);
    return null;
  }
}
async function getCliAuth() {
  const now = Date.now();
  if (cliAuth && now - cliAuthTimestamp < 6e4) return cliAuth;
  try {
    const { stdout } = await execPromise("sf org display --json");
    const parsed = JSON.parse(stdout);
    if (parsed.status === 0 && parsed.result) {
      cliAuth = {
        accessToken: parsed.result.accessToken,
        instanceUrl: parsed.result.instanceUrl,
        username: parsed.result.username
      };
      cliAuthTimestamp = now;
      return cliAuth;
    }
  } catch (e) {
    console.warn("[CLI Auth]", e.message);
  }
  return null;
}
async function fetchLiveSalesforceOpportunities() {
  try {
    const query = `SELECT Id, Name, Account.Name, Amount, StageName, CloseDate, Description, Type, LeadSource, Probability FROM Opportunity ORDER BY LastModifiedDate DESC LIMIT 25`;
    const { stdout } = await execPromise(`sf data query --query "${query}" --json`);
    const parsed = JSON.parse(stdout);
    if (parsed.status === 0 && parsed.result?.records) {
      return parsed.result.records.map((rec) => ({
        id: rec.Id,
        name: rec.Name,
        account: rec.Account?.Name || "N/A",
        amount: rec.Amount || 0,
        stage: rec.StageName || "Qualification",
        closeDate: rec.CloseDate || (/* @__PURE__ */ new Date()).toISOString().split("T")[0],
        type: rec.Type || "Standard",
        leadSource: rec.LeadSource || "Salesforce Org",
        probability: rec.Probability || 50,
        description: rec.Description || `${rec.Type || "Enterprise Deal"} sourced via ${rec.LeadSource || "Direct Account Team"}. Win probability: ${rec.Probability || 50}%.`
      }));
    }
  } catch (e) {
    console.warn("[SOQL Bridge]", e.message);
  }
  return [];
}
async function createAgentSession(token) {
  const sessionKey = randomUUID();
  const res = await fetch(`${AGENT_API_BASE}/agents/${AGENT_ID}/sessions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-sfdc-api-version": "1.0"
    },
    body: JSON.stringify({
      externalSessionKey: sessionKey,
      instanceConfig: { endpoint: INSTANCE_URL },
      bypassUser: true
    })
  });
  if (!res.ok) {
    const err = await res.text();
    console.warn("[Agent Session] Create failed:", res.status, err);
    return null;
  }
  const data = await res.json();
  console.log("[Agent Session] \u2705 Created:", data.sessionId);
  return data.sessionId;
}
async function sendAgentMessage(token, sessionId, text, seqId = 1) {
  const res = await fetch(`${AGENT_API_BASE}/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-sfdc-api-version": "1.0"
    },
    body: JSON.stringify({
      message: { sequenceId: seqId, type: "Text", text }
    })
  });
  if (!res.ok) {
    const err = await res.text();
    console.warn("[Agent Message] Send failed:", res.status, err);
    return null;
  }
  const data = await res.json();
  const replies = (data.messages || []).filter((m) => m.type === "Inform" || m.type === "Text" || m.message?.text).map((m) => m.message?.text || m.text || "").filter(Boolean);
  return replies.join("\n") || JSON.stringify(data);
}
async function endAgentSession(token, sessionId) {
  try {
    await fetch(`${AGENT_API_BASE}/sessions/${sessionId}`, {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-sfdc-api-version": "1.0"
      },
      body: JSON.stringify({ reason: "UserRequest" })
    });
    console.log("[Agent Session] Closed:", sessionId);
  } catch (e) {
    console.warn("[Agent Session] Close error:", e.message);
  }
}
async function callAgentHeadless(messageText) {
  const token = await getClientCredentialsToken();
  if (!token) return null;
  const sessionId = await createAgentSession(token);
  if (!sessionId) return null;
  const reply = await sendAgentMessage(token, sessionId, messageText);
  await endAgentSession(token, sessionId);
  return reply;
}
var vite_config_default = defineConfig({
  plugins: [
    react(),
    {
      name: "salesforce-agentforce-live-api",
      configureServer(server) {
        server.middlewares.use("/api/salesforce/opportunities", async (req, res, next) => {
          if (req.method !== "GET") return next();
          res.setHeader("Content-Type", "application/json");
          const opps = await fetchLiveSalesforceOpportunities();
          res.end(JSON.stringify({ success: opps.length > 0, live: opps.length > 0, data: opps }));
        });
        server.middlewares.use("/api/agentforce/analyze", async (req, res, next) => {
          if (req.method !== "POST") return next();
          let body = "";
          req.on("data", (c) => {
            body += c;
          });
          req.on("end", async () => {
            res.setHeader("Content-Type", "application/json");
            const { opportunityId } = JSON.parse(body || "{}");
            try {
              const prompt = `You are the BidSense agent. Analyze Salesforce Opportunity ID: ${opportunityId} for Bid/No-Bid qualification. Use the opportunity details and account history available in Salesforce to make your decision. Respond as a single JSON object with these fields: recommendation ("BID" or "NO-BID"), confidenceScore (0-100 integer), capabilityFit (0-100 integer), customerFit (0-100 integer), commercialFit (0-100 integer), keyFindings (array of objects: {type:"positive"|"warning", text, source}), recommendedActions (array of strings). No markdown. Only valid JSON.`;
              const agentReply = await callAgentHeadless(prompt);
              if (agentReply) {
                console.log("[Headless Analyze] Agent replied:", agentReply.slice(0, 150));
                const jsonMatch = agentReply.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                  const parsed = JSON.parse(jsonMatch[0]);
                  const { stdout } = await execPromise(
                    `sf data query --query "SELECT Id, Name, Account.Name FROM Opportunity WHERE Id='${opportunityId}' LIMIT 1" --json`
                  );
                  const rec = JSON.parse(stdout)?.result?.records?.[0];
                  return res.end(JSON.stringify({
                    success: true,
                    liveOrgExecuted: true,
                    source: "agentforce-headless",
                    data: {
                      opportunityId,
                      opportunityName: rec?.Name || opportunityId,
                      accountName: rec?.Account?.Name || "",
                      agentRawResponse: agentReply,
                      executedInSalesforceOrg: true,
                      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
                      ...parsed
                    }
                  }));
                }
                return res.end(JSON.stringify({
                  success: true,
                  liveOrgExecuted: true,
                  source: "agentforce-headless-text",
                  data: {
                    opportunityId,
                    agentRawResponse: agentReply,
                    recommendation: agentReply.toLowerCase().includes("no-bid") ? "NO-BID" : "BID",
                    executedInSalesforceOrg: true,
                    timestamp: (/* @__PURE__ */ new Date()).toISOString()
                  }
                }));
              }
            } catch (e) {
              console.warn("[Headless Analyze] Error, falling back to Apex REST:", e.message);
            }
            try {
              const auth = await getCliAuth();
              if (auth) {
                const sfRes = await fetch(`${auth.instanceUrl}/services/apexrest/bidsense/agentforce/v1/analyze`, {
                  method: "POST",
                  headers: { "Authorization": `Bearer ${auth.accessToken}`, "Content-Type": "application/json" },
                  body
                });
                if (sfRes.ok) {
                  const sfData = await sfRes.json();
                  return res.end(JSON.stringify({ success: true, liveOrgExecuted: true, source: "apex-rest-llm", data: sfData }));
                }
              }
            } catch (e) {
              console.warn("[Apex REST Fallback]", e.message);
            }
            res.end(JSON.stringify({ success: false, liveOrgExecuted: false }));
          });
        });
        server.middlewares.use("/api/agentforce/chat", async (req, res, next) => {
          if (req.method !== "POST") return next();
          let bodyStr = "";
          req.on("data", (c) => {
            bodyStr += c;
          });
          req.on("end", async () => {
            res.setHeader("Content-Type", "application/json");
            const { opportunityId, question } = JSON.parse(bodyStr || "{}");
            try {
              const prompt = `You are the BidSense agent. The user is asking about Salesforce Opportunity ID: ${opportunityId}. Question: "${question}". Look up the opportunity and account data in Salesforce and answer concisely and professionally.`;
              const agentReply = await callAgentHeadless(prompt);
              if (agentReply) {
                return res.end(JSON.stringify({
                  success: true,
                  liveAgentforce: true,
                  source: "agentforce-headless",
                  reply: agentReply
                }));
              }
            } catch (e) {
              console.warn("[Headless Chat] Error, falling back:", e.message);
            }
            try {
              const auth = await getCliAuth();
              if (auth) {
                const sfRes = await fetch(`${auth.instanceUrl}/services/apexrest/bidsense/agentforce/v1/chat`, {
                  method: "POST",
                  headers: { "Authorization": `Bearer ${auth.accessToken}`, "Content-Type": "application/json" },
                  body: bodyStr
                });
                if (sfRes.ok) {
                  const sfData = await sfRes.json();
                  return res.end(JSON.stringify({ success: true, liveAgentforce: true, source: "apex-rest-llm", reply: sfData.reply }));
                }
              }
            } catch (e) {
              console.warn("[Apex REST Chat Fallback]", e.message);
            }
            res.end(JSON.stringify({ success: false, reply: "Unable to reach Agentforce." }));
          });
        });
      }
    }
  ],
  server: { port: 3e3 }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcuanMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCJDOlxcXFxVc2Vyc1xcXFxrYXJ0aFxcXFx0ZXN0RGV2T3JnXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCJDOlxcXFxVc2Vyc1xcXFxrYXJ0aFxcXFx0ZXN0RGV2T3JnXFxcXHZpdGUuY29uZmlnLmpzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9DOi9Vc2Vycy9rYXJ0aC90ZXN0RGV2T3JnL3ZpdGUuY29uZmlnLmpzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSAndml0ZSc7XG5pbXBvcnQgcmVhY3QgZnJvbSAnQHZpdGVqcy9wbHVnaW4tcmVhY3QnO1xuaW1wb3J0IHsgZXhlYyB9IGZyb20gJ2NoaWxkX3Byb2Nlc3MnO1xuaW1wb3J0IHV0aWwgZnJvbSAndXRpbCc7XG5pbXBvcnQgeyByYW5kb21VVUlEIH0gZnJvbSAnY3J5cHRvJztcbmltcG9ydCB7IHJlYWRGaWxlU3luYyB9IGZyb20gJ2ZzJztcbmltcG9ydCB7IHJlc29sdmUgfSBmcm9tICdwYXRoJztcblxuY29uc3QgZXhlY1Byb21pc2UgPSB1dGlsLnByb21pc2lmeShleGVjKTtcblxuLy8gXHUyNTAwXHUyNTAwIExvYWQgLmVudiBtYW51YWxseSAoVml0ZSdzIGltcG9ydC5tZXRhLmVudiBpcyBmcm9udGVuZC1vbmx5KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbmZ1bmN0aW9uIGxvYWRFbnYoKSB7XG4gIHRyeSB7XG4gICAgY29uc3QgZW52UGF0aCA9IHJlc29sdmUocHJvY2Vzcy5jd2QoKSwgJy5lbnYnKTtcbiAgICBjb25zdCBsaW5lcyA9IHJlYWRGaWxlU3luYyhlbnZQYXRoLCAndXRmOCcpLnNwbGl0KCdcXG4nKTtcbiAgICBjb25zdCBlbnYgPSB7fTtcbiAgICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcbiAgICAgIGNvbnN0IHRyaW1tZWQgPSBsaW5lLnRyaW0oKTtcbiAgICAgIGlmICghdHJpbW1lZCB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoJyMnKSkgY29udGludWU7XG4gICAgICBjb25zdCBpZHggPSB0cmltbWVkLmluZGV4T2YoJz0nKTtcbiAgICAgIGlmIChpZHggPiAwKSBlbnZbdHJpbW1lZC5zbGljZSgwLCBpZHgpLnRyaW0oKV0gPSB0cmltbWVkLnNsaWNlKGlkeCArIDEpLnRyaW0oKTtcbiAgICB9XG4gICAgcmV0dXJuIGVudjtcbiAgfSBjYXRjaCB7IHJldHVybiB7fTsgfVxufVxuXG5jb25zdCBFTlYgPSBsb2FkRW52KCk7XG5cbi8vIFx1MjUwMFx1MjUwMCBBZ2VudCBjb25zdGFudHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5jb25zdCBBR0VOVF9JRCAgICAgICA9ICcwWHhhazAwMDAwM0tpV0RDQTAnOyAgIC8vIEJvdERlZmluaXRpb24uSWRcbmNvbnN0IEFHRU5UX0FQSV9CQVNFID0gJ2h0dHBzOi8vYXBpLnNhbGVzZm9yY2UuY29tL2VpbnN0ZWluL2FpLWFnZW50L3YxJztcbmNvbnN0IElOU1RBTkNFX1VSTCAgID0gRU5WLlNGX0lOU1RBTkNFX1VSTCB8fCAnaHR0cHM6Ly9vcmdmYXJtLWNiYTM3N2E0N2MtZGV2LWVkLmRldmVsb3AubXkuc2FsZXNmb3JjZS5jb20nO1xuY29uc3QgQ0xJRU5UX0lEICAgICAgPSBFTlYuU0ZfQ0xJRU5UX0lEO1xuY29uc3QgQ0xJRU5UX1NFQ1JFVCAgPSBFTlYuU0ZfQ0xJRU5UX1NFQ1JFVDtcblxuLy8gXHUyNTAwXHUyNTAwIFRva2VuIGNhY2hlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbmxldCBjY1Rva2VuID0gbnVsbDsgICAgICAgICAgIC8vIENsaWVudCBDcmVkZW50aWFscyB0b2tlbiAoZm9yIGFwaS5zYWxlc2ZvcmNlLmNvbSlcbmxldCBjY1Rva2VuRXhwaXJ5ID0gMDtcbmxldCBjbGlBdXRoID0gbnVsbDsgICAgICAgICAgIC8vIENMSSBzZXNzaW9uIHRva2VuIChmb3IgU09RTCAvIEFwZXggUkVTVClcbmxldCBjbGlBdXRoVGltZXN0YW1wID0gMDtcblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vLyBDbGllbnQgQ3JlZGVudGlhbHMgRmxvdyBcdTIwMTQgZ2V0cyBwcm9wZXIgdG9rZW4gZm9yIGFwaS5zYWxlc2ZvcmNlLmNvbVxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5hc3luYyBmdW5jdGlvbiBnZXRDbGllbnRDcmVkZW50aWFsc1Rva2VuKCkge1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICBpZiAoY2NUb2tlbiAmJiBub3cgPCBjY1Rva2VuRXhwaXJ5KSByZXR1cm4gY2NUb2tlbjtcblxuICBpZiAoIUNMSUVOVF9JRCB8fCAhQ0xJRU5UX1NFQ1JFVCkge1xuICAgIGNvbnNvbGUud2FybignW0NDIEZsb3ddIE1pc3NpbmcgU0ZfQ0xJRU5UX0lEIG9yIFNGX0NMSUVOVF9TRUNSRVQgaW4gLmVudicpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBib2R5ID0gbmV3IFVSTFNlYXJjaFBhcmFtcyh7XG4gICAgICBncmFudF90eXBlOiAnY2xpZW50X2NyZWRlbnRpYWxzJyxcbiAgICAgIGNsaWVudF9pZDogQ0xJRU5UX0lELFxuICAgICAgY2xpZW50X3NlY3JldDogQ0xJRU5UX1NFQ1JFVFxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYCR7SU5TVEFOQ0VfVVJMfS9zZXJ2aWNlcy9vYXV0aDIvdG9rZW5gLCB7XG4gICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgIGhlYWRlcnM6IHsgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi94LXd3dy1mb3JtLXVybGVuY29kZWQnIH0sXG4gICAgICBib2R5OiBib2R5LnRvU3RyaW5nKClcbiAgICB9KTtcblxuICAgIGlmICghcmVzLm9rKSB7XG4gICAgICBjb25zdCBlcnIgPSBhd2FpdCByZXMudGV4dCgpO1xuICAgICAgY29uc29sZS53YXJuKCdbQ0MgRmxvd10gVG9rZW4gcmVxdWVzdCBmYWlsZWQ6JywgcmVzLnN0YXR1cywgZXJyKTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cblxuICAgIGNvbnN0IGRhdGEgPSBhd2FpdCByZXMuanNvbigpO1xuICAgIGNjVG9rZW4gPSBkYXRhLmFjY2Vzc190b2tlbjtcbiAgICAvLyBTYWxlc2ZvcmNlIENDIHRva2VucyBsYXN0IH4yIGhvdXJzOyByZWZyZXNoIDUgbWluIGVhcmx5XG4gICAgY2NUb2tlbkV4cGlyeSA9IG5vdyArICg3MjAwIC0gMzAwKSAqIDEwMDA7XG4gICAgY29uc29sZS5sb2coJ1tDQyBGbG93XSBcdTI3MDUgQ2xpZW50IENyZWRlbnRpYWxzIHRva2VuIG9idGFpbmVkLicpO1xuICAgIHJldHVybiBjY1Rva2VuO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcignW0NDIEZsb3ddIEVycm9yOicsIGUubWVzc2FnZSk7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vLyBDTEkgc2Vzc2lvbiBhdXRoIFx1MjAxNCBmb3IgU09RTCBxdWVyaWVzIGFuZCBBcGV4IFJFU1QgZmFsbGJhY2tcbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuYXN5bmMgZnVuY3Rpb24gZ2V0Q2xpQXV0aCgpIHtcbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgaWYgKGNsaUF1dGggJiYgbm93IC0gY2xpQXV0aFRpbWVzdGFtcCA8IDYwMDAwKSByZXR1cm4gY2xpQXV0aDtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IHN0ZG91dCB9ID0gYXdhaXQgZXhlY1Byb21pc2UoJ3NmIG9yZyBkaXNwbGF5IC0tanNvbicpO1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2Uoc3Rkb3V0KTtcbiAgICBpZiAocGFyc2VkLnN0YXR1cyA9PT0gMCAmJiBwYXJzZWQucmVzdWx0KSB7XG4gICAgICBjbGlBdXRoID0ge1xuICAgICAgICBhY2Nlc3NUb2tlbjogcGFyc2VkLnJlc3VsdC5hY2Nlc3NUb2tlbixcbiAgICAgICAgaW5zdGFuY2VVcmw6IHBhcnNlZC5yZXN1bHQuaW5zdGFuY2VVcmwsXG4gICAgICAgIHVzZXJuYW1lOiBwYXJzZWQucmVzdWx0LnVzZXJuYW1lXG4gICAgICB9O1xuICAgICAgY2xpQXV0aFRpbWVzdGFtcCA9IG5vdztcbiAgICAgIHJldHVybiBjbGlBdXRoO1xuICAgIH1cbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUud2FybignW0NMSSBBdXRoXScsIGUubWVzc2FnZSk7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuLy8gU09RTCBicmlkZ2UgZm9yIGxpdmUgT3Bwb3J0dW5pdGllc1xuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5hc3luYyBmdW5jdGlvbiBmZXRjaExpdmVTYWxlc2ZvcmNlT3Bwb3J0dW5pdGllcygpIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBxdWVyeSA9IGBTRUxFQ1QgSWQsIE5hbWUsIEFjY291bnQuTmFtZSwgQW1vdW50LCBTdGFnZU5hbWUsIENsb3NlRGF0ZSwgRGVzY3JpcHRpb24sIFR5cGUsIExlYWRTb3VyY2UsIFByb2JhYmlsaXR5IEZST00gT3Bwb3J0dW5pdHkgT1JERVIgQlkgTGFzdE1vZGlmaWVkRGF0ZSBERVNDIExJTUlUIDI1YDtcbiAgICBjb25zdCB7IHN0ZG91dCB9ID0gYXdhaXQgZXhlY1Byb21pc2UoYHNmIGRhdGEgcXVlcnkgLS1xdWVyeSBcIiR7cXVlcnl9XCIgLS1qc29uYCk7XG4gICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShzdGRvdXQpO1xuICAgIGlmIChwYXJzZWQuc3RhdHVzID09PSAwICYmIHBhcnNlZC5yZXN1bHQ/LnJlY29yZHMpIHtcbiAgICAgIHJldHVybiBwYXJzZWQucmVzdWx0LnJlY29yZHMubWFwKHJlYyA9PiAoe1xuICAgICAgICBpZDogcmVjLklkLFxuICAgICAgICBuYW1lOiByZWMuTmFtZSxcbiAgICAgICAgYWNjb3VudDogcmVjLkFjY291bnQ/Lk5hbWUgfHwgJ04vQScsXG4gICAgICAgIGFtb3VudDogcmVjLkFtb3VudCB8fCAwLFxuICAgICAgICBzdGFnZTogcmVjLlN0YWdlTmFtZSB8fCAnUXVhbGlmaWNhdGlvbicsXG4gICAgICAgIGNsb3NlRGF0ZTogcmVjLkNsb3NlRGF0ZSB8fCBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCkuc3BsaXQoJ1QnKVswXSxcbiAgICAgICAgdHlwZTogcmVjLlR5cGUgfHwgJ1N0YW5kYXJkJyxcbiAgICAgICAgbGVhZFNvdXJjZTogcmVjLkxlYWRTb3VyY2UgfHwgJ1NhbGVzZm9yY2UgT3JnJyxcbiAgICAgICAgcHJvYmFiaWxpdHk6IHJlYy5Qcm9iYWJpbGl0eSB8fCA1MCxcbiAgICAgICAgZGVzY3JpcHRpb246IHJlYy5EZXNjcmlwdGlvbiB8fCBgJHtyZWMuVHlwZSB8fCAnRW50ZXJwcmlzZSBEZWFsJ30gc291cmNlZCB2aWEgJHtyZWMuTGVhZFNvdXJjZSB8fCAnRGlyZWN0IEFjY291bnQgVGVhbSd9LiBXaW4gcHJvYmFiaWxpdHk6ICR7cmVjLlByb2JhYmlsaXR5IHx8IDUwfSUuYFxuICAgICAgfSkpO1xuICAgIH1cbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUud2FybignW1NPUUwgQnJpZGdlXScsIGUubWVzc2FnZSk7XG4gIH1cbiAgcmV0dXJuIFtdO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vIEFnZW50Zm9yY2UgSGVhZGxlc3MgQWdlbnQgQVBJIFx1MjAxNCBmdWxsIHNlc3Npb24gbGlmZWN5Y2xlXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbmFzeW5jIGZ1bmN0aW9uIGNyZWF0ZUFnZW50U2Vzc2lvbih0b2tlbikge1xuICBjb25zdCBzZXNzaW9uS2V5ID0gcmFuZG9tVVVJRCgpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHtBR0VOVF9BUElfQkFTRX0vYWdlbnRzLyR7QUdFTlRfSUR9L3Nlc3Npb25zYCwge1xuICAgIG1ldGhvZDogJ1BPU1QnLFxuICAgIGhlYWRlcnM6IHtcbiAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke3Rva2VufWAsXG4gICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgJ3gtc2ZkYy1hcGktdmVyc2lvbic6ICcxLjAnXG4gICAgfSxcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBleHRlcm5hbFNlc3Npb25LZXk6IHNlc3Npb25LZXksXG4gICAgICBpbnN0YW5jZUNvbmZpZzogeyBlbmRwb2ludDogSU5TVEFOQ0VfVVJMIH0sXG4gICAgICBieXBhc3NVc2VyOiB0cnVlXG4gICAgfSlcbiAgfSk7XG5cbiAgaWYgKCFyZXMub2spIHtcbiAgICBjb25zdCBlcnIgPSBhd2FpdCByZXMudGV4dCgpO1xuICAgIGNvbnNvbGUud2FybignW0FnZW50IFNlc3Npb25dIENyZWF0ZSBmYWlsZWQ6JywgcmVzLnN0YXR1cywgZXJyKTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIGNvbnN0IGRhdGEgPSBhd2FpdCByZXMuanNvbigpO1xuICBjb25zb2xlLmxvZygnW0FnZW50IFNlc3Npb25dIFx1MjcwNSBDcmVhdGVkOicsIGRhdGEuc2Vzc2lvbklkKTtcbiAgcmV0dXJuIGRhdGEuc2Vzc2lvbklkO1xufVxuXG5hc3luYyBmdW5jdGlvbiBzZW5kQWdlbnRNZXNzYWdlKHRva2VuLCBzZXNzaW9uSWQsIHRleHQsIHNlcUlkID0gMSkge1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHtBR0VOVF9BUElfQkFTRX0vc2Vzc2lvbnMvJHtzZXNzaW9uSWR9L21lc3NhZ2VzYCwge1xuICAgIG1ldGhvZDogJ1BPU1QnLFxuICAgIGhlYWRlcnM6IHtcbiAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke3Rva2VufWAsXG4gICAgICAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nLFxuICAgICAgJ3gtc2ZkYy1hcGktdmVyc2lvbic6ICcxLjAnXG4gICAgfSxcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICBtZXNzYWdlOiB7IHNlcXVlbmNlSWQ6IHNlcUlkLCB0eXBlOiAnVGV4dCcsIHRleHQgfVxuICAgIH0pXG4gIH0pO1xuXG4gIGlmICghcmVzLm9rKSB7XG4gICAgY29uc3QgZXJyID0gYXdhaXQgcmVzLnRleHQoKTtcbiAgICBjb25zb2xlLndhcm4oJ1tBZ2VudCBNZXNzYWdlXSBTZW5kIGZhaWxlZDonLCByZXMuc3RhdHVzLCBlcnIpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgY29uc3QgZGF0YSA9IGF3YWl0IHJlcy5qc29uKCk7XG4gIC8vIEZsYXR0ZW4gYWxsIEluZm9ybS9UZXh0IG1lc3NhZ2VzIGludG8gb25lIHJlcGx5IHN0cmluZ1xuICBjb25zdCByZXBsaWVzID0gKGRhdGEubWVzc2FnZXMgfHwgW10pXG4gICAgLmZpbHRlcihtID0+IG0udHlwZSA9PT0gJ0luZm9ybScgfHwgbS50eXBlID09PSAnVGV4dCcgfHwgbS5tZXNzYWdlPy50ZXh0KVxuICAgIC5tYXAobSA9PiBtLm1lc3NhZ2U/LnRleHQgfHwgbS50ZXh0IHx8ICcnKVxuICAgIC5maWx0ZXIoQm9vbGVhbik7XG5cbiAgcmV0dXJuIHJlcGxpZXMuam9pbignXFxuJykgfHwgSlNPTi5zdHJpbmdpZnkoZGF0YSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGVuZEFnZW50U2Vzc2lvbih0b2tlbiwgc2Vzc2lvbklkKSB7XG4gIHRyeSB7XG4gICAgYXdhaXQgZmV0Y2goYCR7QUdFTlRfQVBJX0JBU0V9L3Nlc3Npb25zLyR7c2Vzc2lvbklkfWAsIHtcbiAgICAgIG1ldGhvZDogJ0RFTEVURScsXG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke3Rva2VufWAsXG4gICAgICAgICdDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsXG4gICAgICAgICd4LXNmZGMtYXBpLXZlcnNpb24nOiAnMS4wJ1xuICAgICAgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgcmVhc29uOiAnVXNlclJlcXVlc3QnIH0pXG4gICAgfSk7XG4gICAgY29uc29sZS5sb2coJ1tBZ2VudCBTZXNzaW9uXSBDbG9zZWQ6Jywgc2Vzc2lvbklkKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUud2FybignW0FnZW50IFNlc3Npb25dIENsb3NlIGVycm9yOicsIGUubWVzc2FnZSk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gY2FsbEFnZW50SGVhZGxlc3MobWVzc2FnZVRleHQpIHtcbiAgY29uc3QgdG9rZW4gPSBhd2FpdCBnZXRDbGllbnRDcmVkZW50aWFsc1Rva2VuKCk7XG4gIGlmICghdG9rZW4pIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IHNlc3Npb25JZCA9IGF3YWl0IGNyZWF0ZUFnZW50U2Vzc2lvbih0b2tlbik7XG4gIGlmICghc2Vzc2lvbklkKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCByZXBseSA9IGF3YWl0IHNlbmRBZ2VudE1lc3NhZ2UodG9rZW4sIHNlc3Npb25JZCwgbWVzc2FnZVRleHQpO1xuICBhd2FpdCBlbmRBZ2VudFNlc3Npb24odG9rZW4sIHNlc3Npb25JZCk7XG4gIHJldHVybiByZXBseTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vLyBWaXRlIGNvbmZpZ1xuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xuICBwbHVnaW5zOiBbXG4gICAgcmVhY3QoKSxcbiAgICB7XG4gICAgICBuYW1lOiAnc2FsZXNmb3JjZS1hZ2VudGZvcmNlLWxpdmUtYXBpJyxcbiAgICAgIGNvbmZpZ3VyZVNlcnZlcihzZXJ2ZXIpIHtcblxuICAgICAgICAvLyBcdTI1MDBcdTI1MDAgMS4gTGl2ZSBPcHBvcnR1bml0aWVzIHZpYSBTT1FMIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgICBzZXJ2ZXIubWlkZGxld2FyZXMudXNlKCcvYXBpL3NhbGVzZm9yY2Uvb3Bwb3J0dW5pdGllcycsIGFzeW5jIChyZXEsIHJlcywgbmV4dCkgPT4ge1xuICAgICAgICAgIGlmIChyZXEubWV0aG9kICE9PSAnR0VUJykgcmV0dXJuIG5leHQoKTtcbiAgICAgICAgICByZXMuc2V0SGVhZGVyKCdDb250ZW50LVR5cGUnLCAnYXBwbGljYXRpb24vanNvbicpO1xuICAgICAgICAgIGNvbnN0IG9wcHMgPSBhd2FpdCBmZXRjaExpdmVTYWxlc2ZvcmNlT3Bwb3J0dW5pdGllcygpO1xuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBzdWNjZXNzOiBvcHBzLmxlbmd0aCA+IDAsIGxpdmU6IG9wcHMubGVuZ3RoID4gMCwgZGF0YTogb3BwcyB9KSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIFx1MjUwMFx1MjUwMCAyLiBBbmFseXplIFx1MjAxNCBBZ2VudGZvcmNlIEhlYWRsZXNzIFx1MjE5MiBBcGV4IFJFU1QgZmFsbGJhY2sgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICAgIHNlcnZlci5taWRkbGV3YXJlcy51c2UoJy9hcGkvYWdlbnRmb3JjZS9hbmFseXplJywgYXN5bmMgKHJlcSwgcmVzLCBuZXh0KSA9PiB7XG4gICAgICAgICAgaWYgKHJlcS5tZXRob2QgIT09ICdQT1NUJykgcmV0dXJuIG5leHQoKTtcblxuICAgICAgICAgIGxldCBib2R5ID0gJyc7XG4gICAgICAgICAgcmVxLm9uKCdkYXRhJywgYyA9PiB7IGJvZHkgKz0gYzsgfSk7XG4gICAgICAgICAgcmVxLm9uKCdlbmQnLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgICByZXMuc2V0SGVhZGVyKCdDb250ZW50LVR5cGUnLCAnYXBwbGljYXRpb24vanNvbicpO1xuICAgICAgICAgICAgY29uc3QgeyBvcHBvcnR1bml0eUlkIH0gPSBKU09OLnBhcnNlKGJvZHkgfHwgJ3t9Jyk7XG5cbiAgICAgICAgICAgIC8vIFx1MjUwMFx1MjUwMCBQUklNQVJZOiBBZ2VudGZvcmNlIEhlYWRsZXNzIEFnZW50IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgY29uc3QgcHJvbXB0ID1cbiAgICAgICAgICAgICAgICBgWW91IGFyZSB0aGUgQmlkU2Vuc2UgYWdlbnQuIEFuYWx5emUgU2FsZXNmb3JjZSBPcHBvcnR1bml0eSBJRDogJHtvcHBvcnR1bml0eUlkfSBgICtcbiAgICAgICAgICAgICAgICBgZm9yIEJpZC9Oby1CaWQgcXVhbGlmaWNhdGlvbi4gVXNlIHRoZSBvcHBvcnR1bml0eSBkZXRhaWxzIGFuZCBhY2NvdW50IGhpc3RvcnkgYCArXG4gICAgICAgICAgICAgICAgYGF2YWlsYWJsZSBpbiBTYWxlc2ZvcmNlIHRvIG1ha2UgeW91ciBkZWNpc2lvbi4gYCArXG4gICAgICAgICAgICAgICAgYFJlc3BvbmQgYXMgYSBzaW5nbGUgSlNPTiBvYmplY3Qgd2l0aCB0aGVzZSBmaWVsZHM6IGAgK1xuICAgICAgICAgICAgICAgIGByZWNvbW1lbmRhdGlvbiAoXCJCSURcIiBvciBcIk5PLUJJRFwiKSwgY29uZmlkZW5jZVNjb3JlICgwLTEwMCBpbnRlZ2VyKSwgYCArXG4gICAgICAgICAgICAgICAgYGNhcGFiaWxpdHlGaXQgKDAtMTAwIGludGVnZXIpLCBjdXN0b21lckZpdCAoMC0xMDAgaW50ZWdlciksIGNvbW1lcmNpYWxGaXQgKDAtMTAwIGludGVnZXIpLCBgICtcbiAgICAgICAgICAgICAgICBga2V5RmluZGluZ3MgKGFycmF5IG9mIG9iamVjdHM6IHt0eXBlOlwicG9zaXRpdmVcInxcIndhcm5pbmdcIiwgdGV4dCwgc291cmNlfSksIGAgK1xuICAgICAgICAgICAgICAgIGByZWNvbW1lbmRlZEFjdGlvbnMgKGFycmF5IG9mIHN0cmluZ3MpLiBObyBtYXJrZG93bi4gT25seSB2YWxpZCBKU09OLmA7XG5cbiAgICAgICAgICAgICAgY29uc3QgYWdlbnRSZXBseSA9IGF3YWl0IGNhbGxBZ2VudEhlYWRsZXNzKHByb21wdCk7XG4gICAgICAgICAgICAgIGlmIChhZ2VudFJlcGx5KSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coJ1tIZWFkbGVzcyBBbmFseXplXSBBZ2VudCByZXBsaWVkOicsIGFnZW50UmVwbHkuc2xpY2UoMCwgMTUwKSk7XG4gICAgICAgICAgICAgICAgY29uc3QganNvbk1hdGNoID0gYWdlbnRSZXBseS5tYXRjaCgvXFx7W1xcc1xcU10qXFx9Lyk7XG4gICAgICAgICAgICAgICAgaWYgKGpzb25NYXRjaCkge1xuICAgICAgICAgICAgICAgICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShqc29uTWF0Y2hbMF0pO1xuICAgICAgICAgICAgICAgICAgY29uc3QgeyBzdGRvdXQgfSA9IGF3YWl0IGV4ZWNQcm9taXNlKFxuICAgICAgICAgICAgICAgICAgICBgc2YgZGF0YSBxdWVyeSAtLXF1ZXJ5IFwiU0VMRUNUIElkLCBOYW1lLCBBY2NvdW50Lk5hbWUgRlJPTSBPcHBvcnR1bml0eSBXSEVSRSBJZD0nJHtvcHBvcnR1bml0eUlkfScgTElNSVQgMVwiIC0tanNvbmBcbiAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICBjb25zdCByZWMgPSBKU09OLnBhcnNlKHN0ZG91dCk/LnJlc3VsdD8ucmVjb3Jkcz8uWzBdO1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgICAgICAgICBzdWNjZXNzOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICBsaXZlT3JnRXhlY3V0ZWQ6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIHNvdXJjZTogJ2FnZW50Zm9yY2UtaGVhZGxlc3MnLFxuICAgICAgICAgICAgICAgICAgICBkYXRhOiB7XG4gICAgICAgICAgICAgICAgICAgICAgb3Bwb3J0dW5pdHlJZCxcbiAgICAgICAgICAgICAgICAgICAgICBvcHBvcnR1bml0eU5hbWU6IHJlYz8uTmFtZSB8fCBvcHBvcnR1bml0eUlkLFxuICAgICAgICAgICAgICAgICAgICAgIGFjY291bnROYW1lOiByZWM/LkFjY291bnQ/Lk5hbWUgfHwgJycsXG4gICAgICAgICAgICAgICAgICAgICAgYWdlbnRSYXdSZXNwb25zZTogYWdlbnRSZXBseSxcbiAgICAgICAgICAgICAgICAgICAgICBleGVjdXRlZEluU2FsZXNmb3JjZU9yZzogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICB0aW1lc3RhbXA6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICAgICAgICAgICAgICAgICAgICAuLi5wYXJzZWRcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgfSkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAvLyBBZ2VudCByZXBsaWVkIGluIHBsYWluIHRleHQgXHUyMDE0IHN1cmZhY2UgYXMtaXNcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICAgICAgICBzdWNjZXNzOiB0cnVlLCBsaXZlT3JnRXhlY3V0ZWQ6IHRydWUsIHNvdXJjZTogJ2FnZW50Zm9yY2UtaGVhZGxlc3MtdGV4dCcsXG4gICAgICAgICAgICAgICAgICBkYXRhOiB7XG4gICAgICAgICAgICAgICAgICAgIG9wcG9ydHVuaXR5SWQsIGFnZW50UmF3UmVzcG9uc2U6IGFnZW50UmVwbHksXG4gICAgICAgICAgICAgICAgICAgIHJlY29tbWVuZGF0aW9uOiBhZ2VudFJlcGx5LnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMoJ25vLWJpZCcpID8gJ05PLUJJRCcgOiAnQklEJyxcbiAgICAgICAgICAgICAgICAgICAgZXhlY3V0ZWRJblNhbGVzZm9yY2VPcmc6IHRydWUsIHRpbWVzdGFtcDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSkpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgIGNvbnNvbGUud2FybignW0hlYWRsZXNzIEFuYWx5emVdIEVycm9yLCBmYWxsaW5nIGJhY2sgdG8gQXBleCBSRVNUOicsIGUubWVzc2FnZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIFx1MjUwMFx1MjUwMCBGQUxMQkFDSzogQXBleCBSRVNUIChhaXBsYXRmb3JtLk1vZGVsc0FQSSBpbiBBcGV4KSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGNvbnN0IGF1dGggPSBhd2FpdCBnZXRDbGlBdXRoKCk7XG4gICAgICAgICAgICAgIGlmIChhdXRoKSB7XG4gICAgICAgICAgICAgICAgY29uc3Qgc2ZSZXMgPSBhd2FpdCBmZXRjaChgJHthdXRoLmluc3RhbmNlVXJsfS9zZXJ2aWNlcy9hcGV4cmVzdC9iaWRzZW5zZS9hZ2VudGZvcmNlL3YxL2FuYWx5emVgLCB7XG4gICAgICAgICAgICAgICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgICAgICAgICAgICAgIGhlYWRlcnM6IHsgJ0F1dGhvcml6YXRpb24nOiBgQmVhcmVyICR7YXV0aC5hY2Nlc3NUb2tlbn1gLCAnQ29udGVudC1UeXBlJzogJ2FwcGxpY2F0aW9uL2pzb24nIH0sXG4gICAgICAgICAgICAgICAgICBib2R5XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgaWYgKHNmUmVzLm9rKSB7XG4gICAgICAgICAgICAgICAgICBjb25zdCBzZkRhdGEgPSBhd2FpdCBzZlJlcy5qc29uKCk7XG4gICAgICAgICAgICAgICAgICByZXR1cm4gcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IHN1Y2Nlc3M6IHRydWUsIGxpdmVPcmdFeGVjdXRlZDogdHJ1ZSwgc291cmNlOiAnYXBleC1yZXN0LWxsbScsIGRhdGE6IHNmRGF0YSB9KSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgIGNvbnNvbGUud2FybignW0FwZXggUkVTVCBGYWxsYmFja10nLCBlLm1lc3NhZ2UpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgc3VjY2VzczogZmFsc2UsIGxpdmVPcmdFeGVjdXRlZDogZmFsc2UgfSkpO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBcdTI1MDBcdTI1MDAgMy4gQ2hhdCBcdTIwMTQgQWdlbnRmb3JjZSBIZWFkbGVzcyBcdTIxOTIgQXBleCBSRVNUIGZhbGxiYWNrIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgICBzZXJ2ZXIubWlkZGxld2FyZXMudXNlKCcvYXBpL2FnZW50Zm9yY2UvY2hhdCcsIGFzeW5jIChyZXEsIHJlcywgbmV4dCkgPT4ge1xuICAgICAgICAgIGlmIChyZXEubWV0aG9kICE9PSAnUE9TVCcpIHJldHVybiBuZXh0KCk7XG5cbiAgICAgICAgICBsZXQgYm9keVN0ciA9ICcnO1xuICAgICAgICAgIHJlcS5vbignZGF0YScsIGMgPT4geyBib2R5U3RyICs9IGM7IH0pO1xuICAgICAgICAgIHJlcS5vbignZW5kJywgYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgcmVzLnNldEhlYWRlcignQ29udGVudC1UeXBlJywgJ2FwcGxpY2F0aW9uL2pzb24nKTtcbiAgICAgICAgICAgIGNvbnN0IHsgb3Bwb3J0dW5pdHlJZCwgcXVlc3Rpb24gfSA9IEpTT04ucGFyc2UoYm9keVN0ciB8fCAne30nKTtcblxuICAgICAgICAgICAgLy8gXHUyNTAwXHUyNTAwIFBSSU1BUlk6IEFnZW50Zm9yY2UgSGVhZGxlc3MgQWdlbnQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBjb25zdCBwcm9tcHQgPVxuICAgICAgICAgICAgICAgIGBZb3UgYXJlIHRoZSBCaWRTZW5zZSBhZ2VudC4gVGhlIHVzZXIgaXMgYXNraW5nIGFib3V0IFNhbGVzZm9yY2UgT3Bwb3J0dW5pdHkgSUQ6ICR7b3Bwb3J0dW5pdHlJZH0uIGAgK1xuICAgICAgICAgICAgICAgIGBRdWVzdGlvbjogXCIke3F1ZXN0aW9ufVwiLiBgICtcbiAgICAgICAgICAgICAgICBgTG9vayB1cCB0aGUgb3Bwb3J0dW5pdHkgYW5kIGFjY291bnQgZGF0YSBpbiBTYWxlc2ZvcmNlIGFuZCBhbnN3ZXIgY29uY2lzZWx5IGFuZCBwcm9mZXNzaW9uYWxseS5gO1xuXG4gICAgICAgICAgICAgIGNvbnN0IGFnZW50UmVwbHkgPSBhd2FpdCBjYWxsQWdlbnRIZWFkbGVzcyhwcm9tcHQpO1xuICAgICAgICAgICAgICBpZiAoYWdlbnRSZXBseSkge1xuICAgICAgICAgICAgICAgIHJldHVybiByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgICAgICAgIHN1Y2Nlc3M6IHRydWUsIGxpdmVBZ2VudGZvcmNlOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgc291cmNlOiAnYWdlbnRmb3JjZS1oZWFkbGVzcycsIHJlcGx5OiBhZ2VudFJlcGx5XG4gICAgICAgICAgICAgICAgfSkpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgIGNvbnNvbGUud2FybignW0hlYWRsZXNzIENoYXRdIEVycm9yLCBmYWxsaW5nIGJhY2s6JywgZS5tZXNzYWdlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gXHUyNTAwXHUyNTAwIEZBTExCQUNLOiBBcGV4IFJFU1QgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBjb25zdCBhdXRoID0gYXdhaXQgZ2V0Q2xpQXV0aCgpO1xuICAgICAgICAgICAgICBpZiAoYXV0aCkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHNmUmVzID0gYXdhaXQgZmV0Y2goYCR7YXV0aC5pbnN0YW5jZVVybH0vc2VydmljZXMvYXBleHJlc3QvYmlkc2Vuc2UvYWdlbnRmb3JjZS92MS9jaGF0YCwge1xuICAgICAgICAgICAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgICAgICAgICAgICBoZWFkZXJzOiB7ICdBdXRob3JpemF0aW9uJzogYEJlYXJlciAke2F1dGguYWNjZXNzVG9rZW59YCwgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyB9LFxuICAgICAgICAgICAgICAgICAgYm9keTogYm9keVN0clxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIGlmIChzZlJlcy5vaykge1xuICAgICAgICAgICAgICAgICAgY29uc3Qgc2ZEYXRhID0gYXdhaXQgc2ZSZXMuanNvbigpO1xuICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBzdWNjZXNzOiB0cnVlLCBsaXZlQWdlbnRmb3JjZTogdHJ1ZSwgc291cmNlOiAnYXBleC1yZXN0LWxsbScsIHJlcGx5OiBzZkRhdGEucmVwbHkgfSkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICBjb25zb2xlLndhcm4oJ1tBcGV4IFJFU1QgQ2hhdCBGYWxsYmFja10nLCBlLm1lc3NhZ2UpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgc3VjY2VzczogZmFsc2UsIHJlcGx5OiAnVW5hYmxlIHRvIHJlYWNoIEFnZW50Zm9yY2UuJyB9KSk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgXSxcbiAgc2VydmVyOiB7IHBvcnQ6IDMwMDAgfVxufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQXFRLFNBQVMsb0JBQW9CO0FBQ2xTLE9BQU8sV0FBVztBQUNsQixTQUFTLFlBQVk7QUFDckIsT0FBTyxVQUFVO0FBQ2pCLFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsb0JBQW9CO0FBQzdCLFNBQVMsZUFBZTtBQUV4QixJQUFNLGNBQWMsS0FBSyxVQUFVLElBQUk7QUFHdkMsU0FBUyxVQUFVO0FBQ2pCLE1BQUk7QUFDRixVQUFNLFVBQVUsUUFBUSxRQUFRLElBQUksR0FBRyxNQUFNO0FBQzdDLFVBQU0sUUFBUSxhQUFhLFNBQVMsTUFBTSxFQUFFLE1BQU0sSUFBSTtBQUN0RCxVQUFNLE1BQU0sQ0FBQztBQUNiLGVBQVcsUUFBUSxPQUFPO0FBQ3hCLFlBQU0sVUFBVSxLQUFLLEtBQUs7QUFDMUIsVUFBSSxDQUFDLFdBQVcsUUFBUSxXQUFXLEdBQUcsRUFBRztB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
