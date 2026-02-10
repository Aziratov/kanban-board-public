#!/usr/bin/env python3
"""
Jarvis Command Center - Backend Server v2
WebSocket support for real-time updates
"""

import asyncio
import json
import os
import sqlite3
import uuid
from datetime import datetime, timedelta
from aiohttp import web
import aiohttp

PORT = 8080
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
STATIC_DIR = os.path.dirname(os.path.abspath(__file__))
MEMORY_DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'memory.db')

os.makedirs(DATA_DIR, exist_ok=True)

TASKS_FILE = os.path.join(DATA_DIR, 'tasks.json')
AGENTS_FILE = os.path.join(DATA_DIR, 'agents.json')
ACTIVITY_FILE = os.path.join(DATA_DIR, 'activity.json')
NOTES_FILE = os.path.join(DATA_DIR, 'notes.json')
SCHEDULED_FILE = os.path.join(DATA_DIR, 'scheduled.json')
METRICS_FILE = os.path.join(DATA_DIR, 'metrics.json')
MOOD_FILE = os.path.join(DATA_DIR, 'mood.json')

# In-memory feed storage
feed_entries = []

# Connected WebSocket clients
ws_clients = set()

def load_json(filepath, default):
    try:
        with open(filepath, 'r') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default

def save_json(filepath, data):
    with open(filepath, 'w') as f:
        json.dump(data, f, indent=2)

def get_tasks():
    return load_json(TASKS_FILE, [])

def save_tasks(tasks):
    save_json(TASKS_FILE, tasks)

def get_agents():
    agents = load_json(AGENTS_FILE, None)
    if agents is None:
        agents = [
            {
                "id": "claude-opus",
                "name": "Jarvis (Opus 4.6)",
                "model": "claude-opus-4-6",
                "role": "manager",
                "status": "Idle",
                "statusEmoji": "",
                "currentTask": None
            }
        ]
        save_json(AGENTS_FILE, agents)
    return agents

def save_agents(agents):
    save_json(AGENTS_FILE, agents)

def get_metrics():
    return load_json(METRICS_FILE, {
        "token_usage": {
            "premium_remaining": None,
            "chat_remaining": None,
            "last_updated": None
        }
    })

def save_metrics(metrics):
    save_json(METRICS_FILE, metrics)

def get_activity():
    data = load_json(ACTIVITY_FILE, [])
    # Ensure we always return a list
    if isinstance(data, list):
        return data
    # If it's an object (single activity entry), convert to list
    if isinstance(data, dict):
        return [data]
    # Default to empty list
    return []

def add_activity(message):
    activity = get_activity()
    entry = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "message": message
    }
    activity.append(entry)
    activity = activity[-500:]
    save_json(ACTIVITY_FILE, activity)
    # Broadcast to WebSocket clients
    asyncio.create_task(broadcast({"type": "activity", "data": entry}))
    return activity

async def broadcast(message):
    """Send message to all connected WebSocket clients"""
    if ws_clients:
        msg = json.dumps(message)
        await asyncio.gather(
            *[ws.send_str(msg) for ws in ws_clients if not ws.closed],
            return_exceptions=True
        )

async def trigger_agent(task_id):
    """Fire-and-forget: notify the bot to trigger an agent for this task"""
    try:
        timeout = aiohttp.ClientTimeout(total=5)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            await session.post(
                'http://127.0.0.1:3001/trigger-agent',
                json={'taskId': task_id}
            )
    except Exception as e:
        print(f"Agent trigger failed (will use polling fallback): {e}")

# WebSocket handler
async def websocket_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    ws_clients.add(ws)
    
    try:
        # Send initial state
        await ws.send_json({
            "type": "init",
            "data": {
                "tasks": get_tasks(),
                "agents": get_agents(),
                "activity": get_activity()[-50:]
            }
        })
        
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                data = json.loads(msg.data)
                # Handle WebSocket commands if needed
                if data.get('type') == 'ping':
                    await ws.send_json({"type": "pong"})
            elif msg.type == aiohttp.WSMsgType.ERROR:
                break
    finally:
        ws_clients.discard(ws)
    
    return ws

