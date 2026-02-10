// Jarvis Command Center - Frontend

const API_BASE = '/api';
let tasks = [];
let agents = [];
let activity = [];
let statusUpdates = []; // Track granular status updates separately
let scheduled = [];
let notes = [];
let feedEntries = [];
let selectedTaskId = null;
let metrics = { token_usage: { premium_remaining: null, chat_remaining: null } };
let ws = null;
let wsReconnectTimer = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    connectWebSocket();
    loadData();
    setupDragAndDrop();
    setupTabs();
    setupSidebarResize();
    loadScheduled();
    updateSyncTime();
});

// WebSocket connection
let statusPollInterval = null;

function connectWebSocket() {
    const wsUrl = `ws://${window.location.host}/ws`;
    console.log('Connecting to WebSocket:', wsUrl);
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        console.log('WebSocket connected');
        document.getElementById('connectionDot').classList.add('connected');
        document.getElementById('connectionDot').classList.remove('disconnected');
        if (wsReconnectTimer) {
            clearTimeout(wsReconnectTimer);
            wsReconnectTimer = null;
        }
        updateSyncTime();
        // Start fast status polling as backup
        startStatusPolling();
    };
    
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        handleWebSocketMessage(message);
        updateSyncTime();
    };
    
    ws.onclose = () => {
        console.log('WebSocket disconnected');
        document.getElementById('connectionDot').classList.remove('connected');
        document.getElementById('connectionDot').classList.add('disconnected');
        stopStatusPolling();
        if (!wsReconnectTimer) {
            wsReconnectTimer = setTimeout(connectWebSocket, 1000);
        }
    };
    
    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };
}

// Fast polling for status updates (every 2 seconds)
let elapsedTickInterval = null;

function startStatusPolling() {
    if (statusPollInterval) return;
    statusPollInterval = setInterval(async () => {
        try {
            const res = await fetch(`${API_BASE}/agents`);
            const newAgents = await res.json();
            if (JSON.stringify(newAgents) !== JSON.stringify(agents)) {
                agents = newAgents;
                renderAgents();
            }
        } catch (e) {}
    }, 2000);

    // Tick elapsed times every second for live counters
    if (!elapsedTickInterval) {
        elapsedTickInterval = setInterval(() => {
            document.querySelectorAll('.helper-elapsed').forEach(el => {
                const agentId = el.dataset.agentId;
                if (agentId) {
                    const agent = agents.find(a => a.id === agentId);
                    const startTime = (agent && agent.startedWorkingAt) ? new Date(agent.startedWorkingAt).getTime() : agentStartTimes[agentId];
                    if (!startTime) return;
                    const elapsed = Math.floor((Date.now() - startTime) / 1000);
                    el.textContent = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
                }
            });
        }, 1000);
    }
}

function stopStatusPolling() {
    if (statusPollInterval) {
        clearInterval(statusPollInterval);
        statusPollInterval = null;
    }
    if (elapsedTickInterval) {
        clearInterval(elapsedTickInterval);
        elapsedTickInterval = null;
    }
}

function handleWebSocketMessage(message) {
    switch (message.type) {
        case 'init':
            tasks = message.data.tasks || [];
            agents = message.data.agents || [];
            activity = message.data.activity || [];
            renderAll();
            break;
        
        case 'task_created':
            // Only add if not already present (avoid duplicates from POST + WS)
            if (!tasks.find(t => t.id === message.data.id)) {
                tasks.push(message.data);
                renderTasks();
            }
            break;
        
        case 'task_updated':
            const taskIdx = tasks.findIndex(t => t.id === message.data.id);
            if (taskIdx !== -1) {
                const oldStatus = tasks[taskIdx].status;
                const newStatus = message.data.status;
                Object.assign(tasks[taskIdx], message.data);
                renderTasks();
                
                // Add pulse animation to the updated task
                if (oldStatus !== newStatus) {
                    setTimeout(() => {
                        const card = document.querySelector(`.task-card[data-id="${message.data.id}"]`);
                        if (card) {
                            card.classList.add('status-changed');
                            setTimeout(() => card.classList.remove('status-changed'), 1000);
                        }
                    }, 50);
                }
            }
            break;
        
        case 'task_deleted':
            tasks = tasks.filter(t => t.id !== message.data.id);
            renderTasks();
            break;
        
        case 'agent_updated':
            console.log('[WS] agent_updated received:', message.data);
            const agentIdx = agents.findIndex(a => a.id === message.data.id);
            if (agentIdx !== -1) {
                Object.assign(agents[agentIdx], message.data);
            } else {
                agents.push(message.data);
            }
            renderAgents();
            break;
        
        case 'agent_removed':
            agents = agents.filter(a => a.id !== message.data.id);
            renderAgents();
            break;
        
        case 'note_added':
            if (!notes.find(n => n.id === message.data.id)) {
                notes.push(message.data);
                renderNotes();
            }
            break;
        
        case 'note_updated':
            const noteIdx = notes.findIndex(n => n.id === message.data.id);
            if (noteIdx !== -1) {
                Object.assign(notes[noteIdx], message.data);
                renderNotes();
            }
            break;
        
        case 'note_deleted':
            notes = notes.filter(n => n.id !== message.data.id);
            renderNotes();
            break;
        
        case 'scheduled_added':
            if (!scheduled.find(s => s.id === message.data.id)) {
                scheduled.push(message.data);
                renderScheduled();
            }
            break;
        
        case 'activity':
            activity.push(message.data);
            renderActivity();
            break;
        
        case 'status_update':
            // Add granular status update to the stream
            statusUpdates.push(message.data);
            // Keep last 200 status updates
            statusUpdates = statusUpdates.slice(-200);
            break;
        
        case 'metrics_updated':
            metrics = message.data;
            renderMetrics();
            break;

        case 'feed':
            feedEntries.push(message.data);
            feedEntries = feedEntries.slice(-500);
            renderFeedEntry(message.data);
            break;

        case 'feed_cleared':
            feedEntries = [];
            renderFeed();
            break;

    }
}

function updateSyncTime() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        second: '2-digit',
        hour12: true 
    });
    document.getElementById('syncStatus').textContent = `Last sync: ${timeStr}`;
}

