import React, { useState, useEffect } from 'react';

function MCPManager({ socket, isOpen, onClose }) {
  const [mcps, setMcps] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [newName, setNewName] = useState('');
  const [newCommand, setNewCommand] = useState('');
  const [adding, setAdding] = useState(false);
  const [expandedMcp, setExpandedMcp] = useState(null);
  const [mcpDetails, setMcpDetails] = useState({});
  const [loadingDetails, setLoadingDetails] = useState({});
  const [permissions, setPermissions] = useState({ allow: [], deny: [], ask: [] });
  const [updatingPerm, setUpdatingPerm] = useState(null);
  const [editingEnv, setEditingEnv] = useState(null);
  const [envEdits, setEnvEdits] = useState({});
  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvValue, setNewEnvValue] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);
  const [viewMode, setViewMode] = useState('form'); // 'form' or 'json'
  const [jsonConfig, setJsonConfig] = useState('');
  const [jsonError, setJsonError] = useState(null);
  const [savingJson, setSavingJson] = useState(false);

  // Fetch MCPs when modal opens
  useEffect(() => {
    if (isOpen && socket) {
      fetchMCPs();
      fetchPermissions();
      fetchJsonConfig();
    }
  }, [isOpen, socket]);

  // Fetch full JSON config
  const fetchJsonConfig = () => {
    socket?.emit('get-mcp-json-config');
  };

  // Only fetch JSON from file when switching to JSON view - don't rebuild from MCPs
  // This ensures we get the actual saved config including env vars

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

    const handleMCPDetails = (details) => {
      setLoadingDetails(prev => ({ ...prev, [details.name]: false }));
      if (!details.error) {
        setMcpDetails(prev => ({ ...prev, [details.name]: details }));
        // Initialize env edits if not already set
        if (details.env && !envEdits[details.name]) {
          setEnvEdits(prev => ({ ...prev, [details.name]: { ...details.env } }));
        }
      }
    };

    const handleMCPPermissions = ({ permissions: perms, error: err }) => {
      if (!err && perms) {
        setPermissions(perms);
      }
      setUpdatingPerm(null);
    };

    const handlePermissionUpdated = ({ success, error: err }) => {
      setUpdatingPerm(null);
      if (!success) {
        setError(err || 'Failed to update permission');
      }
    };

    const handleConfigUpdated = ({ success, error: err, name }) => {
      setSavingConfig(false);
      if (success) {
        setEditingEnv(null);
        // Refresh MCP details
        if (name) {
          setLoadingDetails(prev => ({ ...prev, [name]: true }));
          socket?.emit('get-mcp-details', { name });
        }
        fetchMCPs();
      } else {
        setError(err || 'Failed to update config');
      }
    };

    const handleJsonConfig = ({ config, error: err }) => {
      if (err) {
        setJsonError(err);
      } else if (config) {
        setJsonConfig(JSON.stringify(config, null, 2));
        setJsonError(null);
      }
    };

    const handleJsonConfigSaved = ({ success, error: err }) => {
      setSavingJson(false);
      if (success) {
        setJsonError(null);
        fetchMCPs();
        fetchJsonConfig();
      } else {
        setJsonError(err || 'Failed to save JSON config');
      }
    };

    socket.on('mcps-list', handleMCPsList);
    socket.on('mcp-added', handleMCPAdded);
    socket.on('mcp-removed', handleMCPRemoved);
    socket.on('mcp-details', handleMCPDetails);
    socket.on('mcp-permissions', handleMCPPermissions);
    socket.on('mcp-permission-updated', handlePermissionUpdated);
    socket.on('mcp-config-updated', handleConfigUpdated);
    socket.on('mcp-json-config', handleJsonConfig);
    socket.on('mcp-json-config-saved', handleJsonConfigSaved);

    return () => {
      socket.off('mcps-list', handleMCPsList);
      socket.off('mcp-added', handleMCPAdded);
      socket.off('mcp-removed', handleMCPRemoved);
      socket.off('mcp-details', handleMCPDetails);
      socket.off('mcp-permissions', handleMCPPermissions);
      socket.off('mcp-permission-updated', handlePermissionUpdated);
      socket.off('mcp-config-updated', handleConfigUpdated);
      socket.off('mcp-json-config', handleJsonConfig);
      socket.off('mcp-json-config-saved', handleJsonConfigSaved);
    };
  }, [socket, envEdits]);

  const fetchMCPs = () => {
    setLoading(true);
    setError(null);
    socket?.emit('get-mcps');
  };

  const fetchPermissions = () => {
    socket?.emit('get-mcp-permissions');
  };

  const fetchMCPDetails = (name) => {
    if (!mcpDetails[name] && !loadingDetails[name]) {
      setLoadingDetails(prev => ({ ...prev, [name]: true }));
      socket?.emit('get-mcp-details', { name });
    }
  };

  const toggleExpanded = (name) => {
    if (expandedMcp === name) {
      setExpandedMcp(null);
      setEditingEnv(null);
    } else {
      setExpandedMcp(name);
      fetchMCPDetails(name);
    }
  };

  const handleAddMCP = (e) => {
    e.preventDefault();
    if (!newName.trim() || !newCommand.trim()) return;

    setAdding(true);
    setError(null);
    socket?.emit('add-mcp', { name: newName.trim(), command: newCommand.trim() });
  };

  const handleRemoveMCP = (name, e) => {
    e.stopPropagation();
    if (confirm(`Remove MCP "${name}"?`)) {
      socket?.emit('remove-mcp', { name });
    }
  };

  const updateToolPermission = (mcpName, toolName, action, e) => {
    e.stopPropagation();
    setUpdatingPerm(`${mcpName}__${toolName}`);
    socket?.emit('update-mcp-permission', { mcp: mcpName, tool: toolName, action });
  };

  const updateAllPermissions = (mcpName, action, e) => {
    e.stopPropagation();
    setUpdatingPerm(`${mcpName}__*`);
    socket?.emit('update-mcp-all-permissions', { mcp: mcpName, action });
  };

  const startEditingEnv = (mcpName, e) => {
    e.stopPropagation();
    const currentEnv = mcpDetails[mcpName]?.env || {};
    setEnvEdits(prev => ({ ...prev, [mcpName]: { ...currentEnv } }));
    setEditingEnv(mcpName);
    setNewEnvKey('');
    setNewEnvValue('');
  };

  const cancelEditingEnv = (e) => {
    e.stopPropagation();
    setEditingEnv(null);
    setNewEnvKey('');
    setNewEnvValue('');
  };

  const updateEnvValue = (mcpName, key, value) => {
    setEnvEdits(prev => ({
      ...prev,
      [mcpName]: { ...prev[mcpName], [key]: value }
    }));
  };

  const removeEnvVar = (mcpName, key) => {
    setEnvEdits(prev => {
      const newEnv = { ...prev[mcpName] };
      delete newEnv[key];
      return { ...prev, [mcpName]: newEnv };
    });
  };

  const addEnvVar = (mcpName) => {
    if (!newEnvKey.trim()) return;
    setEnvEdits(prev => ({
      ...prev,
      [mcpName]: { ...prev[mcpName], [newEnvKey.trim()]: newEnvValue }
    }));
    setNewEnvKey('');
    setNewEnvValue('');
  };

  const saveEnvConfig = (mcpName, e) => {
    e.stopPropagation();
    setSavingConfig(true);
    const mcp = mcps.find(m => m.name === mcpName);
    socket?.emit('update-mcp-config', {
      name: mcpName,
      env: envEdits[mcpName] || {},
      command: mcp?.command || ''
    });
  };

  const handleJsonChange = (e) => {
    setJsonConfig(e.target.value);
    setJsonError(null);
    // Validate JSON
    try {
      JSON.parse(e.target.value);
    } catch (err) {
      setJsonError('Invalid JSON: ' + err.message);
    }
  };

  const saveJsonConfig = () => {
    try {
      const config = JSON.parse(jsonConfig);
      if (!config.mcpServers) {
        setJsonError('JSON must contain "mcpServers" object');
        return;
      }
      setSavingJson(true);
      setJsonError(null);
      socket?.emit('save-mcp-json-config', { config });
    } catch (err) {
      setJsonError('Invalid JSON: ' + err.message);
    }
  };

  // Get permission status for a tool
  const getToolPermission = (mcpName, toolName) => {
    const wildcardAllow = permissions.allow.find(p => p.mcp === mcpName && p.tool === '*');
    const wildcardDeny = permissions.deny.find(p => p.mcp === mcpName && p.tool === '*');

    if (wildcardAllow) return 'allowed';
    if (wildcardDeny) return 'denied';

    const allowed = permissions.allow.find(p => p.mcp === mcpName && p.tool === toolName);
    const denied = permissions.deny.find(p => p.mcp === mcpName && p.tool === toolName);
    const ask = permissions.ask.find(p => p.mcp === mcpName && p.tool === toolName);

    if (allowed) return 'allowed';
    if (denied) return 'denied';
    if (ask) return 'ask';
    return 'default';
  };

  const getMcpPermissionSummary = (mcpName) => {
    const mcpPerms = {
      allowed: permissions.allow.filter(p => p.mcp === mcpName).length,
      denied: permissions.deny.filter(p => p.mcp === mcpName).length,
      ask: permissions.ask.filter(p => p.mcp === mcpName).length
    };

    const hasWildcardAllow = permissions.allow.some(p => p.mcp === mcpName && p.tool === '*');
    if (hasWildcardAllow) return { status: 'all-allowed', text: 'All tools allowed' };

    const hasWildcardDeny = permissions.deny.some(p => p.mcp === mcpName && p.tool === '*');
    if (hasWildcardDeny) return { status: 'all-denied', text: 'All tools denied' };

    if (mcpPerms.allowed > 0 || mcpPerms.denied > 0) {
      return { status: 'partial', text: `${mcpPerms.allowed} allowed, ${mcpPerms.denied} denied` };
    }

    return { status: 'default', text: 'Default permissions' };
  };

  if (!isOpen) return null;

  return (
    <div className="mcp-modal-overlay" onClick={onClose}>
      <div className="mcp-modal mcp-modal-large" onClick={(e) => e.stopPropagation()}>
        <div className="mcp-modal-header">
          <h2>MCP Servers</h2>
          <div className="mcp-view-toggle">
            <button
              className={`mcp-view-btn ${viewMode === 'form' ? 'active' : ''}`}
              onClick={() => setViewMode('form')}
            >
              Form
            </button>
            <button
              className={`mcp-view-btn ${viewMode === 'json' ? 'active' : ''}`}
              onClick={() => { setViewMode('json'); fetchJsonConfig(); }}
            >
              JSON
            </button>
          </div>
          <button className="mcp-close-btn" onClick={onClose}>&times;</button>
        </div>

        <div className="mcp-modal-body">
          {error && <div className="mcp-error">{error}</div>}

          {viewMode === 'json' ? (
            <div className="mcp-json-editor">
              <div className="mcp-json-hint">
                Edit MCP configuration as JSON. Format:
                <code>{`{ "mcpServers": { "name": { "command": "npx", "args": [...], "env": {...} } } }`}</code>
              </div>
              {jsonError && <div className="mcp-error">{jsonError}</div>}
              <textarea
                className="mcp-json-textarea"
                value={jsonConfig}
                onChange={handleJsonChange}
                placeholder='{"mcpServers": {}}'
                spellCheck={false}
              />
              <div className="mcp-json-actions">
                <button
                  className="mcp-json-save-btn"
                  onClick={saveJsonConfig}
                  disabled={savingJson || !!jsonError}
                >
                  {savingJson ? 'Saving...' : 'Save Configuration'}
                </button>
                <button
                  className="mcp-json-refresh-btn"
                  onClick={fetchJsonConfig}
                >
                  Refresh
                </button>
              </div>
            </div>
          ) : (
            <>
              {loading && <div className="mcp-loading">Loading MCP servers...</div>}
              {!loading && mcps.length === 0 && !error && (
                <div className="mcp-empty">No MCP servers configured</div>
              )}

          <div className="mcp-list">
            {mcps.map((mcp) => {
              const permSummary = getMcpPermissionSummary(mcp.name);
              const details = mcpDetails[mcp.name];
              const isEditing = editingEnv === mcp.name;
              const currentEnvEdits = envEdits[mcp.name] || {};

              return (
                <div key={mcp.name} className={`mcp-item ${expandedMcp === mcp.name ? 'expanded' : ''}`}>
                  <div className="mcp-item-header-row" onClick={() => toggleExpanded(mcp.name)}>
                    <div className="mcp-item-info">
                      <div className="mcp-item-header">
                        <span className={`mcp-expand-icon ${expandedMcp === mcp.name ? 'expanded' : ''}`}>▶</span>
                        <span className={`mcp-status-dot ${mcp.status}`}></span>
                        <span className="mcp-item-name">{mcp.name}</span>
                        {mcp.statusText && (
                          <span className={`mcp-status-text ${mcp.status}`}>
                            {mcp.status === 'connected' ? '✓' : '✗'} {mcp.statusText}
                          </span>
                        )}
                      </div>
                      <div className="mcp-item-meta">
                        {mcp.command && <div className="mcp-item-command">{mcp.command}</div>}
                        <div className={`mcp-perm-summary ${permSummary.status}`}>{permSummary.text}</div>
                      </div>
                    </div>
                    <div className="mcp-item-actions">
                      <button className="mcp-delete-btn" onClick={(e) => handleRemoveMCP(mcp.name, e)} title="Remove MCP">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z"/>
                        </svg>
                      </button>
                    </div>
                  </div>

                  {expandedMcp === mcp.name && (
                    <div className="mcp-item-details">
                      {loadingDetails[mcp.name] ? (
                        <div className="mcp-details-loading">Loading details...</div>
                      ) : details ? (
                        <>
                          <div className="mcp-details-section">
                            <div className="mcp-details-row">
                              <span className="mcp-details-label">Scope:</span>
                              <span className="mcp-details-value">{details.scope || 'N/A'}</span>
                            </div>
                            <div className="mcp-details-row">
                              <span className="mcp-details-label">Type:</span>
                              <span className="mcp-details-value">{details.type || 'N/A'}</span>
                            </div>
                            {details.args && (
                              <div className="mcp-details-row">
                                <span className="mcp-details-label">Args:</span>
                                <span className="mcp-details-value">{details.args}</span>
                              </div>
                            )}
                          </div>

                          {/* Environment Variables Section */}
                          <div className="mcp-env-section">
                            <div className="mcp-env-header">
                              <span className="mcp-env-title">Environment Variables</span>
                              {!isEditing ? (
                                <button className="mcp-env-edit-btn" onClick={(e) => startEditingEnv(mcp.name, e)}>
                                  Edit
                                </button>
                              ) : (
                                <div className="mcp-env-actions">
                                  <button
                                    className="mcp-env-save-btn"
                                    onClick={(e) => saveEnvConfig(mcp.name, e)}
                                    disabled={savingConfig}
                                  >
                                    {savingConfig ? 'Saving...' : 'Save'}
                                  </button>
                                  <button className="mcp-env-cancel-btn" onClick={cancelEditingEnv}>
                                    Cancel
                                  </button>
                                </div>
                              )}
                            </div>

                            {isEditing ? (
                              <div className="mcp-env-editor">
                                {Object.entries(currentEnvEdits).map(([key, value]) => (
                                  <div key={key} className="mcp-env-row">
                                    <span className="mcp-env-key">{key}</span>
                                    <input
                                      type="text"
                                      className="mcp-env-input"
                                      value={value}
                                      onChange={(e) => updateEnvValue(mcp.name, key, e.target.value)}
                                      placeholder="Value"
                                    />
                                    <button
                                      className="mcp-env-remove-btn"
                                      onClick={() => removeEnvVar(mcp.name, key)}
                                      title="Remove"
                                    >
                                      ✗
                                    </button>
                                  </div>
                                ))}
                                <div className="mcp-env-add-row">
                                  <input
                                    type="text"
                                    className="mcp-env-input mcp-env-key-input"
                                    value={newEnvKey}
                                    onChange={(e) => setNewEnvKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                                    placeholder="KEY"
                                  />
                                  <input
                                    type="text"
                                    className="mcp-env-input"
                                    value={newEnvValue}
                                    onChange={(e) => setNewEnvValue(e.target.value)}
                                    placeholder="Value"
                                  />
                                  <button
                                    className="mcp-env-add-btn"
                                    onClick={() => addEnvVar(mcp.name)}
                                    disabled={!newEnvKey.trim()}
                                  >
                                    +
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="mcp-env-display">
                                {details.env && Object.keys(details.env).length > 0 ? (
                                  Object.entries(details.env).map(([key, value]) => (
                                    <div key={key} className="mcp-env-item">
                                      <span className="mcp-env-key">{key}</span>
                                      <span className="mcp-env-value">{value ? '••••••••' : '(empty)'}</span>
                                    </div>
                                  ))
                                ) : (
                                  <div className="mcp-env-empty">No environment variables configured</div>
                                )}
                              </div>
                            )}
                          </div>

                          {/* Quick Actions */}
                          <div className="mcp-quick-actions">
                            <span className="mcp-quick-label">All Tools:</span>
                            <button
                              className={`mcp-action-btn allow ${permSummary.status === 'all-allowed' ? 'active' : ''}`}
                              onClick={(e) => updateAllPermissions(mcp.name, 'allow', e)}
                              disabled={updatingPerm === `${mcp.name}__*`}
                            >
                              Allow All
                            </button>
                            <button
                              className={`mcp-action-btn deny ${permSummary.status === 'all-denied' ? 'active' : ''}`}
                              onClick={(e) => updateAllPermissions(mcp.name, 'deny', e)}
                              disabled={updatingPerm === `${mcp.name}__*`}
                            >
                              Deny All
                            </button>
                            <button
                              className="mcp-action-btn default"
                              onClick={(e) => updateAllPermissions(mcp.name, 'default', e)}
                              disabled={updatingPerm === `${mcp.name}__*`}
                            >
                              Reset
                            </button>
                          </div>

                          {/* Tools List */}
                          {details.tools && details.tools.length > 0 && (
                            <div className="mcp-tools-section">
                              <div className="mcp-tools-header">
                                <span className="mcp-tools-title">Available Tools ({details.tools.length})</span>
                              </div>
                              <div className="mcp-tools-list">
                                {details.tools.map((tool, idx) => {
                                  const permStatus = getToolPermission(mcp.name, tool.name);
                                  const isUpdating = updatingPerm === `${mcp.name}__${tool.name}`;
                                  return (
                                    <div key={idx} className={`mcp-tool-item perm-${permStatus}`}>
                                      <div className="mcp-tool-header">
                                        <div className="mcp-tool-info">
                                          <span className="mcp-tool-name">{tool.name}</span>
                                          <span className="mcp-tool-desc">{tool.description}</span>
                                        </div>
                                        <div className="mcp-tool-actions">
                                          <button
                                            className={`mcp-perm-btn allow ${permStatus === 'allowed' ? 'active' : ''}`}
                                            onClick={(e) => updateToolPermission(mcp.name, tool.name, 'allow', e)}
                                            disabled={isUpdating}
                                            title="Allow"
                                          >✓</button>
                                          <button
                                            className={`mcp-perm-btn deny ${permStatus === 'denied' ? 'active' : ''}`}
                                            onClick={(e) => updateToolPermission(mcp.name, tool.name, 'deny', e)}
                                            disabled={isUpdating}
                                            title="Deny"
                                          >✗</button>
                                          <button
                                            className={`mcp-perm-btn default ${permStatus === 'default' ? 'active' : ''}`}
                                            onClick={(e) => updateToolPermission(mcp.name, tool.name, 'default', e)}
                                            disabled={isUpdating}
                                            title="Reset"
                                          >○</button>
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {(!details.tools || details.tools.length === 0) && (
                            <div className="mcp-no-tools">No tools configuration found for this MCP</div>
                          )}
                        </>
                      ) : (
                        <div className="mcp-details-loading">Click to load details</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
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
                  placeholder="e.g., brave-search"
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default MCPManager;
