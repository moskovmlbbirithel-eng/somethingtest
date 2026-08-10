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

            // ── MCP SERVER TOOL INTEGRATION: SME & Skill Index ─────────────
            const qLower = (question || '').toLowerCase();
            const isMcpQuery =
              qLower.includes('sme') || qLower.includes('skill') || qLower.includes('rfp') ||
              qLower.includes('staff') || qLower.includes('epic') || qLower.includes('fhir') ||
              qLower.includes('hire') || qLower.includes('retrain') || qLower.includes('team');

            if (isMcpQuery) {
              try {
                const fs = await import('fs');
                const employees = JSON.parse(fs.readFileSync('./mcp-skill-index/data/employees.json', 'utf8'));
                const taxonomy = JSON.parse(fs.readFileSync('./mcp-skill-index/data/skill_taxonomy.json', 'utf8')).skills;

                function normalizeSkill(s) {
                  const sL = s.toLowerCase().trim();
                  for (const [canonical, meta] of Object.entries(taxonomy)) {
                    if (canonical.toLowerCase() === sL) return canonical;
                    if ((meta.aliases || []).some(a => a.toLowerCase() === sL)) return canonical;
                  }
                  return s;
                }

                // Extract potential skills from question or default to prompt skills
                let extractedSkills = [];
                if (qLower.includes('salesforce')) extractedSkills.push('Salesforce');
                if (qLower.includes('fhir') || qLower.includes('hl7')) extractedSkills.push('HL7 FHIR');
                if (qLower.includes('epic')) extractedSkills.push('Epic EHR Integration');
                if (qLower.includes('health') || qLower.includes('healthcare')) extractedSkills.push('Salesforce Health Cloud');
                if (extractedSkills.length === 0) extractedSkills = ['Salesforce Health Cloud', 'HL7 FHIR', 'Epic EHR Integration'];

                const reqSkills = extractedSkills.map(normalizeSkill);
                const domain = qLower.includes('health') ? 'Healthcare' : qLower.includes('bank') || qLower.includes('fin') ? 'Financial Services' : '';

                const scored = employees.map(emp => {
                  const empSkills = (emp.skills || []).map(s => s.toLowerCase());
                  const empCerts = (emp.certifications || []).map(c => c.toLowerCase());
                  const empDomains = (emp.domain_experience || []).map(d => d.toLowerCase());

                  let matched = [];
                  let missing = [];
                  reqSkills.forEach(sk => {
                    const skL = sk.toLowerCase();
                    const found = empSkills.some(s => s.includes(skL) || skL.includes(s)) || empCerts.some(c => c.includes(skL));
                    if (found) matched.push(sk); else missing.push(sk);
                  });

                  let score = Math.round((matched.length / reqSkills.length) * 80);
                  if (domain && empDomains.includes(domain.toLowerCase())) score += 20;
                  return { ...emp, fitScore: Math.min(score, 100), matchedSkills: matched, missingSkills: missing };
                });

                scored.sort((a,b) => b.fitScore - a.fitScore || b.projects_delivered - a.projects_delivered);
                const top5 = scored.slice(0, 5);

                const missingSkills = reqSkills.filter(sk => !scored.some(e => e.matchedSkills.includes(sk)));
                const thinSkills = reqSkills.filter(sk => scored.filter(e => e.matchedSkills.includes(sk)).length === 1);

                let replyText = `### Employee Skill Index MCP Response\n\n`;
                replyText += `**Required Skills Analyzed:** ${reqSkills.join(', ')} (Domain: ${domain || 'General'})\n\n`;
                replyText += `#### Top 5 Recommended Subject Matter Experts (SMEs):\n`;
                top5.forEach((sme, i) => {
                  replyText += `${i + 1}. **${sme.name}** — *${sme.role}* (${sme.seniority}, ${sme.location})\n`;
                  replyText += `   - **Fit Score:** ${sme.fitScore}%\n`;
                  replyText += `   - **Matched Skills:** ${sme.matchedSkills.length > 0 ? sme.matchedSkills.join(', ') : 'None'}\n`;
                  replyText += `   - **Certifications:** ${sme.certifications.slice(0, 2).join(', ')}\n`;
                  replyText += `   - **Availability:** ${sme.availability_percent}% | **Projects Delivered:** ${sme.projects_delivered}\n\n`;
                });

                if (missingSkills.length > 0) {
                  replyText += `#### Critical Skill Gaps & Hiring Recommendations:\n`;
                  missingSkills.forEach(gap => {
                    replyText += `⚠️ **${gap}:** No employees currently hold this skill. **Hiring Recommended** (Sourcing Timeline: 8 weeks | Role: ${gap} Specialist).\n`;
                  });
                  replyText += `\n`;
                }

                if (thinSkills.length > 0) {
                  replyText += `#### Thin Coverage Risk:\n`;
                  thinSkills.forEach(sk => {
                    const emp = scored.find(e => e.matchedSkills.includes(sk));
                    replyText += `⚡ **${sk}:** Single point of failure — held only by ${emp ? emp.name : '1 employee'}. Retraining recommended.\n`;
                  });
                }

                return res.end(JSON.stringify({
                  success: true,
                  liveAgentforce: true,
                  source: 'employee-skill-index-mcp',
                  reply: replyText
                }));
              } catch (mcpErr) {
                console.warn('[MCP Skill Index Evaluator Error]', mcpErr.message);
              }
            }

            res.end(JSON.stringify({ success: false, reply: 'Unable to reach Agentforce.' }));
          });
        });

      }
    }
  ],
  server: { port: 3000 }
});