# REST API handlers
async def get_tasks_handler(request):
    tasks = get_tasks()
    active = request.query.get('active', '').lower()
    if active == 'true':
        tasks = [t for t in tasks if t.get('status') in ('todo', 'in-progress')]
    return web.json_response(tasks)

async def create_task_handler(request):
    body = await request.json()
    tasks = get_tasks()
    now = datetime.utcnow().isoformat() + "Z"
    status = body.get('status', 'todo')
    
    task = {
        "id": str(uuid.uuid4())[:8],
        "createdAt": now,
        "startedAt": now if status == 'in-progress' else None,
        "completedAt": now if status in ['done', 'archive'] else None,
        **body
    }
    tasks.append(task)
    save_tasks(tasks)
    add_activity(f"📥 New task: {task.get('title', 'Untitled')}")
    await broadcast({"type": "task_created", "data": task})
    # Trigger agent immediately if assigned
    assigned_to = task.get('assignedTo', '')
    if assigned_to and assigned_to.startswith('Agent:'):
        asyncio.create_task(trigger_agent(task['id']))
    return web.json_response(task, status=201)

async def update_task_handler(request):
    task_id = request.match_info['id']
    body = await request.json()
    tasks = get_tasks()
    now = datetime.utcnow().isoformat() + "Z"
    
    for task in tasks:
        if task['id'] == task_id:
            old_status = task.get('status')
            new_status = body.get('status')
            
            # Track timestamps
            if new_status and new_status != old_status:
                if new_status == 'in-progress' and not task.get('startedAt'):
                    body['startedAt'] = now
                elif new_status in ['done', 'archive'] and not task.get('completedAt'):
                    body['completedAt'] = now
                
                if new_status == 'done' and 'completedBy' in body:
                    task['completedBy'] = body['completedBy']
                
                add_activity(f"📋 Task moved to {new_status}: {task.get('title', 'Untitled')}")
            
            task.update(body)
            break
    
    save_tasks(tasks)
    await broadcast({"type": "task_updated", "data": {"id": task_id, **body}})
    return web.json_response({"ok": True})

async def delete_task_handler(request):
    task_id = request.match_info['id']
    tasks = get_tasks()
    task = next((t for t in tasks if t['id'] == task_id), None)
    tasks = [t for t in tasks if t['id'] != task_id]
    save_tasks(tasks)
    
    if task:
        add_activity(f"🗑️ Task deleted: {task.get('title', 'Untitled')}")
    
    await broadcast({"type": "task_deleted", "data": {"id": task_id}})
    return web.json_response({"ok": True})

async def get_agents_handler(request):
    return web.json_response(get_agents())

async def update_agent_handler(request):
    agent_id = request.match_info['id']
    body = await request.json()
    agents = get_agents()

    working_statuses = ['Working', 'Thinking', 'Checking', 'Typing', 'Delegating', 'Heartbeat', 'Managing']
    new_status = body.get('status')

    found = False
    for agent in agents:
        if agent['id'] == agent_id:
            old_status = agent.get('status', 'Idle')
            agent.update(body)
            # Track when agent started working for elapsed timer persistence
            if new_status and new_status in working_statuses:
                if old_status not in working_statuses or not agent.get('startedWorkingAt'):
                    agent['startedWorkingAt'] = datetime.utcnow().isoformat() + 'Z'
            elif new_status and new_status in ['Idle', 'Standby']:
                agent['startedWorkingAt'] = None
            found = True
            break

    # If agent doesn't exist, create it (for sub-agents)
    if not found:
        new_agent = {"id": agent_id, **body}
        if new_status and new_status in working_statuses:
            new_agent['startedWorkingAt'] = datetime.utcnow().isoformat() + 'Z'
        agents.append(new_agent)

    # Include startedWorkingAt in broadcast
    agent_data = {"id": agent_id, **body}
    target = next((a for a in agents if a['id'] == agent_id), None)
    if target:
        agent_data['startedWorkingAt'] = target.get('startedWorkingAt')

    save_agents(agents)
    await broadcast({"type": "agent_updated", "data": agent_data})
    return web.json_response({"ok": True})

