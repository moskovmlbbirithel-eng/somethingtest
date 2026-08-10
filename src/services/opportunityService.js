/**
 * ============================================================================
 * OPPORTUNITY SERVICE (Salesforce Live Org Integration)
 * ============================================================================
 *
 * Current State: Dynamically queries live Salesforce Opportunities from the
 * authenticated org (`karthikpadmakumar21.8ed39c157b31@agentforce.com`)
 * via Headless SF CLI / SOQL API with automatic mock fallback.
 */

// Fallback Mock Salesforce Opportunities (if live org is offline)
const MOCK_OPPORTUNITIES = [
  {
    id: "0068000000abc11AAA",
    name: "Global Bank - Core Salesforce Modernization",
    account: "Global Financial Services Corp",
    amount: 1250000,
    stage: "Proposal / Price Quote",
    closeDate: "2026-09-30",
    type: "New Customer",
    leadSource: "Direct Sales",
    probability: 75,
    description: "Enterprise multi-cloud migration including Financial Services Cloud, Service Cloud Voice, and custom LWC integration."
  },
  {
    id: "0068000000def22BBB",
    name: "Acme Logistics - Field Service & Agentforce AI",
    account: "Acme Logistics International",
    amount: 450000,
    stage: "Value Proposition",
    closeDate: "2026-10-15",
    type: "Existing Customer - Upgrade",
    leadSource: "Partner",
    probability: 80,
    description: "Field Service Lightning deployment with custom Agentforce autonomous dispatch agents and mobile technician portal."
  },
  {
    id: "0068000000ghi33CCC",
    name: "Apex Healthcare - Patient Portal & Data Cloud",
    account: "Apex Health System",
    amount: 820000,
    stage: "Qualification",
    closeDate: "2026-11-01",
    type: "New Customer",
    leadSource: "RFP",
    probability: 30,
    description: "HIPAA-compliant Salesforce Data Cloud implementation paired with Health Cloud and real-time patient engagement analytics."
  }
];

let cachedLiveOpps = null;

/**
 * Fetch list of all available Salesforce Opportunities (Live Org or Fallback)
 * @returns {Promise<Array>} List of opportunity records
 */
export async function getOpportunities() {
  try {
    const res = await fetch('/api/salesforce/opportunities');
    if (res.ok) {
      const payload = await res.json();
      if (payload.success && payload.data && payload.data.length > 0) {
        cachedLiveOpps = payload.data;
        return payload.data;
      }
    }
  } catch (err) {
    console.info('[OpportunityService] Live API unavailable, using fallback dataset:', err.message);
  }

  return MOCK_OPPORTUNITIES;
}

/**
 * Fetch detailed record for a specific Salesforce Opportunity
 * @param {string} opportunityId 
 * @returns {Promise<Object>} Opportunity record details
 */
export async function getOpportunityById(opportunityId) {
  if (cachedLiveOpps && cachedLiveOpps.length > 0) {
    const found = cachedLiveOpps.find((op) => op.id === opportunityId);
    if (found) return found;
  }

  // Refetch live or fallback
  const opps = await getOpportunities();
  const match = opps.find((op) => op.id === opportunityId);
  return match || opps[0];
}
