import React, { useState, useEffect, useRef } from 'react';
import MCPManager from './MCPManager';

function Terminal({ socket, messages }) {
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [output, setOutput] = useState([
    { type: 'system', text: 'AI Terminal - WhatsApp messages go to AI automatically' },
    { type: 'system', text: 'WhatsApp commands: /claude, /qwen, /status' }
  ]);
  const [currentProvider, setCurrentProvider] = useState('claude');
  const [input, setInput] = useState('');
  const [isWaiting, setIsWaiting] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [isTypingWhatsApp, setIsTypingWhatsApp] = useState(false);
  const [typingText, setTypingText] = useState('');
  const [pendingMessages, setPendingMessages] = useState([]);
  const terminalRef = useRef(null);
  const inputRef = useRef(null);
  const processedIds = useRef(new Set());

  // Auto-scroll to bottom
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [output, streamingText, typingText]);

  // Focus input when clicking terminal
  const handleTerminalClick = () => {
    inputRef.current?.focus();
  };

  // Socket event listeners for AI providers
  useEffect(() => {
    if (!socket) return;

    const handleStream = ({ text, done }) => {
      if (done) {
        // Streaming complete - add full response to history
        if (streamingText) {
          setOutput(prev => [...prev, { type: currentProvider, text: streamingText }]);
        }
        setStreamingText('');
        setIsWaiting(false);
      } else {
        setStreamingText(prev => prev + text);
      }
    };

    const handleError = (error) => {
      setOutput(prev => [...prev, { type: 'error', text: `Error: ${error}` }]);
      setStreamingText('');
      setIsWaiting(false);
    };

    // Handle WhatsApp -> AI processing
    const handleAIProcessing = ({ prompt, provider }) => {
      setOutput(prev => [...prev, { type: 'whatsapp-prompt', text: prompt, provider }]);
      setIsWaiting(true);
    };

    // Handle AI response
    const handleAIResponse = ({ response, provider }) => {
      setOutput(prev => [...prev, { type: provider, text: response }]);
      setIsWaiting(false);
    };

    // Handle AI provider switch
    const handleAISwitched = ({ provider }) => {
      setCurrentProvider(provider);
      setOutput(prev => [...prev, { type: 'system', text: `Switched to ${provider.toUpperCase()} AI` }]);
    };

    socket.on('claude-stream', handleStream);
    socket.on('claude-error', handleError);
    socket.on('ai-processing', handleAIProcessing);
    socket.on('ai-response', handleAIResponse);
    socket.on('ai-switched', handleAISwitched);

    return () => {
      socket.off('claude-stream', handleStream);
      socket.off('claude-error', handleError);
      socket.off('ai-processing', handleAIProcessing);
      socket.off('ai-response', handleAIResponse);
      socket.off('ai-switched', handleAISwitched);
    };
  }, [socket, streamingText, currentProvider]);

  // Watch for new WhatsApp messages
  useEffect(() => {
    const newMessages = messages.filter(msg => !processedIds.current.has(msg.id));
    if (newMessages.length > 0) {
      newMessages.forEach(msg => processedIds.current.add(msg.id));
      setPendingMessages(prev => [...prev, ...newMessages]);
    }
  }, [messages]);

  // Process pending WhatsApp messages with typing animation
  useEffect(() => {
    if (isTypingWhatsApp || pendingMessages.length === 0 || isWaiting) return;

    const nextMsg = pendingMessages[0];
    const text = nextMsg.body || '[media]';

    setIsTypingWhatsApp(true);
    setTypingText('');

    let index = 0;
    const typeInterval = setInterval(() => {
      if (index < text.length) {
        setTypingText(text.substring(0, index + 1));
        index++;
      } else {
        clearInterval(typeInterval);
        setOutput(prev => [...prev, {
          type: 'whatsapp',
          text: text
        }]);
        setTypingText('');
        setIsTypingWhatsApp(false);
        setPendingMessages(prev => prev.slice(1));
      }
    }, 25);

    return () => clearInterval(typeInterval);
  }, [pendingMessages, isTypingWhatsApp, isWaiting]);

  // Handle user input
  const handleSubmit = (e) => {
    e.preventDefault();
    if (!input.trim() || isWaiting) return;

    const message = input.trim();
    setInput('');

    // Handle commands
    if (message === '/clear') {
      setOutput([{ type: 'system', text: 'Terminal cleared.' }]);
      return;
    }

    // Show user input and send to Claude
    setOutput(prev => [...prev, { type: 'user', text: message }]);
    setIsWaiting(true);
    setStreamingText('');

    socket?.emit('claude-message', message);
  };

  return (
    <div className="terminal" onClick={handleTerminalClick}>
      <div className="terminal-header">
        <div className="terminal-buttons">
          <span className="terminal-btn red"></span>
          <span className="terminal-btn yellow"></span>
          <span className="terminal-btn green"></span>
        </div>
        <span className="terminal-title">AI Terminal ({currentProvider.toUpperCase()})</span>
        <button
          className="terminal-settings-btn"
          onClick={(e) => { e.stopPropagation(); setMcpModalOpen(true); }}
          title="MCP Settings"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
          </svg>
        </button>
      </div>
      <div className="terminal-body" ref={terminalRef}>
        {output.map((line, index) => (
          <div key={index} className={`terminal-line ${line.type}`}>
            {line.type === 'system' && (
              <span className="terminal-system">{line.text}</span>
            )}
            {line.type === 'user' && (
              <>
                <span className="terminal-user-prompt">$ you &gt;</span>
                <span className="terminal-user-input">{line.text}</span>
              </>
            )}
            {line.type === 'qwen' && (
              <>
                <span className="terminal-qwen-prompt">qwen &gt;</span>
                <span className="terminal-qwen-response">{line.text}</span>
              </>
            )}
            {line.type === 'claude' && (
              <>
                <span className="terminal-claude-prompt">claude &gt;</span>
                <span className="terminal-claude-response">{line.text}</span>
              </>
            )}
            {line.type === 'whatsapp-prompt' && (
              <>
                <span className="terminal-whatsapp-prompt">[WhatsApp → Qwen]</span>
                <span className="terminal-whatsapp-text">{line.text}</span>
              </>
            )}
            {line.type === 'whatsapp' && (
              <>
                <span className="terminal-whatsapp-prompt">[WhatsApp] &gt;</span>
                <span className="terminal-whatsapp-text">{line.text}</span>
              </>
            )}
            {line.type === 'error' && (
              <span className="terminal-error">{line.text}</span>
            )}
          </div>
        ))}

        {/* AI streaming response */}
        {isWaiting && streamingText && (
          <div className="terminal-line streaming">
            <span className={`terminal-${currentProvider}-prompt`}>{currentProvider} &gt;</span>
            <span className={`terminal-${currentProvider}-response`}>
              {streamingText}
              <span className="terminal-cursor">|</span>
            </span>
          </div>
        )}

        {/* WhatsApp typing animation */}
        {isTypingWhatsApp && typingText && (
          <div className="terminal-line whatsapp-typing">
            <span className="terminal-whatsapp-prompt">[WhatsApp] &gt;</span>
            <span className="terminal-whatsapp-text">
              {typingText}
              <span className="terminal-cursor">|</span>
            </span>
          </div>
        )}

        {/* Waiting indicator */}
        {isWaiting && !streamingText && (
          <div className="terminal-line waiting">
            <span className={`terminal-${currentProvider}-prompt`}>{currentProvider} &gt;</span>
            <span className="terminal-waiting">thinking...</span>
          </div>
        )}

        {/* Input line */}
        <form onSubmit={handleSubmit} className="terminal-input-line">
          <span className="terminal-user-prompt">$</span>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="terminal-input"
            placeholder={isWaiting ? `Waiting for ${currentProvider}...` : `Type a message to ${currentProvider}...`}
            disabled={isWaiting}
            autoFocus
          />
        </form>
      </div>

      <MCPManager
        socket={socket}
        isOpen={mcpModalOpen}
        onClose={() => setMcpModalOpen(false)}
      />
    </div>
  );
}

export default Terminal;
