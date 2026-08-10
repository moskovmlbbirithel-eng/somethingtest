import React, { useState } from 'react';
import { askAgentforce } from '../services/agentforceService.js';

export default function AskBidSenseChat({ opportunityId }) {
  const [messages, setMessages] = useState([
    {
      sender: 'agent',
      text: 'Ask me anything about this opportunity qualification! You can pick a question below or type your own.'
    }
  ]);
  const [inputQuery, setInputQuery] = useState('');
  const [isAsking, setIsAsking] = useState(false);

  const samplePrompts = [
    "Why did you recommend bidding?",
    "What is the biggest risk?",
    "Which requirements are difficult for us to satisfy?"
  ];

  const handleSendQuestion = async (queryText) => {
    const textToSend = queryText || inputQuery;
    if (!textToSend.trim() || isAsking) return;

    // Append user message
    const userMsg = { sender: 'user', text: textToSend };
    setMessages((prev) => [...prev, userMsg]);
    setInputQuery('');
    setIsAsking(true);

    try {
      // Call isolated Agentforce Q&A service
      const agentReply = await askAgentforce(opportunityId, textToSend);
      setMessages((prev) => [...prev, { sender: 'agent', text: agentReply }]);
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
        <span style={{ fontSize: '12px', fontWeight: '500', color: 'var(--sf-blue-primary)' }}>
          Agentforce Q&A Mode
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
          <div key={idx} className={`chat-bubble ${msg.sender}`}>
            {msg.text}
          </div>
        ))}
        {isAsking && (
          <div className="chat-bubble agent" style={{ fontStyle: 'italic', color: '#666' }}>
            Agentforce is evaluating context...
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