async def remove_agent_handler(request):
    agent_id = request.match_info['id']
    agents = get_agents()
    agents = [a for a in agents if a['id'] != agent_id]
    save_agents(agents)
    await broadcast({"type": "agent_removed", "data": {"id": agent_id}})
    return web.json_response({"ok": True})

async def get_activity_handler(request):
    since = int(request.query.get('since', 0))
    activity = get_activity()
    # Ensure activity is always a list before slicing
    if isinstance(activity, list):
        activity_slice = activity[since:]
    else:
        activity_slice = []
    return web.json_response(activity_slice)

async def add_activity_handler(request):
    body = await request.json()
    add_activity(body.get('message', ''))
    return web.json_response({"ok": True})

# Granular status updates endpoint
async def status_update_handler(request):
    """Accept quick status messages and broadcast via WebSocket"""
    body = await request.json()
    status_entry = {
        "type": "status",
        "agent": body.get('agent', 'unknown'),
        "status": body.get('status', 'idle'),
        "detail": body.get('detail', ''),
        "timestamp": datetime.utcnow().isoformat() + "Z"
    }
    
    # Broadcast to WebSocket clients immediately
    await broadcast({"type": "status_update", "data": status_entry})
    return web.json_response({"ok": True})

# Notes API
def get_notes():
    return load_json(NOTES_FILE, [])

def save_notes(notes):
    save_json(NOTES_FILE, notes)

async def get_notes_handler(request):
    return web.json_response(get_notes())

async def add_note_handler(request):
    body = await request.json()
    notes = get_notes()
    note = {
        "id": str(uuid.uuid4())[:8],
        "content": body.get('content', ''),
        "createdAt": datetime.utcnow().isoformat() + "Z",
        "read": False
    }
    notes.append(note)
    save_notes(notes)
    add_activity(f"📝 Note added: {note['content'][:50]}...")
    await broadcast({"type": "note_added", "data": note})
    return web.json_response(note, status=201)

async def mark_note_read_handler(request):
    note_id = request.match_info['id']
    notes = get_notes()
    now = datetime.utcnow().isoformat() + "Z"
    for note in notes:
        if note['id'] == note_id:
            note['read'] = True
            note['readAt'] = now
            break
    save_notes(notes)
    await broadcast({"type": "note_updated", "data": {"id": note_id, "read": True, "readAt": now}})
    return web.json_response({"ok": True})

async def delete_note_handler(request):
    note_id = request.match_info['id']
    notes = get_notes()
    notes = [n for n in notes if n['id'] != note_id]
    save_notes(notes)
    await broadcast({"type": "note_deleted", "data": {"id": note_id}})
    return web.json_response({"ok": True})

# Scheduled Deliverables API
def get_scheduled():
    return load_json(SCHEDULED_FILE, [])

def save_scheduled(items):
    save_json(SCHEDULED_FILE, items)

async def get_scheduled_handler(request):
    return web.json_response(get_scheduled())

async def add_scheduled_handler(request):
    body = await request.json()
    items = get_scheduled()
    item = {
        "id": str(uuid.uuid4())[:8],
        "name": body.get('name', ''),
        "schedule": body.get('schedule', 'daily'),
        "icon": body.get('icon', '📋'),
        "enabled": body.get('enabled', True),
        "lastRun": None,
        "createdAt": datetime.utcnow().isoformat() + "Z"
    }
    items.append(item)
    save_scheduled(items)
    await broadcast({"type": "scheduled_added", "data": item})
    return web.json_response(item, status=201)

async def delete_scheduled_handler(request):
    item_id = request.match_info['id']
    items = get_scheduled()
    items = [i for i in items if i['id'] != item_id]
    save_scheduled(items)
    await broadcast({"type": "scheduled_deleted", "data": {"id": item_id}})
    return web.json_response({"ok": True})