// Data Loading
async function loadData() {
    try {
        const [tasksRes, agentsRes, activityRes, notesRes, scheduledRes, metricsRes] = await Promise.all([
            fetch(`${API_BASE}/tasks`),
            fetch(`${API_BASE}/agents`),
            fetch(`${API_BASE}/activity`),
            fetch(`${API_BASE}/notes`),
            fetch(`${API_BASE}/scheduled`),
            fetch(`${API_BASE}/metrics`)
        ]);
        
        tasks = await tasksRes.json();
        agents = await agentsRes.json();
        activity = await activityRes.json();
        notes = await notesRes.json();
        scheduled = await scheduledRes.json();
        metrics = await metricsRes.json();
        
        renderAll();
    } catch (err) {
        console.error('Failed to load data:', err);
    }
}

function renderAll() {
    renderTasks();
    renderAgents();
    renderMetrics();
    renderActivity();
    renderNotes();
    renderScheduled();
}

// Tab Navigation
function setupTabs() {
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
            // Let external links (like Docs) navigate normally
            if (tab.href && !tab.dataset.tab) {
                return; // Don't prevent default, let browser navigate
            }
            
            e.preventDefault();
            const tabName = tab.dataset.tab;
            
            document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            const dashContent = document.querySelector('.dashboard-content');
            const logContent = document.getElementById('logContent');
            const sysContent = document.getElementById('systemContent');
            const histContent = document.getElementById('historyContent');
            const feedContent = document.getElementById('feedContent');

            dashContent.style.display = 'none';
            logContent.style.display = 'none';
            sysContent.style.display = 'none';
            if (histContent) histContent.style.display = 'none';
            if (feedContent) feedContent.style.display = 'none';

            if (tabName === 'log') {
                logContent.style.display = 'block';
                stopSystemPolling();
            } else if (tabName === 'system') {
                sysContent.style.display = 'block';
                loadSystemHealth();
                loadUsageStats();
                startSystemPolling();
            } else if (tabName === 'history') {
                if (histContent) histContent.style.display = 'block';
                loadHistory();
                stopSystemPolling();
            } else if (tabName === 'feed') {
                if (feedContent) feedContent.style.display = 'flex';
                loadFeed();
                stopSystemPolling();
            } else {
                dashContent.style.display = '';
                stopSystemPolling();
            }
        });
    });
}

// Rendering
function renderTasks() {
    const columns = ['backlog', 'todo', 'in-progress', 'done'];
    
    columns.forEach(status => {
        const container = document.getElementById(`tasks-${status}`);
        const statusTasks = tasks.filter(t => t.status === status);
        
        container.innerHTML = statusTasks.map(task => `
            <div class="task-card ${task.status === 'in-progress' && agents.find(a => a.currentTask?.includes(task.title)) ? 'in-progress-active' : ''} priority-${task.priority || 'medium'}" draggable="true" data-id="${task.id}" onclick="openTaskDetail('${task.id}')">
                <div class="task-indicator">
                    <span class="task-indicator-dot ${task.priority || 'medium'}"></span>
                </div>
                <div class="task-title">${escapeHtml(task.title)}</div>
                ${task.description ? `<div class="task-subtitle">${escapeHtml(truncate(task.description, 50))}</div>` : ''}
                <div class="task-timestamps">
                    ${task.createdAt ? `<span class="task-time" title="Created">📝 ${formatRelativeTime(task.createdAt)}</span>` : ''}
                    ${task.startedAt ? `<span class="task-time" title="Started">▶️ ${formatRelativeTime(task.startedAt)}</span>` : ''}
                    ${task.completedAt ? `<span class="task-time" title="Completed">✅ ${formatRelativeTime(task.completedAt)}</span>` : ''}
                </div>
                ${task.assignedTo ? `<div class="task-agent-badge">${escapeHtml(task.assignedTo)}</div>` : ''}
                ${task.completedBy ? `<div class="task-attribution">✓ ${escapeHtml(task.completedBy)}</div>` : ''}
            </div>
        `).join('');
        
        const countEl = document.getElementById(`count-${status}`);
        if (countEl) countEl.textContent = statusTasks.length;
    });
    
    // Archive — show only most recent 5, link to History tab
    const archiveTasks = tasks.filter(t => t.status === 'archive');
    archiveTasks.sort((a, b) => (b.completedAt || b.createdAt || '').localeCompare(a.completedAt || a.createdAt || ''));
    const recentArchive = archiveTasks.slice(0, 5);
    const archiveList = document.getElementById('tasks-archive');
    if (archiveList) {
        let html = recentArchive.map(task => `
            <div class="task-card archive-card priority-${task.priority || 'medium'}" draggable="true" data-id="${task.id}" onclick="openTaskDetail('${task.id}')">
                <div class="task-title">${escapeHtml(task.title)}</div>
                <div class="task-timestamps">
                    ${task.completedAt ? `<span class="task-time">✅ ${formatRelativeTime(task.completedAt)}</span>` : ''}
                </div>
            </div>
        `).join('');
        if (archiveTasks.length > 5) {
            html += `<div class="archive-view-all" onclick="document.querySelector('[data-tab=\\'history\\']').click()">View all ${archiveTasks.length} in History &rarr;</div>`;
        }
        archiveList.innerHTML = html;

        const archiveCount = document.getElementById('count-archive');
        if (archiveCount) archiveCount.textContent = archiveTasks.length;
    }
    
    setupDragAndDrop();
}

// Track when agents started working (client-side timer)
const agentStartTimes = {};
// Track recently completed agents for fade-out
let recentlyCompleted = []; // { name, task, completedAt }

