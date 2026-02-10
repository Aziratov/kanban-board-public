# Jarvis Command Center - Kanban Board

## Overview
A local web-based Kanban board for task management and real-time agent monitoring. Mo assigns work in batches, Jarvis and sub-agents execute.

## Core Features

### 1. Task Board (Kanban)
- **Columns**: Inbox → Queued → In Progress → Review → Done
- **Task Cards**: Title, description, priority, assigned model, estimated cost
- **Batch Assignment**: Mo drops tasks in Inbox, Jarvis picks them up
- **Sub-agent Routing**: Auto-assign to appropriate model based on task type

### 2. Agent Status Dashboard
| Emoji | Status | Description |
|-------|--------|-------------|
| 💤 | Idle | No active tasks |
| 🤔 | Thinking | Processing/reasoning |
| ⚙️ | Working | Executing task |
| 🔒 | Security | Security scan/audit |
| 📡 | Fetching | API calls/web requests |
| 💬 | Chatting | In conversation |
| ⏳ | Queued | Task waiting |
| ✅ | Complete | Task finished |
| ❌ | Error | Task failed |

### 3. Model Router
Automatic task routing based on complexity:
- **claude-haiku-4.5**: Quick tasks, simple queries, formatting
- **gpt-4o**: General tasks, moderate complexity
- **claude-sonnet-4.5**: Code review, writing, analysis
- **gpt-5.2-codex**: Heavy coding tasks
- **claude-opus-4.5**: Complex reasoning, orchestration (Jarvis main)

### 4. Activity Feed
Real-time log of all agent activity:
- Task starts/completions
- Sub-agent spawns
- Errors and retries
- Token usage per task

### 5. Metrics Panel
- Tasks completed today/week
- Token usage by model
- Quota remaining
- Average task time

## Tech Stack
- **Frontend**: Vanilla JS + CSS (no build step, instant load)
- **Backend**: Static files served by Python http.server or Node
- **Data**: JSON files in workspace (tasks.json, activity.json)
- **Updates**: Polling or WebSocket for real-time

## File Structure
```
/home/jarvis/.openclaw/workspace/projects/kanban/
├── SPEC.md           # This file
├── index.html        # Main dashboard
├── style.css         # Styling
├── app.js            # Frontend logic
├── data/
│   ├── tasks.json    # Task board state
│   ├── activity.json # Activity log
│   └── agents.json   # Agent status
└── server.py         # Simple HTTP server with API
```

## API Endpoints (server.py)
- GET /api/tasks - Get all tasks
- POST /api/tasks - Create task
- PATCH /api/tasks/:id - Update task
- DELETE /api/tasks/:id - Delete task
- GET /api/activity - Get activity feed
- GET /api/agents - Get agent statuses
- POST /api/agents/:id/status - Update agent status

## Access
- Local: http://192.168.50.39:8080
- Server only (no external exposure)

## Integration with Jarvis
1. Heartbeat checks Inbox for new tasks
2. Routes to appropriate model/sub-agent
3. Updates status in real-time
4. Logs all activity
5. Mo gets visibility without texting

---
*"Your personal mission control, sir."*
