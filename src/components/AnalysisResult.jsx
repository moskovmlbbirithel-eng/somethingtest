import React from 'react';

export default function AnalysisResult({ result }) {
  if (!result) return null;

  const isBid = result.recommendation === 'BID';

  return (
    <div className="card">
      <div className="card-title">
        <span>Agentforce Qualification Analysis</span>
        <span style={{ fontSize: '12px', fontWeight: '500', color: 'var(--sf-text-muted)' }}>
          {result.executedInSalesforceOrg ? (
            <span style={{ color: '#2E844A', fontWeight: '600' }}>
              ✓ Executed Live in Salesforce Org (Apex REST API)
            </span>
          ) : (
            `Generated at ${new Date(result.timestamp).toLocaleTimeString()}`
          )}
        </span>
      </div>

      {/* Top Banner: Recommendation + Confidence Score */}
      <div className={`result-header ${isBid ? 'bid' : 'no-bid'}`}>
        <div>
          <div style={{ fontSize: '12px', fontWeight: '600', color: 'var(--sf-text-muted)', marginBottom: '4px' }}>
            BID RECOMMENDATION
          </div>
          <div className={`recommendation-badge ${isBid ? 'bid' : 'no-bid'}`}>
            {isBid ? '✓ RECOMMEND BID' : '✕ RECOMMEND NO-BID'}
          </div>
        </div>

        <div className="confidence-score">
          <span className="score-number">{result.confidenceScore}%</span>
          <span className="score-label">Confidence Score</span>
        </div>
      </div>

      {/* Fit Metrics Breakdown */}
      <div className="fits-container">
        <h4 style={{ fontSize: '14px', fontWeight: '600', marginBottom: '12px' }}>Fit Breakdown</h4>
        <div className="fits-grid">
          <div className="fit-card">
            <div className="fit-header">
              <span>Capability Fit</span>
              <span className="fit-score">{result.fits.capabilityFit}%</span>
            </div>
            <div className="progress-bar-bg">
              <div className="progress-bar-fill" style={{ width: `${result.fits.capabilityFit}%` }}></div>
            </div>
          </div>

          <div className="fit-card">
            <div className="fit-header">
              <span>Customer Fit</span>
              <span className="fit-score">{result.fits.customerFit}%</span>
            </div>
            <div className="progress-bar-bg">
              <div className="progress-bar-fill" style={{ width: `${result.fits.customerFit}%` }}></div>
            </div>
          </div>

          <div className="fit-card">
            <div className="fit-header">
              <span>Commercial Fit</span>
              <span className="fit-score">{result.fits.commercialFit}%</span>
            </div>
            <div className="progress-bar-bg">
              <div className="progress-bar-fill" style={{ width: `${result.fits.commercialFit}%` }}></div>
            </div>
          </div>
        </div>
      </div>

      {/* Key Findings */}
      <div style={{ marginBottom: '24px' }}>
        <h4 style={{ fontSize: '14px', fontWeight: '600', marginBottom: '12px' }}>Key Findings</h4>
        <div className="findings-list">
          {result.keyFindings.map((finding, idx) => (
            <div key={idx} className={`finding-item ${finding.type}`}>
              <span className="finding-icon">{finding.type === 'positive' ? '✓' : '⚠'}</span>
              <div className="finding-text">
                <div>{finding.text}</div>
                {finding.source && <span className="mcp-tag">Source: {finding.source}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recommended Actions */}
      <div>
        <h4 style={{ fontSize: '14px', fontWeight: '600', marginBottom: '12px' }}>Recommended Actions</h4>
        <ol className="actions-list">
          {result.recommendedActions.map((action, idx) => (
            <li key={idx} className="action-item">{action}</li>
          ))}
        </ol>
      </div>

      {/* Future MCP Architecture Reference Collapsible Banner */}
      <details className="architecture-banner">
        <summary>View Live Salesforce Agentforce Architecture Schema</summary>
        <div className="arch-flow">
{`React UI (BidSense)
    ↓
agentforceService.js  -->  Vite API Bridge
                               ↓
          Salesforce Org Apex REST API (/services/apexrest/bidsense/agentforce/v1/analyze)
                               ↓
                         Agentforce Engine
                               ├── Live Opportunity SOQL Data
                               ├── Salesforce Core MCP
                               ├── HR / SME Staffing MCP
                               ├── Knowledge & Projects MCP
                               └── Commercial & Pricing MCP`}
        </div>
      </details>
    </div>
  );
}
