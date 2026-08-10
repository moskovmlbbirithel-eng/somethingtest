import React from 'react';

export default function OpportunitySelector({ opportunities, selectedId, onSelectOpportunity }) {
  return (
    <div className="card">
      <div className="selector-group">
        <label htmlFor="opp-select" className="selector-label">
          Select Salesforce Opportunity
        </label>
        <select
          id="opp-select"
          className="select-input"
          value={selectedId}
          onChange={(e) => onSelectOpportunity(e.target.value)}
        >
          {opportunities.map((opp) => (
            <option key={opp.id} value={opp.id}>
              {opp.name} — {opp.account} (${opp.amount.toLocaleString()})
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