function renderAgents() {
    // Main agent status (Athena)
    const mainAgent = agents.find(a => a.id === 'mo-main' || a.id === 'claude-opus') || agents[0];
    if (mainAgent) {
        const statusText = document.querySelector('.status-indicator .status-text');
        const statusDot = document.querySelector('.status-indicator .status-dot');
        const navDot = document.getElementById('navStatusDot');
        const readyBtn = document.getElementById('readyBtn');
        const avatarContainer = document.getElementById('avatarContainer');
        const agentAvatar = document.getElementById('agentAvatar');

        statusText.textContent = mainAgent.status || 'Idle';

        const statusClass = getStatusClass(mainAgent.status);
        statusDot.className = `status-dot ${statusClass}`;
        navDot.className = `status-dot-small ${statusClass}`;
        avatarContainer.className = `avatar-container ${statusClass}`;
        const newEmoji = getStatusEmoji(mainAgent.status);
        console.log('[renderAgents] status:', mainAgent.status, 'emoji:', newEmoji, 'current avatar text:', agentAvatar.textContent);
        agentAvatar.textContent = newEmoji;

        if (mainAgent.status === 'Working' || mainAgent.status === 'Thinking' || mainAgent.status === 'Managing' || mainAgent.status === 'Delegating' || mainAgent.status === 'Heartbeat' || mainAgent.status === 'Checking' || mainAgent.status === 'Healing') {
            readyBtn.textContent = mainAgent.currentTask || 'Working...';
            readyBtn.classList.add('working');
        } else {
            readyBtn.textContent = 'Ready for tasks';
            readyBtn.classList.remove('working');
        }
    }

    // Dynamic helpers — ONLY show agents that are actively working
    const activeStatuses = ['Working', 'Thinking', 'Checking', 'Typing', 'Delegating', 'Heartbeat', 'Healing', 'Managing'];
    const activeHelpers = agents.filter(a => {
        if (a.id === 'mo-main' || a.id === 'claude-opus') return false;
        return activeStatuses.includes(a.status) && a.currentTask;
    });

    // Track start times for elapsed display
    activeHelpers.forEach(a => {
        if (!agentStartTimes[a.id]) {
            agentStartTimes[a.id] = Date.now();
        }
    });
    // Clean up start times for agents no longer active
    Object.keys(agentStartTimes).forEach(id => {
        const still = activeHelpers.find(a => a.id === id);
        if (!still) {
            // Agent just finished — add to recently completed
            const prev = agents.find(a => a.id === id);
            if (prev && agentStartTimes[id]) {
                const elapsed = Math.floor((Date.now() - agentStartTimes[id]) / 1000);
                recentlyCompleted.push({
                    name: prev.name || id,
                    task: prev.currentTask || 'Unknown task',
                    completedAt: Date.now(),
                    elapsed,
                });
                // Keep only last 5
                recentlyCompleted = recentlyCompleted.slice(-5);
            }
            delete agentStartTimes[id];
        }
    });

    const helpersList = document.getElementById('helpersList');
    const helpersCount = document.getElementById('helpersCount');

    if (helpersCount) {
        helpersCount.textContent = activeHelpers.length;
        helpersCount.style.display = activeHelpers.length > 0 ? 'inline-block' : 'none';
    }

    // Prune recently completed older than 60s
    const now = Date.now();
    recentlyCompleted = recentlyCompleted.filter(r => now - r.completedAt < 60000);

    if (activeHelpers.length > 0 || recentlyCompleted.length > 0) {
        let html = '';

        // Active agents
        html += activeHelpers.map(agent => {
            const modelClass = getModelClass(agent.model);
            const modelName = getModelDisplayName(agent.model);
            const startTime = agent.startedWorkingAt ? new Date(agent.startedWorkingAt).getTime() : agentStartTimes[agent.id];
            const elapsed = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
            const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;

            return `
                <div class="helper-item working active-helper">
                    <div class="helper-main-info">
                        <div class="helper-avatar ${modelClass}">${getModelEmoji(agent.model)}</div>
                        <div class="helper-info">
                            <span class="helper-name">${escapeHtml(agent.name || 'Agent')}</span>
                            <span class="helper-model">${escapeHtml(modelName)}</span>
                        </div>
                        <span class="helper-elapsed" data-agent-id="${agent.id}">${elapsedStr}</span>
                    </div>
                    <div class="helper-task">${escapeHtml(agent.currentTask)}</div>
                    <div class="helper-progress-container">
                        <div class="helper-progress-bar"></div>
                    </div>
                </div>
            `;
        }).join('');

        // Recently completed (fade out)
        if (recentlyCompleted.length > 0) {
            html += recentlyCompleted.map(r => {
                const age = now - r.completedAt;
                const opacity = Math.max(0.2, 1 - (age / 60000));
                const elapsedStr = r.elapsed < 60 ? `${r.elapsed}s` : `${Math.floor(r.elapsed / 60)}m`;
                return `
                    <div class="helper-item helper-completed" style="opacity: ${opacity}">
                        <div class="helper-main-info">
                            <div class="helper-avatar completed-avatar">✓</div>
                            <div class="helper-info">
                                <span class="helper-name">${escapeHtml(r.name)}</span>
                                <span class="helper-model">Done in ${elapsedStr}</span>
                            </div>
                        </div>
                        <div class="helper-task helper-task-done">${escapeHtml(r.task)}</div>
                    </div>
                `;
            }).join('');
        }

        helpersList.innerHTML = html;
    } else {
        helpersList.innerHTML = '<div class="helpers-empty">No helpers active</div>';
    }
}

function renderMetrics() {
    const metricsDisplay = document.getElementById('metricsDisplay');
    if (!metricsDisplay) return;
    
    const tokenUsage = metrics.token_usage || {};
    const provider = metrics.provider || '--';
    const model = metrics.model || '--';
    
    // Shorten model name for display
    const shortModel = model.replace('claude-', '').replace('-thinking', ' 💭');
    
    metricsDisplay.innerHTML = `
        <div class="metrics-provider">🔌 ${provider}</div>
        <div class="metrics-model">🧠 ${shortModel}</div>
    `;
}

function renderActivity() {
    const container = document.getElementById('activityFeed');
    
    // Combine and sort activity items and status updates
    const allItems = [
        ...activity.map(item => ({...item, type: 'activity'})),
        ...statusUpdates.map(item => ({...item, type: 'status'}))
    ];
    
    // Sort by timestamp (descending)
    allItems.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    const recent = allItems.slice(0, 100);
    
    // Update log count
    const logCount = document.getElementById('logCount');
    if (logCount) logCount.textContent = `${allItems.length} entries`;

    container.innerHTML = recent.map((item, i) => {
        if (item.type === 'status') {
            // Granular status update - compact, greyed out style
            const statusLabel = item.status ? `[${item.status.toUpperCase()}]` : '';
            return `
                <div class="activity-item status-update ${i === 0 ? 'new' : ''}">
                    <span class="activity-time status-update-time">${formatTime(item.timestamp)}</span>
                    <span class="activity-text status-detail"><span class="status-agent">${escapeHtml(item.agent || 'unknown')}</span> <span class="status-label">${statusLabel}</span> ${escapeHtml(item.detail || '')}</span>
                </div>
            `;
        } else {
            // Regular activity
            return `
                <div class="activity-item ${i === 0 ? 'new' : ''}">
                    <span class="activity-time">${formatTime(item.timestamp)}</span>
                    <span class="activity-text">${escapeHtml(item.message)}</span>
                </div>
            `;
        }
    }).join('');
    
}