# Metrics API
async def get_metrics_handler(request):
    return web.json_response(get_metrics())

async def update_metrics_handler(request):
    body = await request.json()
    metrics = get_metrics()
    
    # Update top-level fields
    if 'provider' in body:
        metrics['provider'] = body['provider']
    if 'model' in body:
        metrics['model'] = body['model']
    if 'premium_remaining' in body:
        metrics.setdefault('token_usage', {})['premium_remaining'] = body['premium_remaining']
    if 'chat_remaining' in body:
        metrics.setdefault('token_usage', {})['chat_remaining'] = body['chat_remaining']
    
    if 'token_usage' in body:
        metrics.setdefault('token_usage', {}).update(body['token_usage'])
    
    metrics.setdefault('token_usage', {})['last_updated'] = datetime.utcnow().isoformat() + 'Z'
    
    save_metrics(metrics)
    await broadcast({"type": "metrics_updated", "data": metrics})
    return web.json_response({"ok": True})

# Mood API
def get_mood():
    return load_json(MOOD_FILE, {"mood": None, "lastUpdated": None})

def save_mood(mood_data):
    save_json(MOOD_FILE, mood_data)

async def get_mood_handler(request):
    return web.json_response(get_mood())

async def update_mood_handler(request):
    body = await request.json()
    mood = body.get('mood')
    now = datetime.utcnow().isoformat() + "Z"
    mood_data = {
        "mood": mood,
        "lastUpdated": now
    }
    save_mood(mood_data)
    add_activity(f"🧠 Mood updated to: {mood}")
    await broadcast({"type": "mood_updated", "data": mood_data})
    return web.json_response(mood_data)

# ==================== MEMORY API ====================

def get_memory_db():
    conn = sqlite3.connect(MEMORY_DB)
    conn.row_factory = sqlite3.Row
    return conn

def get_memory_stats():
    try:
        conn = get_memory_db()
        c = conn.cursor()
        c.execute("SELECT COUNT(*) FROM facts")
        facts_count = c.fetchone()[0]
        c.execute("SELECT COUNT(*) FROM goals WHERE status = 'active'")
        active_goals = c.fetchone()[0]
        c.execute("SELECT COUNT(*) FROM goals WHERE status = 'completed'")
        completed_goals = c.fetchone()[0]
        c.execute("SELECT COUNT(*) FROM goals")
        goals_count = c.fetchone()[0]
        c.execute("SELECT COUNT(*) FROM conversations")
        conversations_count = c.fetchone()[0]
        c.execute("SELECT COUNT(*) FROM preferences")
        preferences_count = c.fetchone()[0]
        db_size = os.path.getsize(MEMORY_DB) if os.path.exists(MEMORY_DB) else 0
        c.execute("SELECT category, COUNT(*) as cnt FROM facts GROUP BY category")
        facts_by_category = {row['category'] or 'uncategorized': row['cnt'] for row in c.fetchall()}
        thirty_days_ago = (datetime.utcnow() - timedelta(days=30)).strftime('%Y-%m-%d')
        c.execute(
            "SELECT DATE(created_at) as day, COUNT(*) as cnt FROM conversations WHERE DATE(created_at) >= ? GROUP BY DATE(created_at) ORDER BY day",
            (thirty_days_ago,))
        conversations_by_day = {row['day']: row['cnt'] for row in c.fetchall()}
        c.execute("SELECT status, COUNT(*) as cnt FROM goals GROUP BY status")
        goals_by_status = {row['status'] or 'unknown': row['cnt'] for row in c.fetchall()}
        today = datetime.utcnow().strftime('%Y-%m-%d')
        c.execute("SELECT COUNT(*) FROM conversations WHERE DATE(created_at) = ?", (today,))
        conversations_today = c.fetchone()[0]
        conn.close()
        return {
            "facts_count": facts_count, "goals_count": goals_count,
            "active_goals": active_goals, "completed_goals": completed_goals,
            "conversations_count": conversations_count, "conversations_today": conversations_today,
            "preferences_count": preferences_count, "database_size_bytes": db_size,
            "facts_by_category": facts_by_category, "conversations_by_day": conversations_by_day,
            "goals_by_status": goals_by_status}
    except Exception as e:
        return {"error": str(e)}

