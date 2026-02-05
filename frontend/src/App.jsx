import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import QRCode from './components/QRCode';
import Terminal from './components/Terminal';

const socket = io('http://localhost:3001');

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [qrCode, setQrCode] = useState(null);
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState('');
  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    socket.on('connect', () => {
      console.log('Connected to server');
    });

    socket.on('qr', (qr) => {
      setQrCode(qr);
      setIsConnected(false);
    });

    socket.on('ready', () => {
      setIsConnected(true);
      setQrCode(null);
      socket.emit('get-messages');
    });

    socket.on('authenticated', () => {
      console.log('Authenticated');
    });

    socket.on('disconnected', () => {
      setIsConnected(false);
      setMessages([]);
    });

    socket.on('messages', (msgList) => {
      setMessages(msgList);
    });

    socket.on('message', (message) => {
      setMessages((prev) => [...prev, message]);
    });

    socket.on('message-sent', (message) => {
      setMessages((prev) => [...prev, message]);
    });

    socket.on('error', (error) => {
      console.error('Socket error:', error);
    });

    return () => {
      socket.off('connect');
      socket.off('qr');
      socket.off('ready');
      socket.off('authenticated');
      socket.off('disconnected');
      socket.off('messages');
      socket.off('message');
      socket.off('message-sent');
      socket.off('error');
    };
  }, []);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (inputMessage.trim()) {
      socket.emit('send-message', inputMessage.trim());
      setInputMessage('');
    }
  };

  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const renderMedia = (message) => {
    if (!message.media) return null;

    const { mimetype, data } = message.media;
    const dataUrl = `data:${mimetype};base64,${data}`;

    if (mimetype.startsWith('image/')) {
      return <img src={dataUrl} alt="Image" className="media-image" />;
    }

    if (mimetype.startsWith('video/')) {
      return (
        <video controls className="media-video">
          <source src={dataUrl} type={mimetype} />
        </video>
      );
    }

    if (mimetype.startsWith('audio/') || mimetype === 'audio/ogg; codecs=opus') {
      return (
        <audio controls className="media-audio">
          <source src={dataUrl} type={mimetype} />
        </audio>
      );
    }

    return <p className="media-unsupported">Media: {mimetype}</p>;
  };

  if (!isConnected) {
    return (
      <div className="app">
        <div className="app-container qr-view">
          <h1>WhatsApp Web</h1>
          <QRCode qrCode={qrCode} isConnected={isConnected} />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="split-container">
        {/* Left side - Terminal */}
        <div className="split-left">
          <Terminal socket={socket} messages={messages} />
        </div>

        {/* Right side - WhatsApp */}
        <div className="split-right">
          <div className="app-container self-chat">
            <div className="chat-header">
              <h2>Notes to Self</h2>
            </div>

            <div className="messages-container">
              {messages.length === 0 ? (
                <div className="empty-messages">
                  <p>Send a message to yourself</p>
                </div>
              ) : (
                messages.map((message) => (
                  <div
                    key={message.id}
                    className={`message ${message.fromMe ? 'sent' : 'received'}`}
                  >
                    <div className="message-content">
                      {message.hasMedia && renderMedia(message)}
                      {message.body && <p className="message-text">{message.body}</p>}
                      <span className="message-time">{formatTime(message.timestamp)}</span>
                    </div>
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            <form className="message-input-form" onSubmit={handleSubmit}>
              <input
                type="text"
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                placeholder="Type a message"
                className="message-input"
              />
              <button type="submit" className="send-button">
                Send
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