function getStatusClass(status) {
    const statusMap = {
        'Idle': 'idle',
        'Working': 'working',
        'Thinking': 'thinking',
        'Checking': 'checking',
        'Typing': 'typing',
        'Delegating': 'delegating',
        'Heartbeat': 'heartbeat',
        'Healing': 'healing',
        'Managing': 'working'
    };
    return statusMap[status] || 'idle';
}

function getStatusEmoji(status) {
    const emojiMap = {
        'Idle': '😊',
        'Working': '😤',
        'Thinking': '🤔',
        'Checking': '🤒',
        'Typing': '✍️',
        'Delegating': '📡',
        'Heartbeat': '💓',
        'Healing': '🩹',
        'Managing': '🎯'
    };
    return emojiMap[status] || '😊';
}

// Scheduled Deliverables
async function loadScheduled() {
    try {
        const res = await fetch(`${API_BASE}/scheduled`);
        scheduled = await res.json();
        renderScheduled();
    } catch (err) {
        console.error('Failed to load scheduled:', err);
    }
}

function renderScheduled() {
    const container = document.getElementById('scheduledList');
    if (!container) return;
    
    if (scheduled.length === 0) {
        container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.75rem; text-align: center; padding: 20px;">No scheduled tasks yet</div>';
        return;
    }
    
    container.innerHTML = scheduled.map(item => `
        <div class="scheduled-item">
            <div class="scheduled-icon">${item.icon || '📋'}</div>
            <div class="scheduled-info">
                <div class="scheduled-name">${escapeHtml(item.name)}</div>
                <div class="scheduled-freq">${item.schedule || 'Daily'}</div>
            </div>
            <span class="scheduled-badge ${item.enabled ? '' : 'disabled'}">${item.enabled ? 'Active' : 'Paused'}</span>
        </div>
    `).join('');
}

// Notes
function renderNotes() {
    const container = document.getElementById('notesList');
    const countEl = document.getElementById('notesCount');
    const sidebarList = document.getElementById('sidebarNotesList');
    const sidebarCount = document.getElementById('sidebarNotesCount');

    const unreadCount = notes.filter(n => !n.read).length;

    if (countEl) {
        countEl.textContent = unreadCount;
        countEl.classList.toggle('empty', unreadCount === 0);
    }
    if (sidebarCount) {
        sidebarCount.textContent = unreadCount;
        sidebarCount.style.display = unreadCount > 0 ? 'inline-block' : 'none';
    }

    const recentNotes = notes.slice(-5).reverse();
    const noteHtml = recentNotes.map(note => `
        <div class="note-item ${note.read ? 'read' : 'unread'}" data-id="${note.id}">
            <div class="note-content">${escapeHtml(note.content)}</div>
            <div class="note-meta">
                <span class="note-time" title="Sent">${formatRelativeTime(note.createdAt)}</span>
                ${note.read ? `<span class="note-read-indicator" title="Read by Mo at ${note.readAt ? new Date(note.readAt).toLocaleString() : 'unknown'}">✓✓</span>` : '<span class="note-pending">Pending</span>'}
            </div>
            <button class="note-delete" onclick="deleteNote('${note.id}')">&times;</button>
        </div>
    `).join('') || '<div style="color: var(--text-muted); font-size: 0.75rem; text-align: center; padding: 10px;">No notes yet</div>';

    if (container) container.innerHTML = noteHtml;

    if (sidebarList) {
        const sidebarNoteHtml = recentNotes.map(note => `
            <div class="sidebar-note-item ${note.read ? 'read' : 'unread'}" data-id="${note.id}">
                <div class="sidebar-note-content">${escapeHtml(note.content)}</div>
                <div class="sidebar-note-meta">
                    <span class="note-time">${formatRelativeTime(note.createdAt)}</span>
                    ${note.read ? '<span class="note-read-indicator">✓✓</span>' : '<span class="note-pending">New</span>'}
                </div>
            </div>
        `).join('') || '<div class="sidebar-notes-empty">No notes yet</div>';
        sidebarList.innerHTML = sidebarNoteHtml;
    }
}

async function addSidebarNote() {
    const input = document.getElementById('sidebarNotesInput');
    const content = input.value.trim();
    if (!content) return;
    try {
        const res = await fetch(`${API_BASE}/notes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
        if (res.ok) {
            const note = await res.json();
            if (!notes.find(n => n.id === note.id)) {
                notes.push(note);
            }
            renderNotes();
            input.value = '';
        }
    } catch (err) {
        console.error('Failed to add note:', err);
    }
}

async function deleteNote(noteId) {
    try {
        await fetch(`${API_BASE}/notes/${noteId}`, { method: 'DELETE' });
        notes = notes.filter(n => n.id !== noteId);
        renderNotes();
    } catch (err) {
        console.error('Failed to delete note:', err);
    }
}

// Task Management
function openQuickAdd(status) {
    document.getElementById('taskStatus').value = status;
    document.getElementById('newTaskModal').classList.add('active');
    document.getElementById('taskTitle').focus();
}

function closeModal() {
    document.getElementById('newTaskModal').classList.remove('active');
    document.getElementById('newTaskForm').reset();
}

async function createTask(event) {
    event.preventDefault();
    
    const task = {
        title: document.getElementById('taskTitle').value,
        description: document.getElementById('taskDescription').value,
        priority: document.getElementById('taskPriority').value,
        model: document.getElementById('taskModel').value,
        status: document.getElementById('taskStatus').value || 'todo',
        assignedTo: document.getElementById('taskAgent').value || '',
        createdAt: new Date().toISOString()
    };
    
    try {
        const res = await fetch(`${API_BASE}/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(task)
        });
        
        if (res.ok) {
            const newTask = await res.json();
            // Only add if WebSocket hasn't already added it
            if (!tasks.find(t => t.id === newTask.id)) {
                tasks.push(newTask);
                renderTasks();
            }
            closeModal();
        }
    } catch (err) {
        console.error('Failed to create task:', err);
    }
}

