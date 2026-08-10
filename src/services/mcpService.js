/**
 * ============================================================================
 * MCP SERVICE (Model Context Protocol Integration Layer)
 * ============================================================================
 *
 * Current State: Mock MCP Tool Metadata & Contributions.
 *
 * FUTURE ARCHITECTURE:
 * Agentforce Agent invokes these MCP Tools in parallel during qualification:
 *   1. Salesforce MCP         -> Pulls Opp line items, stage history, chatter activity, account relationship.
 *   2. HR / SME MCP           -> Queries staffing bench & skill availability for required Salesforce certs.
 *   3. Knowledge / Projects MCP-> Searches past delivery assets, similar RFPs, and delivery templates.
 *   4. Commercial / Pricing MCP-> Analyzes target margin thresholds, discount limits, and deal size risk.
 */

export const MCP_SOURCES = {
  SALESFORCE: {
    id: "sf_mcp",
    name: "Salesforce Core MCP",
    badgeColor: "#0176D3",
    description: "Account relationship, stage velocity, and opportunity history"
  },
  HR_SME: {
    id: "hr_mcp",
    name: "HR / SME Staffing MCP",
    badgeColor: "#4B6FFF",
    description: "Architect availability, certification matrix, and team capacity"
  },
  KNOWLEDGE_PROJECTS: {
    id: "knowledge_mcp",
    name: "Knowledge & Projects MCP",
    badgeColor: "#10B981",
    description: "Past RFP benchmarks, reusable LWC assets, and delivery risks"
  },
  COMMERCIAL_PRICING: {
    id: "commercial_mcp",
    name: "Commercial & Pricing MCP",
    badgeColor: "#F59E0B",
    description: "Rate cards, margin analysis, and contractual risk scoring"
  }
};

/**
 * Get active MCP tool status overview
 * @returns {Array} List of connected MCP servers
 */
export function getMcpStatus() {
  return Object.values(MCP_SOURCES).map(mcp => ({
    ...mcp,
    status: "Connected (Mock)"
  }));
}