async def memory_stats_handler(request):
    return web.json_response(get_memory_stats())

async def memory_facts_handler(request):
    try:
        page = max(1, int(request.query.get('page', 1)))
        limit = max(1, min(100, int(request.query.get('limit', 20))))
        conn = get_memory_db()
        c = conn.cursor()
        offset = (page - 1) * limit
        c.execute("SELECT COUNT(*) FROM facts")
        total = c.fetchone()[0]
        c.execute("SELECT id, fact, category, created_at FROM facts ORDER BY created_at DESC LIMIT ? OFFSET ?", (limit, offset))
        facts = [{"id": r["id"], "fact": r["fact"], "category": r["category"], "created_at": r["created_at"]} for r in c.fetchall()]
        conn.close()
        return web.json_response({"facts": facts, "total": total, "page": page, "limit": limit})
    except Exception as e:
        return web.json_response({"error": str(e)})

async def memory_goals_handler(request):
    try:
        conn = get_memory_db()
        c = conn.cursor()
        c.execute("SELECT id, text, deadline, status, priority, created_at, completed_at FROM goals ORDER BY created_at DESC")
        goals = [{"id": r["id"], "text": r["text"], "deadline": r["deadline"], "status": r["status"],
                  "priority": r["priority"], "created_at": r["created_at"], "completed_at": r["completed_at"]} for r in c.fetchall()]
        conn.close()
        return web.json_response(goals)
    except Exception as e:
        return web.json_response({"error": str(e)})

async def memory_conversations_handler(request):
    try:
        days = int(request.query.get('days', 7))
        conn = get_memory_db()
        c = conn.cursor()
        since = (datetime.utcnow() - timedelta(days=days)).strftime('%Y-%m-%d %H:%M:%S')
        c.execute("SELECT id, role, content, channel, session_id, created_at FROM conversations WHERE created_at >= ? ORDER BY created_at DESC", (since,))
        convs = [{"id": r["id"], "role": r["role"], "content": r["content"], "channel": r["channel"],
                  "session_id": r["session_id"], "created_at": r["created_at"]} for r in c.fetchall()]
        conn.close()
        return web.json_response(convs)
    except Exception as e:
        return web.json_response({"error": str(e)})

async def memory_preferences_handler(request):
    try:
        conn = get_memory_db()
        c = conn.cursor()
        c.execute("SELECT key, value, updated_at FROM preferences ORDER BY key")
        prefs = [{"key": r["key"], "value": r["value"], "updated_at": r["updated_at"]} for r in c.fetchall()]
        conn.close()
        return web.json_response(prefs)
    except Exception as e:
        return web.json_response({"error": str(e)})

# System monitoring
async def system_health_handler(request):
    """Run health check and return system metrics"""
    script = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts', 'health-check.sh')
    try:
        proc = await asyncio.create_subprocess_exec(
            'bash', script,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=10)
        data = json.loads(stdout.decode())
        return web.json_response(data)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

# Usage tracking
async def usage_stats_handler(request):
    """Run usage tracker and return stats"""
    script = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts', 'usage-tracker.sh')
    try:
        proc = await asyncio.create_subprocess_exec(
            'bash', script,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15)
        data = json.loads(stdout.decode())
        return web.json_response(data)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

# ==================== HISTORY / ARCHIVE API ====================

def _week_key(dt_str):
    """Return ISO week key like '2026-W06' from an ISO date string."""
    if not dt_str:
        return None
    try:
        dt = datetime.fromisoformat(dt_str.replace('Z', '+00:00'))
        iso = dt.isocalendar()
        return f"{iso[0]}-W{iso[1]:02d}"
    except Exception:
        return None