function openTaskDetail(taskId) {
    selectedTaskId = taskId;
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    document.getElementById('detailTitle').value = task.title;
    document.getElementById('detailDescription').value = task.description || '';
    document.getElementById('detailStatus').value = task.status;
    document.getElementById('detailPriority').value = task.priority || 'medium';
    document.getElementById('detailModel').textContent = getModelShortName(task.model);
    document.getElementById('detailAgent').textContent = task.assignedTo || '—';
    document.getElementById('detailOutput').innerHTML = task.output
        ? `<pre>${escapeHtml(task.output)}</pre>`
        : '<em>No output yet...</em>';

    document.getElementById('taskDetailModal').classList.add('active');
}

function closeTaskDetail() {
    document.getElementById('taskDetailModal').classList.remove('active');
    selectedTaskId = null;
}

async function updateTaskFromDetail() {
    if (!selectedTaskId) return;

    const newStatus = document.getElementById('detailStatus').value;
    const newPriority = document.getElementById('detailPriority').value;
    await updateTask(selectedTaskId, { status: newStatus, priority: newPriority });
}

async function saveTaskFromDetail() {
    if (!selectedTaskId) return;

    const updates = {
        title: document.getElementById('detailTitle').value.trim(),
        description: document.getElementById('detailDescription').value.trim(),
        status: document.getElementById('detailStatus').value,
        priority: document.getElementById('detailPriority').value
    };

    if (!updates.title) {
        showToast('Task title cannot be empty');
        return;
    }

    await updateTask(selectedTaskId, updates);
    showToast('Task updated');
    closeTaskDetail();
}

async function updateTask(taskId, updates) {
    try {
        const res = await fetch(`${API_BASE}/tasks/${taskId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
        });
        
        if (res.ok) {
            const task = tasks.find(t => t.id === taskId);
            if (task) Object.assign(task, updates);
            renderTasks();
        } else {
            showToast('Failed to update task');
        }
    } catch (err) {
        console.error('Failed to update task:', err);
        showToast('Failed to update task');
    }
}

async function deleteTask() {
    if (!selectedTaskId) return;
    if (!confirm('Delete this task?')) return;
    
    try {
        await fetch(`${API_BASE}/tasks/${selectedTaskId}`, { method: 'DELETE' });
        tasks = tasks.filter(t => t.id !== selectedTaskId);
        renderTasks();
        closeTaskDetail();
    } catch (err) {
        console.error('Failed to delete task:', err);
        showToast('Failed to delete task');
    }
}

async function archiveTask() {
    if (!selectedTaskId) return;
    await updateTask(selectedTaskId, { status: 'archive' });
    closeTaskDetail();
}

// Activity
function logActivity(message) {
    fetch(`${API_BASE}/activity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, timestamp: new Date().toISOString() })
    }).catch(err => console.error('Failed to log activity:', err));
}

// Drag and Drop
function setupDragAndDrop() {
    document.querySelectorAll('.task-card').forEach(card => {
        card.addEventListener('dragstart', handleDragStart);
        card.addEventListener('dragend', handleDragEnd);
    });
    
    document.querySelectorAll('.task-list').forEach(list => {
        list.addEventListener('dragover', handleDragOver);
        list.addEventListener('dragleave', handleDragLeave);
        list.addEventListener('drop', handleDrop);
    });
}

function handleDragStart(e) {
    e.target.classList.add('dragging');
    e.dataTransfer.setData('text/plain', e.target.dataset.id);
}

function handleDragEnd(e) {
    e.target.classList.remove('dragging');
    document.querySelectorAll('.task-list').forEach(list => {
        list.classList.remove('drag-over');
    });
}

function handleDragOver(e) {
    e.preventDefault();
    e.currentTarget.classList.add('drag-over');
}

function handleDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
}

async function handleDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    
    const taskId = e.dataTransfer.getData('text/plain');
    const newStatus = e.currentTarget.closest('.kanban-column').dataset.status;
    
    await updateTask(taskId, { status: newStatus });
}

// Utilities
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '...' : str;
}

function formatTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function getModelShortName(model) {
    const names = {
        'auto': '🤖 Auto',
        'claude-haiku-4.5': '⚡ Haiku',
        'claude-sonnet-4.5': '✍️ Sonnet',
        'claude-opus-4.5': '🎯 Opus',
        'gpt-5.2-codex': '💻 Codex'
    };
    return names[model] || model || '🤖 Auto';
}

function getPriorityEmoji(priority) {
    const emojis = { low: '🟢', medium: '🟡', high: '🟠', urgent: '🔴' };
    return emojis[priority] || '🟡';
}

function getModelClass(model) {
    if (!model) return 'default';
    if (model.includes('haiku')) return 'haiku';
    if (model.includes('sonnet')) return 'sonnet';
    if (model.includes('opus')) return 'opus';
    if (model.includes('codex') || model.includes('gpt')) return 'codex';
    return 'default';
}

function getModelEmoji(model) {
    if (!model) return '🤖';
    if (model.includes('haiku')) return '⚡';
    if (model.includes('sonnet')) return '✍️';
    if (model.includes('opus')) return '🎯';
    if (model.includes('codex')) return '💻';
    if (model.includes('gpt')) return '🧠';
    return '🤖';
}

function getModelDisplayName(model) {
    if (!model) return 'Unknown';
    if (model.includes('haiku')) return 'Haiku';
    if (model.includes('sonnet')) return 'Sonnet';
    if (model.includes('opus')) return 'Opus';
    if (model.includes('codex')) return 'Codex';
    if (model.includes('gpt-5')) return 'GPT-5';
    if (model.includes('gpt-4')) return 'GPT-4';
    return model.split('/').pop();
}

function formatRelativeTime(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
}

