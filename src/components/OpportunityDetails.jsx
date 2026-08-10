import React from 'react';

export default function OpportunityDetails({ opportunity, onAnalyze, isAnalyzing }) {
  if (!opportunity) return null;

  // Format currency
  const formattedAmount = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  }).format(opportunity.amount);

  return (
    <div className="card">
      <div className="card-title">
        <span>Opportunity Overview</span>
        <span style={{ fontSize: '12px', fontWeight: 'normal', color: 'var(--sf-text-muted)' }}>
          ID: {opportunity.id}
        </span>
      </div>

      {/* Grid of basic Opportunity Information */}
      <div className="details-grid">
        <div className="detail-item">
          <span className="detail-label">Opportunity Name</span>
          <span className="detail-value">{opportunity.name}</span>
        </div>
        <div className="detail-item">
          <span className="detail-label">Account</span>
          <span className="detail-value">{opportunity.account}</span>
        </div>
        <div className="detail-item">
          <span className="detail-label">Amount</span>
          <span className="detail-value amount">{formattedAmount}</span>
        </div>
        <div className="detail-item">
          <span className="detail-label">Stage</span>
          <span className="detail-value">{opportunity.stage}</span>
        </div>
        <div className="detail-item">
          <span className="detail-label">Close Date</span>
          <span className="detail-value">{opportunity.closeDate}</span>
        </div>
      </div>

      {opportunity.description && (
        <div className="opp-description">
          <strong>RFP Scope & Context:</strong> {opportunity.description}
        </div>
      )}

      {/* Trigger Analyze Bid Action */}
      <button
        className="btn-analyze"
        onClick={onAnalyze}
        disabled={isAnalyzing}
      >
        {isAnalyzing ? (
          <>
            <span className="spinner"></span>
            Running Agentforce Qualification...
          </>
        ) : (
          <>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
            Analyze Bid with Agentforce
          </>
        )}
      </button>
    </div>
  );
}