def _week_label(week_key):
    """Convert '2026-W06' to 'Feb 3 - Feb 9, 2026'."""
    try:
        year, w = int(week_key[:4]), int(week_key.split('W')[1])
        from datetime import date
        jan4 = date(year, 1, 4)
        start = jan4 + timedelta(weeks=w - 1) - timedelta(days=jan4.weekday())
        end = start + timedelta(days=6)
        months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
        return f"{months[start.month-1]} {start.day} - {months[end.month-1]} {end.day}, {year}"
    except Exception:
        return week_key

async def tasks_history_handler(request):
    """Return completed/archived tasks grouped by week with search/filter."""
    tasks = get_tasks()
    q = request.query.get('q', '').lower()
    agent = request.query.get('agent', '').lower()
    date_from = request.query.get('from', '')
    date_to = request.query.get('to', '')
    status_filter = request.query.get('status', 'done,archive')
    page = max(1, int(request.query.get('page', '1')))
    limit = max(1, min(200, int(request.query.get('limit', '100'))))

    allowed = set(s.strip() for s in status_filter.split(','))
    filtered = [t for t in tasks if t.get('status') in allowed]

    if q:
        filtered = [t for t in filtered if q in (t.get('title','') + ' ' + t.get('description','') + ' ' + t.get('assignedTo','')).lower()]
    if agent:
        filtered = [t for t in filtered if agent in (t.get('assignedTo','') or '').lower()]
    if date_from:
        filtered = [t for t in filtered if (t.get('completedAt') or t.get('createdAt','')) >= date_from]
    if date_to:
        filtered = [t for t in filtered if (t.get('completedAt') or t.get('createdAt','')) <= date_to + 'T23:59:59Z']

    filtered.sort(key=lambda t: t.get('completedAt') or t.get('createdAt',''), reverse=True)

    total = len(filtered)
    start = (page - 1) * limit
    page_tasks = filtered[start:start + limit]

    weeks = {}
    for t in page_tasks:
        wk = _week_key(t.get('completedAt') or t.get('createdAt'))
        if not wk:
            wk = 'Unknown'
        if wk not in weeks:
            weeks[wk] = []
        weeks[wk].append(t)

    weeks_list = []
    for wk in sorted(weeks.keys(), reverse=True):
        weeks_list.append({
            'weekKey': wk,
            'weekLabel': _week_label(wk) if wk != 'Unknown' else 'Unknown',
            'tasks': weeks[wk]
        })

    all_completed = [t for t in tasks if t.get('status') in ('done', 'archive')]
    now = datetime.utcnow()
    this_week_key = f"{now.isocalendar()[0]}-W{now.isocalendar()[1]:02d}"
    last_week_dt = now - timedelta(weeks=1)
    last_week_key = f"{last_week_dt.isocalendar()[0]}-W{last_week_dt.isocalendar()[1]:02d}"

    by_agent = {}
    by_priority = {}
    completion_times = []
    this_week_count = 0
    last_week_count = 0

    for t in all_completed:
        ag = t.get('assignedTo') or t.get('completedBy') or 'Jarvis'
        by_agent[ag] = by_agent.get(ag, 0) + 1
        p = t.get('priority', 'medium')
        by_priority[p] = by_priority.get(p, 0) + 1
        wk = _week_key(t.get('completedAt') or t.get('createdAt'))
        if wk == this_week_key:
            this_week_count += 1
        elif wk == last_week_key:
            last_week_count += 1
        if t.get('startedAt') and t.get('completedAt'):
            try:
                s = datetime.fromisoformat(t['startedAt'].replace('Z','+00:00'))
                e = datetime.fromisoformat(t['completedAt'].replace('Z','+00:00'))
                completion_times.append((e - s).total_seconds() / 3600)
            except Exception:
                pass

    avg_time = round(sum(completion_times) / len(completion_times), 1) if completion_times else 0

    return web.json_response({
        'weeks': weeks_list,
        'stats': {
            'totalCompleted': len(all_completed),
            'thisWeek': this_week_count,
            'lastWeek': last_week_count,
            'byAgent': by_agent,
            'byPriority': by_priority,
            'avgCompletionTimeHours': avg_time
        },
        'pagination': {
            'page': page,
            'limit': limit,
            'total': total,
            'hasMore': start + limit < total
        }
    })

