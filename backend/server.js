import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode';
import { spawn, exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Create temp directory for media files
const mediaDir = path.join(os.tmpdir(), 'whatsapp-media');
if (!fs.existsSync(mediaDir)) {
  fs.mkdirSync(mediaDir, { recursive: true });
}

const { Client, LocalAuth } = pkg;

// Store Claude CLI processes per socket
const claudeProcesses = new Map();

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: 'http://localhost:5173',
    methods: ['GET', 'POST']
  }
});

// WhatsApp client with local authentication for session persistence
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

let isReady = false;
let myNumber = null;
let selfChatId = null;
let currentAI = 'claude'; // 'claude' or 'qwen'

// Conversation history for Claude (to maintain context)
let conversationHistory = [];
const MAX_HISTORY = 20; // Keep last 20 messages for context

// WhatsApp event handlers
client.on('qr', async (qr) => {
  console.log('QR code received');
  const qrDataUrl = await qrcode.toDataURL(qr);
  io.emit('qr', qrDataUrl);
});

client.on('authenticated', () => {
  console.log('WhatsApp authenticated');
  io.emit('authenticated');
});

client.on('ready', async () => {
  console.log('WhatsApp client ready');
  isReady = true;

  // Get my own number
  const info = client.info;
  myNumber = info.wid._serialized;
  console.log('My number:', myNumber);

  // Find the self-chat (it may have a different ID format like @lid)
  try {
    const chats = await client.getChats();
    const selfChat = chats.find(chat => chat.id.user === info.wid.user || chat.name === 'You');
    if (selfChat) {
      selfChatId = selfChat.id._serialized;
      console.log('Self chat ID:', selfChatId);
    }
  } catch (err) {
    console.log('Could not find self chat:', err.message);
  }

  io.emit('ready', { myNumber, selfChatId });
});

client.on('disconnected', (reason) => {
  console.log('WhatsApp disconnected:', reason);
  isReady = false;
  io.emit('disconnected', reason);
});

// Listen to all message events for debugging
client.on('message', (message) => {
  console.log('message event:', message.from, '->', message.to, ':', message.body?.substring(0, 30));
});

