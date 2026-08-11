import React from 'react';

export default function Header({ currentView, onHome, onNewRfp }) {
  return (
    <header className="header-bar">
      <div className="header-brand" onClick={onHome} style={{ cursor: 'pointer' }}>
        <div className="header-logo">BidSense</div>
        <div>
          <h1 className="header-title">AI-Powered RFP Intelligence</h1>
          <p className="header-subtitle">Agentforce · Salesforce · MCP</p>
        </div>
      </div>

      <nav className="header-nav">
        <button
          className={`header-nav-btn ${currentView === 'dashboard' ? 'active' : ''}`}
          onClick={onHome}
        >
          🏠 Dashboard
        </button>
        <button
          className={`header-nav-btn ${currentView === 'new_rfp' ? 'active' : ''}`}
          onClick={onNewRfp}
        >
          ➕ New RFP
        </button>
      </nav>

      <div className="header-status">
        <span className="status-badge" title="Live Salesforce Org Connected via SF CLI">
          <span className="status-dot"/>
          Live Org
        </span>
        <span className="status-badge" style={{ backgroundColor: 'rgba(75, 111, 255, 0.2)' }}>
          Agentforce AI
        </span>
      </div>
    </header>
  );
}
