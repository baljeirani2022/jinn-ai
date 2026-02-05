# 🧞 Jinn - WhatsApp AI Genie

Your personal AI assistant that lives in WhatsApp. Chat with Claude AI, access your files remotely, take screenshots, and control your computer from anywhere in the world.

## Features

- **AI Chat** - Talk to Claude or Qwen AI directly through WhatsApp
- **Remote File Access** - Send any file from your computer to WhatsApp
- **Screenshots** - Capture and receive screenshots of any webpage
- **MCP Integration** - Manage Model Context Protocol servers
- **Web Browser Control** - Navigate websites via Playwright
- **Notion Integration** - Access your Notion workspace
- **Task Scheduling** - Schedule cron jobs and automated tasks

## Commands

| Command | Description |
|---------|-------------|
| `/claude` | Switch to Claude AI |
| `/qwen` | Switch to Qwen AI |
| `/send <path>` | Send a file from your computer |
| `/screenshot <url>` | Capture a webpage screenshot |
| `/status` | Show current AI and settings |
| `/clear` | Clear conversation history |

## Quick Start

### Backend
```bash
cd backend
npm install
npm start
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 and scan the QR code with WhatsApp.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  WhatsApp   │────▶│   Backend   │────▶│  Claude AI  │
│   (Phone)   │◀────│  (Node.js)  │◀────│  (via CLI)  │
└─────────────┘     └─────────────┘     └─────────────┘
                           │
                    ┌──────┴──────┐
                    ▼             ▼
              ┌──────────┐  ┌──────────┐
              │ Frontend │  │   MCP    │
              │ (React)  │  │ Servers  │
              └──────────┘  └──────────┘
```

## Tech Stack

- **Backend**: Node.js, Express, Socket.io, whatsapp-web.js
- **Frontend**: React, Vite
- **AI**: Claude CLI, Qwen CLI
- **MCP Servers**: Notion, YouTube, Sharp, Playwright, Scheduler

## Use Cases

- Access your files while traveling
- Get AI help without opening a browser
- Monitor your computer remotely
- Automate tasks via scheduled jobs
- Quick web searches and screenshots

## License

MIT

---

*Named after the Jinn (genie) - a supernatural being that grants wishes. This digital Jinn lives in your WhatsApp and can do things on your computer remotely.*
