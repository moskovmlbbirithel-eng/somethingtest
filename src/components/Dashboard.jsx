import React, { useState, useEffect } from 'react';
import { getOpportunities } from '../services/opportunityService.js';

const STAGE_COLORS = {
  'Prospecting':          '#6366f1',
  'Qualification':        '#f59e0b',
  'Needs Analysis':       '#3b82f6',
  'Value Proposition':    '#8b5cf6',
  'Id. Decision Makers':  '#06b6d4',
  'Perception Analysis':  '#10b981',
  'Proposal/Price Quote': '#f97316',
  'Negotiation/Review':   '#ec4899',
  'Closed Won':           '#22c55e',
  'Closed Lost':          '#ef4444',
};

function RecommendationBadge({ recommendation }) {
  if (!recommendation) return null;
  const isBid = recommendation === 'BID';
  return (
    <span className={`dash-badge ${isBid ? 'badge-bid' : 'badge-nobid'}`}>
      {isBid ? '✅ BID' : '🚫 NO-BID'}
    </span>
  );
}

function StatCard({ label, value, icon, color }) {
  return (
    <div className="stat-card" style={{ borderTop: `3px solid ${color}` }}>
      <div className="stat-icon">{icon}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export default function Dashboard({ onSelectOpportunity, onNewRfp }) {
  const [opportunities, setOpportunities] = useState([]);
  const [loading, setLoading]             = useState(true);
  const [search, setSearch]               = useState('');

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const list = await getOpportunities();
        setOpportunities(list);
      } catch (e) {
        console.error('Dashboard load error:', e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const filtered = opportunities.filter(o =>
    o.name.toLowerCase().includes(search.toLowerCase()) ||
    (o.account || '').toLowerCase().includes(search.toLowerCase())
  );

  const inProgress  = opportunities.filter(o => !['Closed Won','Closed Lost'].includes(o.stage));
  const closedWon   = opportunities.filter(o => o.stage === 'Closed Won').length;
  const totalValue  = opportunities.reduce((s, o) => s + (o.amount || 0), 0);

  return (
    <div className="dashboard-page">
      {/* Header Row */}
      <div className="dash-header">
        <div>
          <h1 className="dash-title">Active Bids Dashboard</h1>
          <p className="dash-subtitle">
            {loading ? 'Loading opportunities...' : `${inProgress.length} bids in progress · ${opportunities.length} total`}
          </p>
        </div>
        <button className="new-rfp-btn" onClick={onNewRfp}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          New RFP
        </button>
      </div>

      {/* Stats Row */}
      <div className="stats-row">
        <StatCard label="In Progress"   value={inProgress.length}    icon="🔄" color="#6366f1" />
        <StatCard label="Closed Won"    value={closedWon}            icon="🏆" color="#22c55e" />
        <StatCard label="Total Pipeline" value={`$${(totalValue/1000000).toFixed(1)}M`} icon="💰" color="#f59e0b" />
        <StatCard label="Total Bids"    value={opportunities.length} icon="📋" color="#06b6d4" />
      </div>

      {/* Search */}
      <div className="dash-search-bar">
        <span className="dash-search-icon">🔍</span>
        <input
          type="text"
          className="dash-search-input"
          placeholder="Search by opportunity name or account..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* Table */}
      {loading ? (
        <div className="dash-loading">
          <div className="dash-spinner"/>
          <span>Loading live Salesforce data...</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="dash-empty">
          <div className="dash-empty-icon">📭</div>
          <p>No opportunities found. Start by uploading an RFP!</p>
          <button className="new-rfp-btn" onClick={onNewRfp}>+ New RFP</button>
        </div>
      ) : (
        <div className="opp-grid">
          {filtered.map(opp => (
            <div
              key={opp.id}
              className="opp-card"
              onClick={() => onSelectOpportunity(opp)}
            >
              <div className="opp-card-top">
                <div className="opp-card-name">{opp.name}</div>
                <RecommendationBadge recommendation={opp.recommendation} />
              </div>
              <div className="opp-card-account">{opp.account || 'Unknown Account'}</div>
              <div className="opp-card-meta">
                <span
                  className="opp-stage-chip"
                  style={{ background: (STAGE_COLORS[opp.stage] || '#6366f1') + '22', color: STAGE_COLORS[opp.stage] || '#6366f1' }}
                >
                  {opp.stage}
                </span>
                <span className="opp-card-amount">
                  {opp.amount ? `$${opp.amount.toLocaleString()}` : 'TBD'}
                </span>
              </div>
              <div className="opp-card-footer">
                <span className="opp-close-date">Close: {opp.closeDate}</span>
                <span className="opp-card-cta">Analyze →</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