async def tasks_stats_handler(request):
    """Return summary statistics about tasks."""
    tasks = get_tasks()
    now = datetime.utcnow()
    this_week_key = f"{now.isocalendar()[0]}-W{now.isocalendar()[1]:02d}"
    last_week_dt = now - timedelta(weeks=1)
    last_week_key = f"{last_week_dt.isocalendar()[0]}-W{last_week_dt.isocalendar()[1]:02d}"

    by_status = {}
    by_agent = {}
    by_priority = {}
    this_week = 0
    last_week = 0
    timeline = {}

    for t in tasks:
        s = t.get('status', 'unknown')
        by_status[s] = by_status.get(s, 0) + 1

        if s in ('done', 'archive'):
            ag = t.get('assignedTo') or t.get('completedBy') or 'Jarvis'
            by_agent[ag] = by_agent.get(ag, 0) + 1
            p = t.get('priority', 'medium')
            by_priority[p] = by_priority.get(p, 0) + 1
            wk = _week_key(t.get('completedAt') or t.get('createdAt'))
            if wk:
                timeline[wk] = timeline.get(wk, 0) + 1
                if wk == this_week_key:
                    this_week += 1
                elif wk == last_week_key:
                    last_week += 1

    timeline_list = [{'week': k, 'count': v} for k, v in sorted(timeline.items())]

    return web.json_response({
        'totalTasks': len(tasks),
        'totalCompleted': by_status.get('done', 0) + by_status.get('archive', 0),
        'totalArchived': by_status.get('archive', 0),
        'completedThisWeek': this_week,
        'completedLastWeek': last_week,
        'byAgent': by_agent,
        'byPriority': by_priority,
        'byStatus': by_status,
        'timeline': timeline_list
    })

async def archive_old_tasks_handler(request):
    """Auto-archive done tasks older than 7 days."""
    tasks = get_tasks()
    cutoff = (datetime.utcnow() - timedelta(days=7)).isoformat() + 'Z'
    count = 0
    for t in tasks:
        if t.get('status') == 'done' and (t.get('completedAt') or '') < cutoff:
            t['status'] = 'archive'
            count += 1
    if count:
        save_tasks(tasks)
        add_activity(f"📦 Auto-archived {count} completed tasks older than 7 days")
        await broadcast({"type": "tasks_archived", "data": {"count": count}})
    return web.json_response({"archived": count})

# ==================== LIVE FEED API ====================

FEED_VALID_TYPES = {'thinking', 'working', 'agent-spawned', 'agent-completed',
                    'agent-failed', 'validating', 'decision', 'error', 'completed'}

def prune_old_feed_entries():
    """Remove feed entries from previous days. Fresh feed each day."""
    global feed_entries
    today = datetime.utcnow().strftime('%Y-%m-%d')
    feed_entries = [e for e in feed_entries if e['timestamp'][:10] >= today]

async def post_feed_handler(request):
    body = await request.json()
    message = body.get('message', '')
    entry_type = body.get('type', 'working')
    timestamp = body.get('timestamp') or (datetime.utcnow().isoformat() + "Z")

    if entry_type not in FEED_VALID_TYPES:
        return web.json_response({"error": f"Invalid type. Must be one of: {', '.join(sorted(FEED_VALID_TYPES))}"}, status=400)

    entry_id = str(uuid.uuid4())[:8]
    entry = {
        "id": entry_id,
        "message": message,
        "type": entry_type,
        "timestamp": timestamp
    }

    prune_old_feed_entries()
    feed_entries.append(entry)

    await broadcast({"type": "feed", "data": entry})
    return web.json_response({"ok": True, "id": entry_id}, status=201)