// Sidebar Resize
function setupSidebarResize() {
    const sidebar = document.getElementById('leftSidebar');
    const handle = document.getElementById('sidebarResizeHandle');
    
    if (!sidebar || !handle) return;
    
    let isResizing = false;
    let startX, startWidth;
    
    // Load saved width
    const savedWidth = localStorage.getItem('mo-sidebar-width');
    if (savedWidth) {
        sidebar.style.width = savedWidth + 'px';
    }
    
    handle.addEventListener('mousedown', (e) => {
        isResizing = true;
        startX = e.clientX;
        startWidth = sidebar.offsetWidth;
        handle.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        
        const diff = e.clientX - startX;
        const newWidth = Math.min(Math.max(startWidth + diff, 160), 350);
        sidebar.style.width = newWidth + 'px';
    });
    
    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            handle.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            localStorage.setItem('mo-sidebar-width', sidebar.offsetWidth);
        }
    });
}

function showToast(message) {
    // Remove existing toast if any
    const existingToast = document.querySelector('.toast-notification');
    if (existingToast) existingToast.remove();

    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.textContent = message;
    document.body.appendChild(toast);
    
    // Animate in
    setTimeout(() => toast.classList.add('active'), 10);

    // Remove after 3 seconds
    setTimeout(() => {
        toast.classList.remove('active');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ============ System Monitoring ============
let systemPollInterval = null;

async function loadSystemHealth() {
    try {
        const res = await fetch(`${API_BASE}/system/health`);
        const data = await res.json();
        renderSystemHealth(data);
    } catch (e) {
        console.error('Failed to load system health:', e);
    }
}

function renderSystemHealth(data) {
    // CPU
    const cpuEl = document.getElementById('sysCpuUsage');
    const cpuBar = document.getElementById('sysCpuBar');
    const cpuDetail = document.getElementById('sysCpuDetail');
    if (cpuEl) {
        cpuEl.textContent = data.cpu.usage + '%';
        cpuBar.style.width = data.cpu.usage + '%';
        cpuBar.className = 'system-bar-fill cpu' + (data.cpu.usage > 80 ? ' critical' : data.cpu.usage > 60 ? ' warning' : '');
        cpuDetail.textContent = `${data.cpu.cores} cores · Load: ${data.cpu.loadAvg}`;
    }

    // Memory
    const memEl = document.getElementById('sysMemUsage');
    const memBar = document.getElementById('sysMemBar');
    const memDetail = document.getElementById('sysMemDetail');
    if (memEl) {
        memEl.textContent = data.memory.percent + '%';
        memBar.style.width = data.memory.percent + '%';
        memBar.className = 'system-bar-fill mem' + (data.memory.percent > 85 ? ' critical' : data.memory.percent > 70 ? ' warning' : '');
        const usedGB = (data.memory.usedMB / 1024).toFixed(1);
        const totalGB = (data.memory.totalMB / 1024).toFixed(0);
        memDetail.textContent = `${usedGB} / ${totalGB} GB`;
    }

    // Disk
    const diskEl = document.getElementById('sysDiskUsage');
    const diskBar = document.getElementById('sysDiskBar');
    const diskDetail = document.getElementById('sysDiskDetail');
    if (diskEl) {
        diskEl.textContent = data.disk.percent + '%';
        diskBar.style.width = data.disk.percent + '%';
        diskBar.className = 'system-bar-fill disk' + (data.disk.percent > 90 ? ' critical' : data.disk.percent > 75 ? ' warning' : '');
        diskDetail.textContent = `${data.disk.usedGB} / ${data.disk.totalGB} GB (${data.disk.freeGB} GB free)`;
    }

    // GPU
    const gpuEl = document.getElementById('sysGpuUsage');
    const gpuBar = document.getElementById('sysGpuBar');
    const gpuDetail = document.getElementById('sysGpuDetail');
    if (gpuEl && data.gpu && data.gpu.name) {
        gpuEl.textContent = data.gpu.utilization + '%';
        gpuBar.style.width = data.gpu.utilization + '%';
        gpuBar.className = 'system-bar-fill gpu' + (data.gpu.temp > 80 ? ' critical' : data.gpu.temp > 70 ? ' warning' : '');
        const gpuMemGB = (data.gpu.memUsed / 1024).toFixed(1);
        const gpuTotalGB = (data.gpu.memTotal / 1024).toFixed(0);
        gpuDetail.textContent = `${data.gpu.name} · ${data.gpu.temp}°C · ${gpuMemGB}/${gpuTotalGB} GB VRAM`;
    }

    // Uptime
    const uptimeEl = document.getElementById('sysUptime');
    if (uptimeEl) {
        uptimeEl.textContent = data.uptime.display;
    }

    // Services
    const svcMap = {
        svcKanban: data.services.kanban,
        svcBrain: data.services.secondBrain,
        svcOpenClaw: data.services.openclaw,
        svcOllama: data.services.ollama
    };
    for (const [id, up] of Object.entries(svcMap)) {
        const dot = document.getElementById(id);
        if (dot) {
            dot.className = 'service-dot ' + (up ? 'up' : 'down');
        }
    }

    // Top processes
    const procList = document.getElementById('sysProcesses');
    if (procList && data.topProcesses) {
        procList.innerHTML = data.topProcesses.map(p => `
            <div class="process-row">
                <span class="process-name">${p.name.split('/').pop()}</span>
                <span class="process-cpu">CPU ${p.cpu}%</span>
                <span class="process-mem">MEM ${p.mem}%</span>
            </div>
        `).join('');
    }

    // Last update
    const lastUpdate = document.getElementById('sysLastUpdate');
    if (lastUpdate) {
        lastUpdate.textContent = 'Last update: ' + new Date().toLocaleTimeString();
    }
}

async function loadUsageStats() {
    try {
        const res = await fetch(`${API_BASE}/system/usage`);
        const data = await res.json();
        renderUsageStats(data);
    } catch (e) {
        console.error('Failed to load usage stats:', e);
    }
}

function renderUsageStats(data) {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('usagePlan', data.subscription?.plan || '--');
    set('usageModel', data.subscription?.primaryModel || '--');
    set('usageSessions', data.sessions?.active || 0);
    set('usageActivity', data.activity?.todayCount || 0);
    set('usageAgents', `${data.agents?.active || 0}/${data.agents?.total || 0}`);
    set('usageDocs', data.knowledge?.brainDocs || 0);
    set('usageBackups', `${data.knowledge?.backups || 0} (${data.knowledge?.backupSize || '0'})`);
    set('usageCron', data.infrastructure?.cronJobs || 0);
    set('usageTodo', data.tasks?.todo || 0);
    set('usageProgress', data.tasks?.inProgress || 0);
    set('usageDone', data.tasks?.done || 0);
    set('usageArchive', data.tasks?.archive || 0);
}

function startSystemPolling() {
    if (systemPollInterval) return;
    systemPollInterval = setInterval(() => { loadSystemHealth(); loadUsageStats(); }, 10000);
}

function stopSystemPolling() {
    if (systemPollInterval) {
        clearInterval(systemPollInterval);
        systemPollInterval = null;
    }
}

// ============ Task Filtering ============
let activeFilter = 'all';
let filterText = '';

function setFilter(priority) {
    activeFilter = priority;
    document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
    document.querySelector(`.filter-pill[data-priority="${priority}"]`)?.classList.add('active');
    applyFilters();
}

function applyFilters() {
    document.querySelectorAll('.task-card').forEach(card => {
        let show = true;

        // Priority filter
        if (activeFilter !== 'all') {
            const hasPriority = card.classList.contains(`priority-${activeFilter}`);
            if (!hasPriority) show = false;
        }

        // Text filter
        if (filterText && show) {
            const title = card.querySelector('.task-title')?.textContent?.toLowerCase() || '';
            const desc = card.querySelector('.task-subtitle')?.textContent?.toLowerCase() || '';
            if (!title.includes(filterText) && !desc.includes(filterText)) show = false;
        }

        card.classList.toggle('filtered-out', !show);
    });
}

// Filter search input
document.addEventListener('DOMContentLoaded', () => {
    const filterInput = document.getElementById('filterSearch');
    if (filterInput) {
        filterInput.addEventListener('input', (e) => {
            filterText = e.target.value.toLowerCase();
            applyFilters();
        });
    }
});

// ============ Keyboard Shortcuts ============
let shortcutOverlay = null;

function showShortcuts() {
    if (shortcutOverlay) { hideShortcuts(); return; }
    const overlay = document.createElement('div');
    overlay.className = 'shortcut-overlay';
    overlay.onclick = hideShortcuts;
    overlay.innerHTML = `
        <div class="shortcut-panel" onclick="event.stopPropagation()">
            <h3>⌨️ Keyboard Shortcuts</h3>
            <div class="shortcut-row"><span class="shortcut-key">N</span><span class="shortcut-desc">New task</span></div>
            <div class="shortcut-row"><span class="shortcut-key">/</span><span class="shortcut-desc">Focus filter search</span></div>
            <div class="shortcut-row"><span class="shortcut-key">1-5</span><span class="shortcut-desc">Switch tab (Dashboard, System, History, Log, Feed)</span></div>
            <div class="shortcut-row"><span class="shortcut-key">R</span><span class="shortcut-desc">Refresh data</span></div>
            <div class="shortcut-row"><span class="shortcut-key">F</span><span class="shortcut-desc">Cycle priority filter</span></div>
            <div class="shortcut-row"><span class="shortcut-key">Esc</span><span class="shortcut-desc">Close modal / clear filter</span></div>
            <div class="shortcut-row"><span class="shortcut-key">?</span><span class="shortcut-desc">Show this help</span></div>
        </div>
    `;
    document.body.appendChild(overlay);
    shortcutOverlay = overlay;
}

function hideShortcuts() {
    if (shortcutOverlay) {
        shortcutOverlay.remove();
        shortcutOverlay = null;
    }
}

document.addEventListener('keydown', (e) => {
    // Don't trigger shortcuts when typing in inputs
    const tag = e.target.tagName;
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    if (e.key === 'Escape') {
        hideShortcuts();
        closeModal();
        if (isInput) {
            e.target.blur();
            const filterInput = document.getElementById('filterSearch');
            if (filterInput) { filterInput.value = ''; filterText = ''; applyFilters(); }
        }
        return;
    }

    if (isInput) return;

    switch (e.key) {
        case 'n':
        case 'N':
            e.preventDefault();
            openQuickAdd('todo');
            break;
        case '/':
            e.preventDefault();
            document.getElementById('filterSearch')?.focus();
            break;
        case '?':
            e.preventDefault();
            showShortcuts();
            break;
        case '1':
            e.preventDefault();
            document.querySelector('[data-tab="dashboard"]')?.click();
            break;
        case '2':
            e.preventDefault();
            document.querySelector('[data-tab="system"]')?.click();
            break;
        case '3':
            e.preventDefault();
            document.querySelector('[data-tab="history"]')?.click();
            break;
        case '4':
            e.preventDefault();
            document.querySelector('[data-tab="log"]')?.click();
            break;
        case '5':
            e.preventDefault();
            document.querySelector('[data-tab="feed"]')?.click();
            break;
        case 'r':
        case 'R':
            e.preventDefault();
            loadData();
            showToast('Data refreshed');
            break;
        case 'f':
        case 'F':
            e.preventDefault();
            const priorities = ['all', 'urgent', 'high', 'medium', 'low'];
            const nextIdx = (priorities.indexOf(activeFilter) + 1) % priorities.length;
            setFilter(priorities[nextIdx]);
            break;
    }
});

// ============ History / Archive View ============

let historyData = null;

async function loadHistory() {
    const q = document.getElementById('historySearch')?.value || '';
    const agent = document.getElementById('historyAgentFilter')?.value || '';
    const from = document.getElementById('historyDateFrom')?.value || '';
    const to = document.getElementById('historyDateTo')?.value || '';
    const status = document.getElementById('historyStatusFilter')?.value || 'done,archive';

    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (agent) params.set('agent', agent);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    params.set('status', status);

    try {
        const res = await fetch(`${API_BASE}/tasks/history?${params}`);
        historyData = await res.json();
        renderHistoryStats(historyData.stats);
        renderHistoryWeeks(historyData.weeks);
    } catch (e) {
        console.error('Failed to load history:', e);
        document.getElementById('historyWeeks').innerHTML = '<div class="history-loading">Failed to load history</div>';
    }
}

function renderHistoryStats(stats) {
    if (!stats) return;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('histStatTotal', stats.totalCompleted);
    set('histStatThisWeek', stats.thisWeek);
    set('histStatLastWeek', stats.lastWeek);
    set('histStatAvgTime', stats.avgCompletionTimeHours ? stats.avgCompletionTimeHours + 'h' : '--');
}

function renderHistoryWeeks(weeks) {
    const container = document.getElementById('historyWeeks');
    if (!container) return;

    if (!weeks || weeks.length === 0) {
        container.innerHTML = '<div class="history-loading">No completed tasks found</div>';
        return;
    }

    container.innerHTML = weeks.map(week => {
        const tasksHtml = week.tasks.map(task => `
            <div class="history-task-item priority-${task.priority || 'medium'}" onclick="openTaskDetail('${task.id}')">
                <div class="history-task-main">
                    <span class="history-task-priority ${task.priority || 'medium'}">${getPriorityEmoji(task.priority)}</span>
                    <span class="history-task-title">${escapeHtml(task.title)}</span>
                    <span class="history-task-status ${task.status}">${task.status}</span>
                </div>
                <div class="history-task-meta">
                    ${task.assignedTo ? `<span class="history-task-agent">${escapeHtml(task.assignedTo)}</span>` : ''}
                    ${task.completedAt ? `<span class="history-task-date">${new Date(task.completedAt).toLocaleDateString()}</span>` : ''}
                    ${task.completionNotes ? `<span class="history-task-notes" title="${escapeHtml(task.completionNotes)}">${escapeHtml(truncate(task.completionNotes, 60))}</span>` : ''}
                </div>
            </div>
        `).join('');

        return `
            <div class="history-week-group">
                <div class="history-week-header" onclick="this.parentElement.classList.toggle('collapsed')">
                    <span class="history-week-arrow">&#9660;</span>
                    <span class="history-week-label">${escapeHtml(week.weekLabel)}</span>
                    <span class="history-week-count">${week.tasks.length} task${week.tasks.length !== 1 ? 's' : ''}</span>
                </div>
                <div class="history-week-tasks">${tasksHtml}</div>
            </div>
        `;
    }).join('');
}

// Allow Enter key in history search
document.addEventListener('DOMContentLoaded', () => {
    const histSearch = document.getElementById('historySearch');
    if (histSearch) {
        histSearch.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); loadHistory(); }
        });
    }
});

