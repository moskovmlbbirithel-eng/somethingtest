import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { exec } from 'child_process';
import util from 'util';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const execPromise = util.promisify(exec);

// ── Load .env manually (Vite's import.meta.env is frontend-only) ─────────────
function loadEnv() {
  try {
    const envPath = resolve(process.cwd(), '.env');
    const lines = readFileSync(envPath, 'utf8').split('\n');
    const env = {};
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
    return env;
  } catch { return {}; }
}

const ENV = loadEnv();

// ── Agent constants ───────────────────────────────────────────────────────────
const AGENT_ID       = '0Xxak000003KiWDCA0';   // BotDefinition.Id
const AGENT_API_BASE = 'https://api.salesforce.com/einstein/ai-agent/v1';
const INSTANCE_URL   = ENV.SF_INSTANCE_URL || 'https://orgfarm-cba377a47c-dev-ed.develop.my.salesforce.com';
const CLIENT_ID      = ENV.SF_CLIENT_ID;
const CLIENT_SECRET  = ENV.SF_CLIENT_SECRET;

// ── Token caches ─────────────────────────────────────────────────────────────
let ccToken = null;           // Client Credentials token (for api.salesforce.com)
let ccTokenExpiry = 0;
let cliAuth = null;           // CLI session token (for SOQL / Apex REST)
let cliAuthTimestamp = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Client Credentials Flow — gets proper token for api.salesforce.com
// ─────────────────────────────────────────────────────────────────────────────
async function getClientCredentialsToken() {
  const now = Date.now();
  if (ccToken && now < ccTokenExpiry) return ccToken;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn('[CC Flow] Missing SF_CLIENT_ID or SF_CLIENT_SECRET in .env');
    return null;
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    });

    const res = await fetch(`${INSTANCE_URL}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn('[CC Flow] Token request failed:', res.status, err);
      return null;
    }

    const data = await res.json();
    ccToken = data.access_token;
    // Salesforce CC tokens last ~2 hours; refresh 5 min early
    ccTokenExpiry = now + (7200 - 300) * 1000;
    console.log('[CC Flow] ✅ Client Credentials token obtained.');
    return ccToken;
  } catch (e) {
    console.error('[CC Flow] Error:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI session auth — for SOQL queries and Apex REST fallback
// ─────────────────────────────────────────────────────────────────────────────
async function getCliAuth() {
  const now = Date.now();
  if (cliAuth && now - cliAuthTimestamp < 60000) return cliAuth;
  try {
    const { stdout } = await execPromise('sf org display --json');
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
    console.warn('[CLI Auth]', e.message);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SOQL bridge for live Opportunities
// ─────────────────────────────────────────────────────────────────────────────
async function fetchLiveSalesforceOpportunities() {
  try {
    const query = `SELECT Id, Name, Account.Name, Amount, StageName, CloseDate, Description, Type, LeadSource, Probability FROM Opportunity ORDER BY LastModifiedDate DESC LIMIT 25`;
    const { stdout } = await execPromise(`sf data query --query "${query}" --json`);
    const parsed = JSON.parse(stdout);
    if (parsed.status === 0 && parsed.result?.records) {
      return parsed.result.records.map(rec => ({
        id: rec.Id,
        name: rec.Name,
        account: rec.Account?.Name || 'N/A',
        amount: rec.Amount || 0,
        stage: rec.StageName || 'Qualification',
        closeDate: rec.CloseDate || new Date().toISOString().split('T')[0],
        type: rec.Type || 'Standard',
        leadSource: rec.LeadSource || 'Salesforce Org',
        probability: rec.Probability || 50,
        description: rec.Description || `${rec.Type || 'Enterprise Deal'} sourced via ${rec.LeadSource || 'Direct Account Team'}. Win probability: ${rec.Probability || 50}%.`
      }));
    }
  } catch (e) {
    console.warn('[SOQL Bridge]', e.message);
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Agentforce Headless Agent API — full session lifecycle
// ─────────────────────────────────────────────────────────────────────────────
async function createAgentSession(token) {
  const sessionKey = randomUUID();
  const res = await fetch(`${AGENT_API_BASE}/agents/${AGENT_ID}/sessions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-sfdc-api-version': '1.0'
    },
    body: JSON.stringify({
      externalSessionKey: sessionKey,
      instanceConfig: { endpoint: INSTANCE_URL },
      bypassUser: true
    })
  });

  if (!res.ok) {
    const err = await res.text();
    console.warn('[Agent Session] Create failed:', res.status, err);
    return null;
  }

  const data = await res.json();
  console.log('[Agent Session] ✅ Created:', data.sessionId);
  return data.sessionId;
}

