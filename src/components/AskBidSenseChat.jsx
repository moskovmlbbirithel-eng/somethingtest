import React, { useState, useRef, useEffect } from 'react';
import { askAgentforce } from '../services/agentforceService.js';

export default function AskBidSenseChat({ opportunityId }) {
  const [messages, setMessages] = useState([
    {
      sender: 'agent',
      text: 'Ask me anything about this opportunity! I can look up employees, find SMEs, or answer any bid qualification question.'
    }
  ]);
  const [inputQuery, setInputQuery] = useState('');
  const [isAsking, setIsAsking] = useState(false);
  // Track whether a session is active to trigger re-render for the indicator
  const [sessionActive, setSessionActive] = useState(false);

  // Persists the Agentforce session across turns without causing re-renders on every message
  const sessionIdRef = useRef(null);

  // Reset session when the opportunity changes
  useEffect(() => {
    sessionIdRef.current = null;
    setSessionActive(false);
    setMessages([{
      sender: 'agent',
      text: 'Ask me anything about this opportunity! I can look up employees, find SMEs, or answer any bid qualification question.'
    }]);
  }, [opportunityId]);

  const samplePrompts = [
    "Get the details of EMP001 employee",
    "Find the top 5 SMEs for Salesforce & FHIR",
    "What is the biggest risk for this bid?"
  ];

  const handleSendQuestion = async (queryText) => {
    const textToSend = queryText || inputQuery;
    if (!textToSend.trim() || isAsking) return;

    setMessages((prev) => [...prev, { sender: 'user', text: textToSend }]);
    setInputQuery('');
    setIsAsking(true);

    try {
      const { reply, sessionId: newSessionId } = await askAgentforce(
        opportunityId,
        textToSend,
        sessionIdRef.current  // pass existing session for multi-turn context
      );

      // Store session ID for the next turn
      if (newSessionId && newSessionId !== sessionIdRef.current) {
        sessionIdRef.current = newSessionId;
        setSessionActive(true);  // trigger indicator re-render once
      }

      setMessages((prev) => [...prev, { sender: 'agent', text: reply }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { sender: 'agent', text: 'Error connecting to Agentforce. Please try again.' }
      ]);
    } finally {
      setIsAsking(false);
    }
  };

  return (
    <div className="chat-card">
      <div className="card-title">
        <span>Ask BidSense (AI Agent Assistant)</span>
        <span style={{ fontSize: '12px', fontWeight: '500', display: 'flex', alignItems: 'center', gap: '6px' }}>
          {sessionActive ? (
            <>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
              <span style={{ color: '#22c55e' }}>Session Active</span>
            </>
          ) : (
            <span style={{ color: 'var(--sf-blue-primary)' }}>Agentforce Q&amp;A Mode</span>
          )}
        </span>
      </div>

      {/* Suggested Prompt Chips */}
      <div className="suggested-prompts">
        {samplePrompts.map((prompt, idx) => (
          <button
            key={idx}
            className="chip-btn"
            onClick={() => handleSendQuestion(prompt)}
            disabled={isAsking}
          >
            {prompt}
          </button>
        ))}
      </div>

      {/* Messages Log */}
      <div className="chat-history">
        {messages.map((msg, idx) => (
          <div key={idx} className={`chat-bubble ${msg.sender}`} style={{ whiteSpace: 'pre-wrap' }}>
            {msg.text}
          </div>
        ))}
        {isAsking && (
          <div className="chat-bubble agent" style={{ fontStyle: 'italic', color: '#666' }}>
            Agentforce is thinking...
          </div>
        )}
      </div>

      {/* Chat Input Form */}
      <form
        className="chat-input-form"
        onSubmit={(e) => {
          e.preventDefault();
          handleSendQuestion();
        }}
      >
        <input
          type="text"
          className="chat-input"
          placeholder="Ask BidSense a question about this opportunity..."
          value={inputQuery}
          onChange={(e) => setInputQuery(e.target.value)}
          disabled={isAsking}
        />
        <button type="submit" className="btn-send" disabled={isAsking || !inputQuery.trim()}>
          Ask
        </button>
      </form>
    </div>
  );
}