// ============ Live Feed ============

async function loadFeed() {
    try {
        const res = await fetch(`${API_BASE}/feed?limit=500`);
        feedEntries = await res.json();
        // API returns chronological (oldest first) — sort to be sure
        feedEntries.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
        renderFeed();
    } catch (e) {
        console.error('Failed to load feed:', e);
        const container = document.getElementById('feedContainer');
        if (container) container.innerHTML = '<div class="feed-empty">Failed to load feed</div>';
    }
}

async function clearFeed() {
    try {
        await fetch(`${API_BASE}/feed`, { method: 'DELETE' });
        feedEntries = [];
        renderFeed();
    } catch (e) {
        console.error('Failed to clear feed:', e);
    }
}

function getFeedDateLabel(timestamp) {
    if (!timestamp) return '';
    const entryDate = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const entryDay = entryDate.toDateString();
    if (entryDay === today.toDateString()) return 'Today';
    if (entryDay === yesterday.toDateString()) return 'Yesterday';
    return entryDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function buildDateSeparatorHtml(label) {
    return `<div class="feed-date-separator"><span>${escapeHtml(label)}</span></div>`;
}

function renderFeed() {
    const container = document.getElementById('feedContainer');
    const countEl = document.getElementById('feedCount');
    if (!container) return;

    if (countEl) countEl.textContent = `${feedEntries.length} entries`;

    if (feedEntries.length === 0) {
        container.innerHTML = '<div class="feed-empty">No feed entries yet. Jarvis will post updates here as he works.</div>';
        return;
    }

    // Build HTML with date separators
    let html = '';
    let lastDateLabel = '';
    for (const entry of feedEntries) {
        const dateLabel = getFeedDateLabel(entry.timestamp);
        if (dateLabel !== lastDateLabel) {
            html += buildDateSeparatorHtml(dateLabel);
            lastDateLabel = dateLabel;
        }
        html += buildFeedEntryHtml(entry);
    }
    container.innerHTML = html;

    // Auto-scroll to bottom (newest)
    container.scrollTop = container.scrollHeight;
}

function renderFeedEntry(entry) {
    const container = document.getElementById('feedContainer');
    const countEl = document.getElementById('feedCount');
    if (!container) return;

    if (countEl) countEl.textContent = `${feedEntries.length} entries`;

    // Remove empty message if present
    const empty = container.querySelector('.feed-empty');
    if (empty) empty.remove();

    // Check if we need a new date separator
    const dateLabel = getFeedDateLabel(entry.timestamp);
    const lastEntry = feedEntries.length > 1 ? feedEntries[feedEntries.length - 2] : null;
    const lastDateLabel = lastEntry ? getFeedDateLabel(lastEntry.timestamp) : '';

    // Check if user is near bottom before modifying DOM
    const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;

    // Insert date separator if new day
    if (dateLabel !== lastDateLabel) {
        const sepDiv = document.createElement('div');
        sepDiv.innerHTML = buildDateSeparatorHtml(dateLabel);
        container.appendChild(sepDiv.firstElementChild);
    }

    // Append new entry at bottom (always newest at bottom)
    const div = document.createElement('div');
    div.innerHTML = buildFeedEntryHtml(entry);
    container.appendChild(div.firstElementChild);

    // Auto-scroll if user was near bottom
    if (isNearBottom) {
        container.scrollTop = container.scrollHeight;
    }
}

function buildFeedEntryHtml(entry) {
    const type = entry.type || 'working';
    const time = entry.timestamp ? formatTime(entry.timestamp) : '';
    const message = entry.message || '';
    const badgeLabel = type.replace(/-/g, ' ');

    return `
        <div class="feed-entry">
            <span class="feed-entry-time">${time}</span>
            <span class="feed-entry-badge ${escapeHtml(type)}">${escapeHtml(badgeLabel)}</span>
            <span class="feed-entry-message">${escapeHtml(message)}</span>
        </div>
    `;
}
