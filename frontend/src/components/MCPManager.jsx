import React, { useState, useEffect } from 'react';

function MCPManager({ socket, isOpen, onClose }) {
  const [mcps, setMcps] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [newName, setNewName] = useState('');
  const [newCommand, setNewCommand] = useState('');
  const [adding, setAdding] = useState(false);

  // Fetch MCPs when modal opens
  useEffect(() => {
    if (isOpen && socket) {
      fetchMCPs();
    }
  }, [isOpen, socket]);

  // Socket event listeners
  useEffect(() => {
    if (!socket) return;

    const handleMCPsList = ({ mcps: mcpList, error: err }) => {
      setLoading(false);
      if (err) {
        setError(err);
        setMcps([]);
      } else {
        setMcps(mcpList || []);
        setError(null);
      }
    };

    const handleMCPAdded = ({ success, error: err, name }) => {
      setAdding(false);
      if (success) {
        setNewName('');
        setNewCommand('');
        fetchMCPs();
      } else {
        setError(err || 'Failed to add MCP');
      }
    };

    const handleMCPRemoved = ({ success, error: err }) => {
      if (success) {
        fetchMCPs();
      } else {
        setError(err || 'Failed to remove MCP');
      }
    };

    socket.on('mcps-list', handleMCPsList);
    socket.on('mcp-added', handleMCPAdded);
    socket.on('mcp-removed', handleMCPRemoved);

    return () => {
      socket.off('mcps-list', handleMCPsList);
      socket.off('mcp-added', handleMCPAdded);
      socket.off('mcp-removed', handleMCPRemoved);
    };
  }, [socket]);

  const fetchMCPs = () => {
    setLoading(true);
    setError(null);
    socket?.emit('get-mcps');
  };

  const handleAddMCP = (e) => {
    e.preventDefault();
    if (!newName.trim() || !newCommand.trim()) return;

    setAdding(true);
    setError(null);
    socket?.emit('add-mcp', { name: newName.trim(), command: newCommand.trim() });
  };

  const handleRemoveMCP = (name) => {
    if (confirm(`Remove MCP "${name}"?`)) {
      socket?.emit('remove-mcp', { name });
    }
  };

  if (!isOpen) return null;

  return (
    <div className="mcp-modal-overlay" onClick={onClose}>
      <div className="mcp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mcp-modal-header">
          <h2>MCP Servers</h2>
          <button className="mcp-close-btn" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="mcp-modal-body">
          {loading && (
            <div className="mcp-loading">Loading MCP servers...</div>
          )}

          {error && (
            <div className="mcp-error">{error}</div>
          )}

          {!loading && mcps.length === 0 && !error && (
            <div className="mcp-empty">No MCP servers configured</div>
          )}

          <div className="mcp-list">
            {mcps.map((mcp) => (
              <div key={mcp.name} className="mcp-item">
                <div className="mcp-item-info">
                  <div className="mcp-item-header">
                    <span className={`mcp-status-dot ${mcp.status}`}></span>
                    <span className="mcp-item-name">{mcp.name}</span>
                    {mcp.statusText && (
                      <span className={`mcp-status-text ${mcp.status}`}>
                        {mcp.status === 'connected' ? '✓' : '✗'} {mcp.statusText}
                      </span>
                    )}
                  </div>
                  {mcp.command && (
                    <div className="mcp-item-command">{mcp.command}</div>
                  )}
                </div>
                <div className="mcp-item-actions">
                  <button
                    className="mcp-delete-btn"
                    onClick={() => handleRemoveMCP(mcp.name)}
                    title="Remove MCP"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/>
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="mcp-add-section">
            <h3>Add New MCP</h3>
            <form onSubmit={handleAddMCP} className="mcp-add-form">
              <div className="mcp-form-group">
                <label>Name:</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g., web-browser"
                  className="mcp-input"
                  disabled={adding}
                />
              </div>
              <div className="mcp-form-group">
                <label>Command:</label>
                <input
                  type="text"
                  value={newCommand}
                  onChange={(e) => setNewCommand(e.target.value)}
                  placeholder="e.g., npx -y @anthropic/mcp-server"
                  className="mcp-input"
                  disabled={adding}
                />
              </div>
              <button
                type="submit"
                className="mcp-add-btn"
                disabled={adding || !newName.trim() || !newCommand.trim()}
              >
                {adding ? 'Adding...' : 'Add MCP'}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

export default MCPManager;
