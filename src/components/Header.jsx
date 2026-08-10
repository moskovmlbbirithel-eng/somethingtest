import React from 'react';

export default function Header() {
  return (
    <header className="header-bar">
      <div className="header-brand">
        <div className="header-logo">BidSense</div>
        <div>
          <h1 className="header-title">Salesforce Bid/No-Bid Qualification</h1>
          <p className="header-subtitle">Live Agentforce AI & Headless SOQL Integration</p>
        </div>
      </div>
      <div className="header-status">
        <span className="status-badge" title="Live Salesforce Org Connected via SF CLI">
          <span className="status-dot"></span>
          Connected: karthikpadmakumar21@agentforce.com
        </span>
        <span className="status-badge" style={{ backgroundColor: 'rgba(75, 111, 255, 0.2)' }}>
          Headless Agentforce Engine
        </span>
      </div>
    </header>
  );
}
