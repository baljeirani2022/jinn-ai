import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode';
import { spawn, exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    origin: ['http://localhost:5173', 'http://localhost:5174'],
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

// Scheduled file queue system
let fileQueue = [];
let queueInterval = null;
let queueStatus = {
  active: false,
  folder: null,
  intervalMs: 60000, // default 1 minute
  totalFiles: 0,
  sentFiles: 0,
  sentList: []
};

// Function to start sending files from queue
function startFileQueue(folderPath, intervalMs = 60000) {
  if (queueInterval) {
    clearInterval(queueInterval);
  }

  // Get all files from folder
  try {
    const files = fs.readdirSync(folderPath)
      .filter(f => {
        const fullPath = path.join(folderPath, f);
        return fs.statSync(fullPath).isFile();
      })
      .map(f => path.join(folderPath, f));

    if (files.length === 0) {
      return { success: false, message: 'No files found in folder' };
    }

    fileQueue = [...files];
    queueStatus = {
      active: true,
      folder: folderPath,
      intervalMs,
      totalFiles: files.length,
      sentFiles: 0,
      sentList: []
    };

    console.log(`File queue started: ${files.length} files, interval: ${intervalMs}ms`);

    // Send first file immediately
    sendNextQueuedFile();

    // Set interval for remaining files
    queueInterval = setInterval(() => {
      sendNextQueuedFile();
    }, intervalMs);

    return { success: true, message: `Queued ${files.length} files to send every ${intervalMs / 1000} seconds` };
  } catch (err) {
    return { success: false, message: `Error: ${err.message}` };
  }
}

// Function to send next file from queue
async function sendNextQueuedFile() {
  if (fileQueue.length === 0) {
    stopFileQueue();
    sendWhatsAppReply(`✅ Queue complete! Sent all ${queueStatus.totalFiles} files.`);
    return;
  }

  const filePath = fileQueue.shift();
  const fileName = path.basename(filePath);

  try {
    const sent = await sendWhatsAppMedia(filePath, `📁 [${queueStatus.sentFiles + 1}/${queueStatus.totalFiles}] ${fileName}`);
    if (sent) {
      queueStatus.sentFiles++;
      queueStatus.sentList.push(fileName);
      console.log(`Queue: Sent ${queueStatus.sentFiles}/${queueStatus.totalFiles} - ${fileName}`);
      io.emit('queue-progress', queueStatus);
    } else {
      // Put back in queue and try next
      fileQueue.unshift(filePath);
      console.log(`Queue: Failed to send ${fileName}, will retry`);
    }
  } catch (err) {
    console.error(`Queue error sending ${fileName}:`, err);
  }
}

// Function to stop file queue
function stopFileQueue() {
  if (queueInterval) {
    clearInterval(queueInterval);
    queueInterval = null;
  }
  queueStatus.active = false;
  fileQueue = [];
  console.log('File queue stopped');
}

// Function to get queue status
function getQueueStatus() {
  return {
    ...queueStatus,
    remaining: fileQueue.length,
    remainingFiles: fileQueue.map(f => path.basename(f))
  };
}

// Typing indicator management
let typingInterval = null;

async function startTyping() {
  if (!isReady || !selfChatId) return;

  try {
    const chat = await client.getChatById(selfChatId);
    // Send typing state immediately
    await chat.sendStateTyping();

    // Keep sending typing state every 5 seconds (WhatsApp typing expires after ~25s)
    typingInterval = setInterval(async () => {
      try {
        await chat.sendStateTyping();
      } catch (err) {
        // Ignore errors during typing
      }
    }, 5000);

    console.log('Started typing indicator');
  } catch (err) {
    console.error('Failed to start typing:', err.message);
  }
}

function stopTyping() {
  if (typingInterval) {
    clearInterval(typingInterval);
    typingInterval = null;
    console.log('Stopped typing indicator');
  }
}

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

      // System instructions for file sharing
      const systemInstructions = `IMPORTANT: When asked to share, attach, or send a file, you MUST output the FULL absolute file path on a separate line in this exact format:
[SEND_FILE:/full/path/to/file.ext]

For example:
[SEND_FILE:/Users/basim/Desktop/image.png]

After outputting the file path, you can add a brief description. Do NOT just describe the file - you must include the [SEND_FILE:path] tag for the file to actually be sent.

`;

      // Build full prompt with conversation history
      let fullPrompt = systemInstructions;
      if (conversationHistory.length > 1) {
        fullPrompt += 'Previous conversation:\n';
        conversationHistory.slice(0, -1).forEach(msg => {
          fullPrompt += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}\n`;
        });
        fullPrompt += '\nCurrent message:\n' + prompt;
      } else {
        fullPrompt += prompt;
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

// Function to send media (image/file) to WhatsApp
async function sendWhatsAppMedia(mediaPath, caption = '') {
  if (!isReady || !selfChatId) {
    console.log('Cannot send media - not ready or no selfChatId');
    return false;
  }
  try {
    const chat = await client.getChatById(selfChatId);
    const media = pkg.MessageMedia.fromFilePath(mediaPath);
    await chat.sendMessage(media, { caption });
    console.log('Sent media to WhatsApp:', mediaPath);
    return true;
  } catch (err) {
    console.error('Failed to send WhatsApp media:', err);
    return false;
  }
}

// Function to send base64 image to WhatsApp
async function sendWhatsAppBase64Image(base64Data, mimetype = 'image/png', caption = '') {
  if (!isReady || !selfChatId) {
    console.log('Cannot send image - not ready or no selfChatId');
    return false;
  }
  try {
    const chat = await client.getChatById(selfChatId);
    // Remove data URL prefix if present
    const base64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const media = new pkg.MessageMedia(mimetype, base64);
    await chat.sendMessage(media, { caption });
    console.log('Sent base64 image to WhatsApp');
    return true;
  } catch (err) {
    console.error('Failed to send WhatsApp image:', err);
    return false;
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

      // Queue files command: /queue <folder> [interval_seconds]
      if (text.toLowerCase().startsWith('/queue ')) {
        const match = text.match(/\/queue\s+(.+?)(?:\s+(\d+))?$/i);
        if (!match) {
          await sendWhatsAppReply('Usage: /queue <folder_path> [interval_seconds]\nExample: /queue /Users/basim/Movies/CapCut/Theodora 60');
          return;
        }

        const folderPath = match[1].trim();
        const intervalSec = parseInt(match[2]) || 60; // default 60 seconds

        if (!fs.existsSync(folderPath)) {
          await sendWhatsAppReply(`❌ Folder not found: ${folderPath}`);
          return;
        }

        if (!fs.statSync(folderPath).isDirectory()) {
          await sendWhatsAppReply(`❌ Not a directory: ${folderPath}`);
          return;
        }

        const result = startFileQueue(folderPath, intervalSec * 1000);
        await sendWhatsAppReply(result.success
          ? `✅ ${result.message}\n\nUse /queue-status to check progress\nUse /queue-stop to cancel`
          : `❌ ${result.message}`);
        return;
      }

      // Queue status command
      if (text.toLowerCase() === '/queue-status') {
        const status = getQueueStatus();
        if (!status.active && status.totalFiles === 0) {
          await sendWhatsAppReply('📭 No active queue. Use /queue <folder> to start.');
          return;
        }

        const statusMsg = status.active
          ? `📤 Queue Active\n\n` +
            `📁 Folder: ${status.folder}\n` +
            `⏱️ Interval: ${status.intervalMs / 1000}s\n` +
            `✅ Sent: ${status.sentFiles}/${status.totalFiles}\n` +
            `⏳ Remaining: ${status.remaining}\n\n` +
            `Recent: ${status.sentList.slice(-3).join(', ')}`
          : `📭 Queue finished. Sent ${status.sentFiles} files.`;

        await sendWhatsAppReply(statusMsg);
        return;
      }

      // Queue stop command
      if (text.toLowerCase() === '/queue-stop') {
        if (!queueStatus.active) {
          await sendWhatsAppReply('📭 No active queue to stop.');
          return;
        }

        const sent = queueStatus.sentFiles;
        const total = queueStatus.totalFiles;
        stopFileQueue();
        await sendWhatsAppReply(`🛑 Queue stopped.\n\nSent ${sent}/${total} files before stopping.`);
        return;
      }

      // Send file command: /send <filepath>
      if (text.toLowerCase().startsWith('/send')) {
        const pathMatch = text.match(/\/send\s+(.+)/i);
        if (!pathMatch) {
          await sendWhatsAppReply('Usage: /send <filepath>\nExample: /send /Users/basim/Desktop/image.png');
          return;
        }

        const filePath = pathMatch[1].trim();

        if (!fs.existsSync(filePath)) {
          await sendWhatsAppReply(`File not found: ${filePath}`);
          return;
        }

        await sendWhatsAppReply(`Sending file: ${path.basename(filePath)}...`);

        try {
          const sent = await sendWhatsAppMedia(filePath, path.basename(filePath));
          if (sent) {
            io.emit('message', {
              id: 'file-' + Date.now(),
              body: `File sent: ${path.basename(filePath)}`,
              timestamp: Math.floor(Date.now() / 1000),
              fromMe: false,
              type: 'chat',
              provider: 'file'
            });
          } else {
            await sendWhatsAppReply('Failed to send file');
          }
        } catch (err) {
          console.error('Send file error:', err);
          await sendWhatsAppReply(`Failed to send file: ${err.message}`);
        }
        return;
      }

      // Screenshot command: /screenshot <url>
      if (text.toLowerCase().startsWith('/screenshot')) {
        const urlMatch = text.match(/\/screenshot\s+(\S+)/i);
        if (!urlMatch) {
          await sendWhatsAppReply('Usage: /screenshot <url>\nExample: /screenshot https://google.com');
          return;
        }

        let url = urlMatch[1];
        // Add https if no protocol
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          url = 'https://' + url;
        }

        await sendWhatsAppReply(`Taking screenshot of ${url}...`);
        io.emit('ai-processing', { prompt: `Screenshot: ${url}`, provider: 'screenshot' });

        try {
          // Use puppeteer to take screenshot
          const puppeteer = await import('puppeteer');
          const browser = await puppeteer.default.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
          });
          const page = await browser.newPage();
          await page.setViewport({ width: 1280, height: 800 });
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

          // Save screenshot
          const screenshotPath = path.join(mediaDir, `screenshot-${Date.now()}.png`);
          await page.screenshot({ path: screenshotPath, fullPage: false });
          await browser.close();

          console.log('Screenshot saved to:', screenshotPath);

          // Send to WhatsApp
          const sent = await sendWhatsAppMedia(screenshotPath, `Screenshot of ${url}`);
          if (sent) {
            io.emit('message', {
              id: 'screenshot-' + Date.now(),
              body: `Screenshot of ${url} sent!`,
              timestamp: Math.floor(Date.now() / 1000),
              fromMe: false,
              type: 'chat',
              provider: 'screenshot'
            });
          } else {
            await sendWhatsAppReply('Failed to send screenshot');
          }
        } catch (err) {
          console.error('Screenshot error:', err);
          await sendWhatsAppReply(`Screenshot failed: ${err.message}`);
        }
        return;
      }

      // Send to AI
      console.log(`Processing message with ${currentAI}...`);
      io.emit('ai-processing', { prompt: text, provider: currentAI });

      // Start typing indicator while AI is thinking
      await startTyping();

      try {
        const aiResponse = await sendToAI(text);

        // Stop typing before sending response
        stopTyping();

        console.log(`${currentAI} response:`, aiResponse.substring(0, 100));

        // Check for [SEND_FILE:path] tag in response
        const sendFileMatch = aiResponse.match(/\[SEND_FILE:([^\]]+)\]/);

        // Also check for legacy image path patterns
        const imagePathMatch = aiResponse.match(/(?:saved|screenshot|image|file).*?[:\s]+(\/[\/\w\-\.\s]+\.(?:png|jpg|jpeg|gif|webp))/i) ||
                              aiResponse.match(/(\/Users\/[\/\w\-\.\s]+\.(?:png|jpg|jpeg|gif|webp|pdf|csv|txt|doc|docx))/i);

        let fileSent = false;
        let cleanResponse = aiResponse;

        if (sendFileMatch && sendFileMatch[1]) {
          let filePath = sendFileMatch[1].trim();
          console.log('Found SEND_FILE tag with path:', filePath);

          // Remove the tag from the response text (also remove surrounding newlines/spaces)
          cleanResponse = aiResponse.replace(/\s*\[SEND_FILE:[^\]]+\]\s*/g, ' ').trim();
          console.log('Clean response (tag removed):', cleanResponse.substring(0, 100));

          // Handle macOS screenshot filenames with narrow no-break space (U+202F)
          // macOS uses narrow no-break space before AM/PM, but Claude outputs regular space
          if (!fs.existsSync(filePath)) {
            // Try replacing regular space with narrow no-break space before AM/PM
            const fixedPath = filePath.replace(/ (AM|PM)\./g, '\u202f$1.');
            if (fs.existsSync(fixedPath)) {
              console.log('Fixed path with narrow no-break space:', fixedPath);
              filePath = fixedPath;
            }
          }

          if (fs.existsSync(filePath)) {
            console.log('Sending file to WhatsApp:', filePath);
            const sent = await sendWhatsAppMedia(filePath, cleanResponse.substring(0, 200));
            if (sent) {
              console.log('File sent successfully');
              fileSent = true;
            }
          } else {
            console.log('File not found:', filePath);
            cleanResponse = `File not found: ${filePath}\n\n${cleanResponse}`;
          }
        } else if (imagePathMatch && imagePathMatch[1]) {
          const imagePath = imagePathMatch[1].trim();
          console.log('Found image path in response:', imagePath);

          if (fs.existsSync(imagePath)) {
            console.log('Sending image to WhatsApp:', imagePath);
            const sent = await sendWhatsAppMedia(imagePath, aiResponse.substring(0, 200));
            if (sent) {
              console.log('Image sent successfully');
              fileSent = true;
            }
          }
        }

        // Send text response (always, unless file was sent with caption)
        if (!fileSent) {
          await sendWhatsAppReply(cleanResponse || aiResponse);
        }

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
        stopTyping(); // Stop typing on error
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

        // Start typing while processing media
        await startTyping();

        const aiResponse = await sendToAI(prompt);

        // Stop typing before sending response
        stopTyping();

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
        stopTyping(); // Stop typing on error
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
    exec('/Users/basim/.local/bin/claude mcp list', { cwd: __dirname, env: process.env }, (error, stdout, stderr) => {
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

  // Get MCP details including tools
  socket.on('get-mcp-details', ({ name }) => {
    console.log('Getting MCP details for:', name);

    if (!name) {
      socket.emit('mcp-details', { error: 'Name is required' });
      return;
    }

    const escapedName = name.replace(/"/g, '\\"');

    // Get basic details from claude mcp get
    exec(`/Users/basim/.local/bin/claude mcp get "${escapedName}"`, { cwd: __dirname, env: process.env }, (error, stdout, stderr) => {
      if (error) {
        console.error('Failed to get MCP details:', error);
        socket.emit('mcp-details', { name, error: error.message });
        return;
      }

      // Parse the output
      const details = { name, raw: stdout };

      // Parse scope
      const scopeMatch = stdout.match(/Scope:\s*(.+)/);
      if (scopeMatch) details.scope = scopeMatch[1].trim();

      // Parse status
      const statusMatch = stdout.match(/Status:\s*(✓|✗)\s*(.+)/);
      if (statusMatch) {
        details.connected = statusMatch[1] === '✓';
        details.statusText = statusMatch[2].trim();
      }

      // Parse type
      const typeMatch = stdout.match(/Type:\s*(.+)/);
      if (typeMatch) details.type = typeMatch[1].trim();

      // Parse command
      const commandMatch = stdout.match(/Command:\s*(.+)/);
      if (commandMatch) details.command = commandMatch[1].trim();

      // Parse args
      const argsMatch = stdout.match(/Args:\s*(.+)/);
      if (argsMatch) details.args = argsMatch[1].trim();

      // Parse environment variables
      const envSection = stdout.match(/Environment:\s*([\s\S]*?)(?:\n\nTo remove|$)/);
      if (envSection) {
        const envText = envSection[1].trim();
        const envVars = {};
        if (envText) {
          // Parse each line as KEY=VALUE or KEY: VALUE
          envText.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (trimmed) {
              const eqMatch = trimmed.match(/^(\w+)[=:]\s*(.*)$/);
              if (eqMatch) {
                envVars[eqMatch[1]] = eqMatch[2];
              }
            }
          });
        }
        details.env = envVars;
      } else {
        details.env = {};
      }

      // Load tools from config file if available
      const toolsConfigPath = path.join(process.cwd(), 'mcp-tools.json');
      try {
        if (fs.existsSync(toolsConfigPath)) {
          const toolsConfig = JSON.parse(fs.readFileSync(toolsConfigPath, 'utf8'));
          if (toolsConfig[name]) {
            details.tools = toolsConfig[name];
          }
        }
      } catch (e) {
        console.error('Error loading tools config:', e);
      }

      console.log('MCP details:', details);
      socket.emit('mcp-details', details);
    });
  });

  // Update MCP configuration (env vars, etc.)
  socket.on('update-mcp-config', ({ name, env, command, args }) => {
    console.log('Updating MCP config for:', name, 'with command:', command);

    if (!name) {
      socket.emit('mcp-config-updated', { success: false, error: 'Name is required' });
      return;
    }

    const escapedName = name.replace(/"/g, '\\"');

    // Helper function to add MCP with env vars
    const addMcpWithEnv = (mcpCommand, mcpArgs, scope) => {
      // Build the add command with env vars
      // Format: claude mcp add -e KEY=value -s scope name -- command args
      let addCmd = `/Users/basim/.local/bin/claude mcp add`;

      // Add environment variables first
      if (env && typeof env === 'object') {
        Object.entries(env).forEach(([key, value]) => {
          if (key && value !== undefined && value !== '') {
            // Use double quotes and escape special characters for shell
            const escapedValue = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
            addCmd += ` -e ${key}="${escapedValue}"`;
          }
        });
      }

      // Add scope
      addCmd += ` -s ${scope}`;

      // Add the name (unquoted) and command
      addCmd += ` ${escapedName} -- ${mcpCommand}`;

      // Add args if present
      if (mcpArgs) {
        addCmd += ` ${mcpArgs}`;
      }

      console.log('Running add command:', addCmd);

      exec(addCmd, { cwd: __dirname, env: process.env }, (addError, addStdout, addStderr) => {
        if (addError) {
          console.error('Failed to add MCP:', addError, addStderr);
          socket.emit('mcp-config-updated', { success: false, error: addStderr || addError.message });
          return;
        }

        console.log('MCP config updated successfully');
        socket.emit('mcp-config-updated', { success: true, name });
      });
    };

    // First, try to get the current config
    exec(`/Users/basim/.local/bin/claude mcp get "${escapedName}"`, { cwd: __dirname, env: process.env }, (error, stdout, stderr) => {
      let currentCommand = '';
      let currentArgs = '';
      let scope = 'local';

      if (!error && stdout) {
        // Parse current config
        const commandMatch = stdout.match(/Command:\s*(.+)/);
        currentCommand = commandMatch ? commandMatch[1].trim() : '';

        const argsMatch = stdout.match(/Args:\s*(.+)/);
        currentArgs = argsMatch ? argsMatch[1].trim() : '';

        // Parse scope
        const scopeMatch = stdout.match(/Scope:\s*(.+)/);
        if (scopeMatch) {
          if (scopeMatch[1].includes('User')) scope = 'user';
          else if (scopeMatch[1].includes('Project')) scope = 'project';
        }
      }

      // Determine command and args
      // If frontend provides a full command string, use it directly (don't append args)
      // If using parsed command from mcp get, also use parsed args
      let finalCommand = '';
      let finalArgs = '';

      if (command) {
        // Frontend provided full command - use it as-is, no separate args
        finalCommand = command;
        finalArgs = '';
      } else if (currentCommand) {
        // Use parsed command and args
        finalCommand = currentCommand;
        finalArgs = currentArgs;
      }

      if (!finalCommand) {
        socket.emit('mcp-config-updated', { success: false, error: 'No command available for this MCP' });
        return;
      }

      // Remove the existing MCP first (ignore errors if it doesn't exist)
      exec(`/Users/basim/.local/bin/claude mcp remove "${escapedName}" -s ${scope}`, { cwd: __dirname, env: process.env }, (removeError) => {
        if (removeError) {
          console.log('MCP remove skipped (may not exist):', removeError.message);
        }

        addMcpWithEnv(finalCommand, finalArgs, scope);
      });
    });
  });

  // Save MCP tools configuration
  socket.on('save-mcp-tools', ({ name, tools }) => {
    console.log('Saving MCP tools for:', name);

    const toolsConfigPath = path.join(process.cwd(), 'mcp-tools.json');
    let toolsConfig = {};

    try {
      if (fs.existsSync(toolsConfigPath)) {
        toolsConfig = JSON.parse(fs.readFileSync(toolsConfigPath, 'utf8'));
      }

      toolsConfig[name] = tools;
      fs.writeFileSync(toolsConfigPath, JSON.stringify(toolsConfig, null, 2));

      socket.emit('mcp-tools-saved', { success: true, name });
    } catch (e) {
      console.error('Error saving tools config:', e);
      socket.emit('mcp-tools-saved', { success: false, error: e.message });
    }
  });

  // Helper function to get and emit MCP permissions
  const emitMcpPermissions = () => {
    const permissionsPath = path.join(process.env.HOME, '.claude', 'settings.local.json');

    try {
      if (fs.existsSync(permissionsPath)) {
        const settings = JSON.parse(fs.readFileSync(permissionsPath, 'utf8'));
        const permissions = settings.permissions || { allow: [], deny: [], ask: [] };

        // Parse permissions to extract MCP-specific ones
        const mcpPermissions = {
          allow: [],
          deny: [],
          ask: []
        };

        // Process each permission type
        ['allow', 'deny', 'ask'].forEach(type => {
          (permissions[type] || []).forEach(perm => {
            if (perm.startsWith('mcp__')) {
              // Extract MCP name and tool
              const match = perm.match(/^mcp__([^_]+)__(.+)$/);
              if (match) {
                mcpPermissions[type].push({
                  mcp: match[1],
                  tool: match[2],
                  raw: perm
                });
              }
            }
          });
        });

        socket.emit('mcp-permissions', { permissions: mcpPermissions });
      } else {
        socket.emit('mcp-permissions', { permissions: { allow: [], deny: [], ask: [] } });
      }
    } catch (e) {
      console.error('Error reading permissions:', e);
      socket.emit('mcp-permissions', { error: e.message });
    }
  };

  // Get MCP permissions
  socket.on('get-mcp-permissions', () => {
    console.log('Getting MCP permissions...');
    emitMcpPermissions();
  });

  // Update MCP tool permission
  socket.on('update-mcp-permission', ({ mcp, tool, action }) => {
    console.log('Updating MCP permission:', mcp, tool, action);

    const permissionsPath = path.join(process.env.HOME, '.claude', 'settings.local.json');
    const permString = `mcp__${mcp}__${tool}`;

    try {
      let settings = {};
      if (fs.existsSync(permissionsPath)) {
        settings = JSON.parse(fs.readFileSync(permissionsPath, 'utf8'));
      }

      if (!settings.permissions) {
        settings.permissions = { allow: [], deny: [], ask: [] };
      }

      // Remove from all lists first
      ['allow', 'deny', 'ask'].forEach(type => {
        if (!settings.permissions[type]) settings.permissions[type] = [];
        settings.permissions[type] = settings.permissions[type].filter(p => p !== permString);
      });

      // Add to the appropriate list based on action
      if (action === 'allow') {
        settings.permissions.allow.push(permString);
      } else if (action === 'deny') {
        settings.permissions.deny.push(permString);
      }
      // If action is 'default', we just remove it from all lists (already done above)

      // Write back to file
      fs.writeFileSync(permissionsPath, JSON.stringify(settings, null, 2));

      console.log('Permission updated successfully');
      socket.emit('mcp-permission-updated', { success: true, mcp, tool, action });

      // Send updated permissions
      emitMcpPermissions();
    } catch (e) {
      console.error('Error updating permission:', e);
      socket.emit('mcp-permission-updated', { success: false, error: e.message });
    }
  });

  // Update all tools for an MCP (wildcard)
  socket.on('update-mcp-all-permissions', ({ mcp, action }) => {
    console.log('Updating all MCP permissions:', mcp, action);

    const permissionsPath = path.join(process.env.HOME, '.claude', 'settings.local.json');
    const wildcardPerm = `mcp__${mcp}__*`;

    try {
      let settings = {};
      if (fs.existsSync(permissionsPath)) {
        settings = JSON.parse(fs.readFileSync(permissionsPath, 'utf8'));
      }

      if (!settings.permissions) {
        settings.permissions = { allow: [], deny: [], ask: [] };
      }

      // Remove wildcard from all lists first
      ['allow', 'deny', 'ask'].forEach(type => {
        if (!settings.permissions[type]) settings.permissions[type] = [];
        settings.permissions[type] = settings.permissions[type].filter(p => p !== wildcardPerm);
      });

      // Add wildcard to the appropriate list
      if (action === 'allow') {
        settings.permissions.allow.push(wildcardPerm);
      } else if (action === 'deny') {
        settings.permissions.deny.push(wildcardPerm);
      }

      // Write back to file
      fs.writeFileSync(permissionsPath, JSON.stringify(settings, null, 2));

      console.log('All permissions updated successfully');
      socket.emit('mcp-permission-updated', { success: true, mcp, tool: '*', action });

      // Send updated permissions
      emitMcpPermissions();
    } catch (e) {
      console.error('Error updating permissions:', e);
      socket.emit('mcp-permission-updated', { success: false, error: e.message });
    }
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

  // Send image to WhatsApp (from file path)
  socket.on('send-image', async ({ filePath, caption }) => {
    console.log('Sending image to WhatsApp:', filePath);
    const success = await sendWhatsAppMedia(filePath, caption || '');
    socket.emit('image-sent', { success, filePath });
  });

  // Send base64 image to WhatsApp
  socket.on('send-base64-image', async ({ base64, mimetype, caption }) => {
    console.log('Sending base64 image to WhatsApp');
    const success = await sendWhatsAppBase64Image(base64, mimetype || 'image/png', caption || '');
    socket.emit('image-sent', { success });
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
