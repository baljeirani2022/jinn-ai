import React from 'react';

function ChatList({ chats, selectedChat, onSelectChat }) {
  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const truncateMessage = (message, maxLength = 40) => {
    if (!message) return '';
    return message.length > maxLength
      ? message.substring(0, maxLength) + '...'
      : message;
  };

  return (
    <div className="chat-list">
      <div className="chat-list-header">
        <h2>Chats</h2>
      </div>
      <div className="chat-list-items">
        {chats.length === 0 ? (
          <div className="no-chats">No chats available</div>
        ) : (
          chats.map((chat) => (
            <div
              key={chat.id}
              className={`chat-item ${selectedChat?.id === chat.id ? 'selected' : ''}`}
              onClick={() => onSelectChat(chat)}
            >
              <div className="chat-avatar">
                {chat.isGroup ? '👥' : '👤'}
              </div>
              <div className="chat-info">
                <div className="chat-name-row">
                  <span className="chat-name">{chat.name}</span>
                  <span className="chat-time">{formatTime(chat.timestamp)}</span>
                </div>
                <div className="chat-last-message">
                  {truncateMessage(chat.lastMessage)}
                </div>
              </div>
              {chat.unreadCount > 0 && (
                <div className="unread-badge">{chat.unreadCount}</div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default ChatList;