async def get_feed_handler(request):
    since = request.query.get('since', '')
    limit = min(500, max(1, int(request.query.get('limit', '100'))))

    prune_old_feed_entries()

    entries = feed_entries
    if since:
        entries = [e for e in entries if e['timestamp'] > since]

    # Return chronological order (oldest first) — matches WebSocket append behavior
    # Take the last N entries (most recent) in chronological order
    result = entries[-limit:]
    return web.json_response(result)

async def clear_feed_handler(request):
    """Clear all feed entries."""
    global feed_entries
    count = len(feed_entries)
    feed_entries = []
    await broadcast({"type": "feed_cleared"})
    return web.json_response({"ok": True, "cleared": count})

# Static file serving
async def index_handler(request):
    return web.FileResponse(os.path.join(STATIC_DIR, 'index.html'))

def create_app():
    app = web.Application()

    # WebSocket
    app.router.add_get('/ws', websocket_handler)
    
    # API routes
    app.router.add_get('/api/tasks', get_tasks_handler)
    app.router.add_post('/api/tasks', create_task_handler)
    app.router.add_patch('/api/tasks/{id}', update_task_handler)
    app.router.add_delete('/api/tasks/{id}', delete_task_handler)
    app.router.add_get('/api/agents', get_agents_handler)
    app.router.add_patch('/api/agents/{id}/status', update_agent_handler)
    app.router.add_delete('/api/agents/{id}', remove_agent_handler)
    app.router.add_get('/api/activity', get_activity_handler)
    app.router.add_post('/api/activity', add_activity_handler)
    app.router.add_post('/api/status-update', status_update_handler)
    
    # Notes routes
    app.router.add_get('/api/notes', get_notes_handler)
    app.router.add_post('/api/notes', add_note_handler)
    app.router.add_patch('/api/notes/{id}/read', mark_note_read_handler)
    app.router.add_delete('/api/notes/{id}', delete_note_handler)
    
    # Scheduled routes
    app.router.add_get('/api/scheduled', get_scheduled_handler)
    app.router.add_post('/api/scheduled', add_scheduled_handler)
    app.router.add_delete('/api/scheduled/{id}', delete_scheduled_handler)
    
    # Metrics routes
    app.router.add_get('/api/metrics', get_metrics_handler)
    app.router.add_patch('/api/metrics', update_metrics_handler)
    
    # Mood routes
    app.router.add_get('/api/mood', get_mood_handler)
    app.router.add_post('/api/mood', update_mood_handler)

    # History / Archive routes
    app.router.add_get('/api/tasks/history', tasks_history_handler)
    app.router.add_get('/api/tasks/stats', tasks_stats_handler)
    app.router.add_post('/api/tasks/archive-old', archive_old_tasks_handler)

    # Feed routes
    app.router.add_get('/api/feed', get_feed_handler)
    app.router.add_post('/api/feed', post_feed_handler)
    app.router.add_delete('/api/feed', clear_feed_handler)

    # System monitoring
    app.router.add_get('/api/system/health', system_health_handler)
    app.router.add_get('/api/system/usage', usage_stats_handler)

    # Memory routes
    app.router.add_get('/api/memory/stats', memory_stats_handler)
    app.router.add_get('/api/memory/facts', memory_facts_handler)
    app.router.add_get('/api/memory/goals', memory_goals_handler)
    app.router.add_get('/api/memory/conversations', memory_conversations_handler)
    app.router.add_get('/api/memory/preferences', memory_preferences_handler)

    # Static files
    app.router.add_get('/', index_handler)
    app.router.add_static('/', STATIC_DIR, show_index=False)
    
    return app

def main():
    print(f"🤖 Jarvis Command Center v2 (WebSocket)")
    print(f"   Local:  http://localhost:{PORT}")
    print(f"   LAN:    http://192.168.50.39:{PORT}")
    print(f"   WS:     ws://192.168.50.39:{PORT}/ws")
    print("\nPress Ctrl+C to stop")
    
    app = create_app()
    web.run_app(app, host='0.0.0.0', port=PORT, print=None)

if __name__ == '__main__':
    main()