// Function to send message to AI (Claude or Qwen) and get response
async function sendToAI(prompt, provider = currentAI) {
  return new Promise((resolve, reject) => {
    console.log(`Sending to ${provider}:`, prompt);

    if (provider === 'claude') {
      // Add to conversation history
      conversationHistory.push({ role: 'user', content: prompt });

      // Build full prompt with conversation history
      let fullPrompt = '';
      if (conversationHistory.length > 1) {
        fullPrompt = 'Previous conversation:\n';
        conversationHistory.slice(0, -1).forEach(msg => {
          fullPrompt += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`;
        });
        fullPrompt += '\nCurrent message:\n' + prompt;
      } else {
        fullPrompt = prompt;
      }

      // Trim history if too long
      if (conversationHistory.length > MAX_HISTORY) {
        conversationHistory = conversationHistory.slice(-MAX_HISTORY);
      }

      // Use exec for Claude - redirect stdin from /dev/null, add media directory access
      const escapedPrompt = fullPrompt.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$').replace(/\n/g, '\\n');
      const cmd = `/Users/basim/.local/bin/claude --add-dir "${mediaDir}" -p "${escapedPrompt}" < /dev/null`;
      console.log('Claude command length:', cmd.length);

      exec(cmd, { cwd: process.env.HOME, env: process.env, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        console.log('Claude exec finished, stdout length:', stdout?.length, 'stderr length:', stderr?.length);
        let response = '';
        if (stdout && stdout.trim()) {
          response = stdout.trim();
        } else if (stderr && (stderr.includes('authorize') || stderr.includes('login'))) {
          const authUrl = stderr.match(/https:\/\/[^\s\]]+/)?.[0];
          response = `Please authorize Claude first: ${authUrl || 'Check terminal for auth URL'}`;
        } else if (stderr && stderr.trim()) {
          response = `Claude: ${stderr.trim()}`;
        } else if (error) {
          response = `Claude error: ${error.message}`;
        } else {
          response = 'No response from Claude';
        }

        // Add response to history
        conversationHistory.push({ role: 'assistant', content: response });
        resolve(response);
      });
    } else {
      // Use spawn for Qwen
      const ai = spawn('/opt/homebrew/bin/qwen', ['--auth-type', 'qwen-oauth', prompt], {
        cwd: process.env.HOME,
        env: process.env
      });

      console.log(`${provider} process spawned, PID:`, ai.pid);

      let output = '';
      let errorOutput = '';

      ai.stdout.on('data', (data) => {
        output += data.toString();
      });

      ai.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      ai.on('close', (code) => {
        console.log(`${provider} finished with code:`, code);
        if (output.trim()) {
          resolve(output.trim());
        } else if (errorOutput.includes('authorize') || errorOutput.includes('login')) {
          const authUrl = errorOutput.match(/https:\/\/[^\s\]]+/)?.[0];
          resolve(`Please authorize ${provider} first: ${authUrl || 'Check terminal for auth URL'}`);
        } else if (errorOutput.trim()) {
          resolve(`${provider}: ${errorOutput.trim()}`);
        } else {
          resolve(`No response from ${provider}`);
        }
      });

      ai.on('error', (err) => {
        reject(err);
      });
    }
  });
}

// Function to save media file and return path
function saveMediaFile(media, messageId) {
  const ext = media.mimetype.split('/')[1]?.split(';')[0] || 'bin';
  const filename = `${messageId}.${ext}`;
  const filePath = path.join(mediaDir, filename);
  fs.writeFileSync(filePath, Buffer.from(media.data, 'base64'));
  console.log('Saved media to:', filePath);
  return filePath;
}

// Function to get media type description
function getMediaTypeDescription(mimetype) {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio file';
  if (mimetype.includes('pdf')) return 'PDF document';
  if (mimetype.includes('document') || mimetype.includes('msword') || mimetype.includes('officedocument')) return 'document';
  return 'file';
}

// Function to send WhatsApp reply
async function sendWhatsAppReply(text) {
  if (!isReady || !selfChatId) {
    console.log('Cannot send reply - not ready or no selfChatId');
    return;
  }
  try {
    const chat = await client.getChatById(selfChatId);
    await chat.sendMessage(text);
    console.log('Sent reply to WhatsApp');
  } catch (err) {
    console.error('Failed to send WhatsApp reply:', err);
  }
}

client.on('message_create', async (message) => {
  console.log('message_create event:', message.from, '->', message.to, ':', message.body?.substring(0, 30), 'hasMedia:', message.hasMedia);

  // Check if it's a self-chat message (from me to @lid address = self-chat)
  const isSelfChat = message.from === myNumber && message.to?.endsWith('@lid');

  if (isSelfChat) {
    // Store the self-chat ID if we don't have it yet
    if (!selfChatId) {
      selfChatId = message.to;
      console.log('Discovered self-chat ID:', selfChatId);
    }

    const msgData = {
      id: message.id._serialized,
      body: message.body,
      timestamp: message.timestamp,
      fromMe: message.fromMe,
      type: message.type,
      hasMedia: message.hasMedia
    };

    // Download media if present
    if (message.hasMedia) {
      try {
        console.log('Downloading media...');
        const media = await message.downloadMedia();
        if (media) {
          msgData.media = {
            mimetype: media.mimetype,
            data: media.data,
            filename: media.filename
          };
          console.log('Media downloaded:', media.mimetype);
        }
      } catch (err) {
        console.error('Failed to download media:', err.message);
      }
    }

    console.log('Emitting self-message to frontend:', message.type);
    io.emit('message', msgData);

    // If it's a text message, process it
    if (message.body && message.body.trim() && !message.hasMedia) {
      const text = message.body.trim();

      // Check for commands
      if (text.toLowerCase() === '/claude') {
        currentAI = 'claude';
        await sendWhatsAppReply('Switched to Claude AI');
        io.emit('ai-switched', { provider: 'claude' });
        return;
      }
      if (text.toLowerCase() === '/qwen') {
        currentAI = 'qwen';
        await sendWhatsAppReply('Switched to Qwen AI');
        io.emit('ai-switched', { provider: 'qwen' });
        return;
      }
      if (text.toLowerCase() === '/status') {
        await sendWhatsAppReply(`Current AI: ${currentAI}\nHistory: ${conversationHistory.length} messages\nCommands: /claude, /qwen, /clear, /status`);
        return;
      }
      if (text.toLowerCase() === '/clear') {
        conversationHistory = [];
        await sendWhatsAppReply('Conversation history cleared');
        return;
      }

      // Send to AI
      console.log(`Processing message with ${currentAI}...`);
      io.emit('ai-processing', { prompt: text, provider: currentAI });

      try {
        const aiResponse = await sendToAI(text);
        console.log(`${currentAI} response:`, aiResponse.substring(0, 100));

        // Send response back to WhatsApp
        await sendWhatsAppReply(aiResponse);

        // Emit AI response as a message to frontend (so it shows in chat)
        io.emit('message', {
          id: `${currentAI}-` + Date.now(),
          body: aiResponse,
          timestamp: Math.floor(Date.now() / 1000),
          fromMe: false,  // Show as received (from AI)
          type: 'chat',
          provider: currentAI
        });

        // Also emit to terminal
        io.emit('ai-response', { response: aiResponse, provider: currentAI });
      } catch (err) {
        console.error(`${currentAI} error:`, err);
        const errorMsg = 'Error: ' + err.message;
        await sendWhatsAppReply(errorMsg);
        io.emit('message', {
          id: `${currentAI}-error-` + Date.now(),
          body: errorMsg,
          timestamp: Math.floor(Date.now() / 1000),
          fromMe: false,
          type: 'chat',
          provider: currentAI
        });
      }
    }

    // Handle media messages
    if (message.hasMedia && msgData.media) {
      try {
        // Save media to file
        const filePath = saveMediaFile(msgData.media, message.id._serialized.replace(/[^a-zA-Z0-9]/g, '_'));
        const mediaType = getMediaTypeDescription(msgData.media.mimetype);
        const caption = message.body || '';

        console.log(`Processing ${mediaType} with ${currentAI}...`);

        // Build prompt for media analysis
        let prompt;
        if (caption) {
          prompt = `The user sent a ${mediaType} with the caption: "${caption}"\n\nThe file is saved at: ${filePath}\n\nPlease read/analyze this file and respond to the user's request.`;
        } else {
          prompt = `The user sent a ${mediaType}.\n\nThe file is saved at: ${filePath}\n\nPlease analyze this file and describe what you see/find.`;
        }

        io.emit('ai-processing', { prompt: `[${mediaType}] ${caption || 'Analyzing...'}`, provider: currentAI });

        const aiResponse = await sendToAI(prompt);
        console.log(`${currentAI} media response:`, aiResponse.substring(0, 100));

        await sendWhatsAppReply(aiResponse);

        io.emit('message', {
          id: `${currentAI}-media-` + Date.now(),
          body: aiResponse,
          timestamp: Math.floor(Date.now() / 1000),
          fromMe: false,
          type: 'chat',
          provider: currentAI
        });

        io.emit('ai-response', { response: aiResponse, provider: currentAI });
      } catch (err) {
        console.error(`${currentAI} media error:`, err);
        const errorMsg = 'Error analyzing media: ' + err.message;
        await sendWhatsAppReply(errorMsg);
      }
    }
  }
});

client.on('message_ack', (message, ack) => {
  console.log('message_ack:', ack);
});

client.on('message_revoke_everyone', (message) => {
  console.log('message revoked');
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Send current status
  if (isReady) {
    socket.emit('ready', { myNumber });
  }

  // Get messages for self-chat
  socket.on('get-messages', async () => {
    if (!isReady || !myNumber) {
      socket.emit('error', 'WhatsApp not connected');
      return;
    }
    try {
      // Try selfChatId first, fallback to myNumber
      const chatId = selfChatId || myNumber;
      console.log('Fetching messages from chat:', chatId);
      const chat = await client.getChatById(chatId);
      const messages = await chat.fetchMessages({ limit: 50 });

      const messageList = await Promise.all(messages.map(async (msg) => {
        const msgData = {
          id: msg.id._serialized,
          body: msg.body,
          timestamp: msg.timestamp,
          fromMe: msg.fromMe,
          from: msg.from,
          type: msg.type,
          hasMedia: msg.hasMedia
        };

        // Download media if present
        if (msg.hasMedia) {
          try {
            const media = await msg.downloadMedia();
            if (media) {
              msgData.media = {
                mimetype: media.mimetype,
                data: media.data,
                filename: media.filename
              };
            }
          } catch (err) {
            console.error('Failed to download media for message:', err.message);
          }
        }

        return msgData;
      }));

      socket.emit('messages', messageList);
    } catch (error) {
      console.error('Error getting messages:', error);
      socket.emit('error', 'Failed to get messages');
    }
  });

  // Send a message to self
  socket.on('send-message', async (message) => {
    if (!isReady || !myNumber) {
      socket.emit('error', 'WhatsApp not connected');
      return;
    }
    try {
      const chatId = selfChatId || myNumber;
      console.log('Sending message to chat:', chatId);
      const chat = await client.getChatById(chatId);
      const sentMessage = await chat.sendMessage(message);
      socket.emit('message-sent', {
        id: sentMessage.id._serialized,
        body: sentMessage.body,
        timestamp: sentMessage.timestamp,
        fromMe: true
      });
    } catch (error) {
      console.error('Error sending message:', error);
      socket.emit('error', 'Failed to send message');
    }
  });

  // Send message to AI (uses current provider)
  socket.on('claude-message', (message) => {
    console.log(`Sending to ${currentAI}:`, message);

    try {
      if (currentAI === 'claude') {
        // Use exec for Claude - redirect stdin from /dev/null
        const escapedMsg = message.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
        const cmd = `/Users/basim/.local/bin/claude -p "${escapedMsg}" < /dev/null`;

        exec(cmd, { cwd: process.env.HOME, env: process.env, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
          console.log('Claude terminal exec finished, stdout:', stdout?.length);
          if (stdout) {
            socket.emit('claude-stream', { text: stdout, done: false });
          }
          if (stderr) {
            socket.emit('claude-stream', { text: stderr, done: false });
          }
          socket.emit('claude-stream', { text: '', done: true });
        });
      } else {
        // Use spawn for Qwen (streaming)
        const ai = spawn('/opt/homebrew/bin/qwen', ['--auth-type', 'qwen-oauth', message], {
          cwd: process.env.HOME,
          env: process.env
        });

        console.log(`${currentAI} terminal process spawned, PID:`, ai.pid);

        let outputBuffer = '';

        ai.stdout.on('data', (data) => {
          const text = data.toString();
          outputBuffer += text;
          socket.emit('claude-stream', { text, done: false });
        });

        ai.stderr.on('data', (data) => {
          const text = data.toString();
          socket.emit('claude-stream', { text: text, done: false });
        });

        ai.on('close', (code) => {
          console.log(`${currentAI} finished with code:`, code);
          socket.emit('claude-stream', { text: '', done: true });
        });

        ai.on('error', (err) => {
          socket.emit('claude-error', err.message);
        });
      }
    } catch (err) {
      console.error(`Failed to run ${currentAI}:`, err);
      socket.emit('claude-error', err.message);
    }
  });

  // MCP Management handlers
  socket.on('get-mcps', () => {
    console.log('Getting MCP list...');
    exec('/Users/basim/.local/bin/claude mcp list', { cwd: process.env.HOME, env: process.env }, (error, stdout, stderr) => {
      if (error) {
        console.error('Failed to get MCP list:', error);
        socket.emit('mcps-list', { error: error.message, mcps: [] });
        return;
      }

      // Parse the output - each line is an MCP entry
      // Format: "name: command - status" (e.g., "notion: npx -y @notionhq/notion-mcp-server - ✓ Connected")
      const lines = stdout.trim().split('\n').filter(line => line.trim());
      const mcps = [];

      for (const line of lines) {
        // Skip status lines and empty lines
        if (line.startsWith('Checking') || line.startsWith('No MCP') || !line.includes(':')) {
          continue;
        }

        // Format: "name: command - status"
        const match = line.match(/^([^:]+):\s*(.+?)\s*-\s*(✓|✗)\s*(.+)$/);
        if (match) {
          const name = match[1].trim();
          const command = match[2].trim();
          const isConnected = match[3] === '✓';
          const statusText = match[4].trim();

          mcps.push({
            name,
            command,
            status: isConnected ? 'connected' : 'error',
            statusText
          });
        } else {
          // Fallback: try simple "name: command" format
          const simpleMatch = line.match(/^([^:]+):\s*(.+)$/);
          if (simpleMatch) {
            mcps.push({
              name: simpleMatch[1].trim(),
              command: simpleMatch[2].trim(),
              status: 'configured'
            });
          }
        }
      }

      console.log('Found MCPs:', mcps);
      socket.emit('mcps-list', { mcps });
    });
  });

  socket.on('add-mcp', ({ name, command }) => {
    console.log('Adding MCP:', name, command);

    if (!name || !command) {
      socket.emit('mcp-added', { success: false, error: 'Name and command are required' });
      return;
    }

    // Escape the command for shell
    const escapedName = name.replace(/"/g, '\\"');
    const cmd = `/Users/basim/.local/bin/claude mcp add "${escapedName}" -- ${command}`;

    exec(cmd, { cwd: process.env.HOME, env: process.env }, (error, stdout, stderr) => {
      if (error) {
        console.error('Failed to add MCP:', error);
        socket.emit('mcp-added', { success: false, error: stderr || error.message });
        return;
      }

      console.log('MCP added successfully:', stdout);
      socket.emit('mcp-added', { success: true, name });
    });
  });

  socket.on('remove-mcp', ({ name }) => {
    console.log('Removing MCP:', name);

    if (!name) {
      socket.emit('mcp-removed', { success: false, error: 'Name is required' });
      return;
    }

    const escapedName = name.replace(/"/g, '\\"');
    const cmd = `/Users/basim/.local/bin/claude mcp remove "${escapedName}"`;

    exec(cmd, { cwd: process.env.HOME, env: process.env }, (error, stdout, stderr) => {
      if (error) {
        console.error('Failed to remove MCP:', error);
        socket.emit('mcp-removed', { success: false, error: stderr || error.message });
        return;
      }

      console.log('MCP removed successfully:', stdout);
      socket.emit('mcp-removed', { success: true, name });
    });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    // Kill Claude process on disconnect
    const claude = claudeProcesses.get(socket.id);
    if (claude) {
      claude.kill();
      claudeProcesses.delete(socket.id);
    }
  });
});

// Initialize WhatsApp client
client.initialize();

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