async function sendAgentMessage(token, sessionId, text, seqId = 1) {
  const res = await fetch(`${AGENT_API_BASE}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-sfdc-api-version': '1.0'
    },
    body: JSON.stringify({
      message: { sequenceId: seqId, type: 'Text', text }
    })
  });

  if (!res.ok) {
    const err = await res.text();
    console.warn('[Agent Message] Send failed:', res.status, err);
    return null;
  }

  const data = await res.json();
  // Flatten all Inform/Text messages into one reply string
  const replies = (data.messages || [])
    .filter(m => m.type === 'Inform' || m.type === 'Text' || m.message?.text)
    .map(m => m.message?.text || m.text || '')
    .filter(Boolean);

  return replies.join('\n') || JSON.stringify(data);
}

async function endAgentSession(token, sessionId) {
  try {
    await fetch(`${AGENT_API_BASE}/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-sfdc-api-version': '1.0'
      },
      body: JSON.stringify({ reason: 'UserRequest' })
    });
    console.log('[Agent Session] Closed:', sessionId);
  } catch (e) {
    console.warn('[Agent Session] Close error:', e.message);
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

// ─────────────────────────────────────────────────────────────────────────────
// Vite config
// ─────────────────────────────────────────────────────────────────────────────
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'salesforce-agentforce-live-api',
      configureServer(server) {

        // ── 1. Live Opportunities via SOQL ──────────────────────────────────
        server.middlewares.use('/api/salesforce/opportunities', async (req, res, next) => {
          if (req.method !== 'GET') return next();
          res.setHeader('Content-Type', 'application/json');
          const opps = await fetchLiveSalesforceOpportunities();
          res.end(JSON.stringify({ success: opps.length > 0, live: opps.length > 0, data: opps }));
        });

        // ── 2. Analyze — Agentforce Headless → Apex REST fallback ──────────
        server.middlewares.use('/api/agentforce/analyze', async (req, res, next) => {
          if (req.method !== 'POST') return next();

          let body = '';
          req.on('data', c => { body += c; });
          req.on('end', async () => {
            res.setHeader('Content-Type', 'application/json');
            const { opportunityId } = JSON.parse(body || '{}');

            // ── PRIMARY: Agentforce Headless Agent ────────────────────────
            try {
              const prompt =
                `You are the BidSense agent. Analyze Salesforce Opportunity ID: ${opportunityId} ` +
                `for Bid/No-Bid qualification. Use the opportunity details and account history ` +
                `available in Salesforce to make your decision. ` +
                `Respond as a single JSON object with these fields: ` +
                `recommendation ("BID" or "NO-BID"), confidenceScore (0-100 integer), ` +
                `capabilityFit (0-100 integer), customerFit (0-100 integer), commercialFit (0-100 integer), ` +
                `keyFindings (array of objects: {type:"positive"|"warning", text, source}), ` +
                `recommendedActions (array of strings). No markdown. Only valid JSON.`;

              const agentReply = await callAgentHeadless(prompt);
              if (agentReply) {
                console.log('[Headless Analyze] Agent replied:', agentReply.slice(0, 150));
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
                    source: 'agentforce-headless',
                    data: {
                      opportunityId,
                      opportunityName: rec?.Name || opportunityId,
                      accountName: rec?.Account?.Name || '',
                      agentRawResponse: agentReply,
                      executedInSalesforceOrg: true,
                      timestamp: new Date().toISOString(),
                      ...parsed
                    }
                  }));
                }
                // Agent replied in plain text — surface as-is
                return res.end(JSON.stringify({
                  success: true, liveOrgExecuted: true, source: 'agentforce-headless-text',
                  data: {
                    opportunityId, agentRawResponse: agentReply,
                    recommendation: agentReply.toLowerCase().includes('no-bid') ? 'NO-BID' : 'BID',
                    executedInSalesforceOrg: true, timestamp: new Date().toISOString()
                  }
                }));
              }
            } catch (e) {
              console.warn('[Headless Analyze] Error, falling back to Apex REST:', e.message);
            }

            // ── FALLBACK: Apex REST (aiplatform.ModelsAPI in Apex) ────────
            try {
              const auth = await getCliAuth();
              if (auth) {
                const sfRes = await fetch(`${auth.instanceUrl}/services/apexrest/bidsense/agentforce/v1/analyze`, {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
                  body
                });
                if (sfRes.ok) {
                  const sfData = await sfRes.json();
                  return res.end(JSON.stringify({ success: true, liveOrgExecuted: true, source: 'apex-rest-llm', data: sfData }));
                }
              }
            } catch (e) {
              console.warn('[Apex REST Fallback]', e.message);
            }

            res.end(JSON.stringify({ success: false, liveOrgExecuted: false }));
          });
        });

        // ── 3. Chat — Agentforce Headless → Apex REST fallback ────────────
        server.middlewares.use('/api/agentforce/chat', async (req, res, next) => {
          if (req.method !== 'POST') return next();

          let bodyStr = '';
          req.on('data', c => { bodyStr += c; });
          req.on('end', async () => {
            res.setHeader('Content-Type', 'application/json');
            const { opportunityId, question } = JSON.parse(bodyStr || '{}');

            // ── PRIMARY: Call Live Agentforce Agent (invokes Render MCP Tools) ─────
            try {
              console.log('[Agentforce Chat] Sending prompt to live Agentforce Agent:', question);
              const agentReply = await callAgentHeadless(question);
              if (agentReply) {
                console.log('[Agentforce Chat] ✅ Agent replied:', agentReply.slice(0, 150));
                return res.end(JSON.stringify({
                  success: true,
                  liveAgentforce: true,
                  source: 'agentforce-headless-mcp',
                  reply: agentReply
                }));
              }
            } catch (e) {
              console.warn('[Headless Chat] Error, falling back to Apex REST:', e.message);
            }

            // ── FALLBACK: Apex REST ────────────────────────────────────────
            try {
              const auth = await getCliAuth();
              if (auth) {
                const sfRes = await fetch(`${auth.instanceUrl}/services/apexrest/bidsense/agentforce/v1/chat`, {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
                  body: bodyStr
                });
                if (sfRes.ok) {
                  const sfData = await sfRes.json();
                  return res.end(JSON.stringify({
                    success: true,
                    liveAgentforce: true,
                    source: 'apex-rest-llm',
                    reply: sfData.reply
                  }));
                }
              }
            } catch (e) {
              console.warn('[Apex REST Chat Fallback]', e.message);
            }

            res.end(JSON.stringify({ success: false, reply: 'Unable to reach Agentforce.' }));
          });
        });

        // ── 4. Ingest RFP — read file text, call Apex /ingest ──────────────
        server.middlewares.use('/api/agentforce/ingest', async (req, res, next) => {
          if (req.method !== 'POST') return next();

          let bodyStr = '';
          req.on('data', c => { bodyStr += c; });
          req.on('end', async () => {
            res.setHeader('Content-Type', 'application/json');
            try {
              const auth = await getCliAuth();
              if (!auth) {
                return res.end(JSON.stringify({ success: false, error: 'Not authenticated to Salesforce org.' }));
              }

              const sfRes = await fetch(`${auth.instanceUrl}/services/apexrest/bidsense/agentforce/v1/ingest`, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${auth.accessToken}`,
                  'Content-Type': 'application/json'
                },
                body: bodyStr
              });

              const sfText = await sfRes.text();
              if (!sfRes.ok) {
                console.error('[Ingest] Apex error:', sfRes.status, sfText);
                return res.end(JSON.stringify({ success: false, error: `Apex returned ${sfRes.status}: ${sfText.slice(0, 200)}` }));
              }

              const sfData = JSON.parse(sfText);
              console.log('[Ingest] ✅ Success:', sfData.opportunityId, sfData.rfpId);
              res.end(JSON.stringify(sfData));
            } catch (e) {
              console.error('[Ingest] Error:', e.message);
              res.end(JSON.stringify({ success: false, error: e.message }));
            }
          });
        });

      }
    }
  ],
  server: { port: 3000 }
});
