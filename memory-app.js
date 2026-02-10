/**
 * Jarvis Memory Dashboard - Frontend
 * Fetches memory data from the kanban server API and renders visualizations.
 */

const API = '';  // Same origin

// State
let factsPage = 1;
const factsLimit = 15;
let factsTotal = 0;
let goalsData = [];
let goalFilter = 'all';

// ==================== DATA FETCHING ====================

async function fetchJSON(url) {
  const res = await fetch(API + url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadStats() {
  const stats = await fetchJSON('/api/memory/stats');
  if (stats.error) return;

  document.getElementById('statFacts').textContent = stats.facts_count.toLocaleString();
  document.getElementById('statGoals').textContent = stats.goals_count.toLocaleString();
  document.getElementById('statConversations').textContent = stats.conversations_count.toLocaleString();
  document.getElementById('statConvToday').textContent = stats.conversations_today.toLocaleString();
  document.getElementById('statPreferences').textContent = stats.preferences_count.toLocaleString();
  document.getElementById('statDbSize').textContent = formatBytes(stats.database_size_bytes);

  renderConvChart(stats.conversations_by_day);
  renderCategoryBars(stats.facts_by_category);
}

async function loadGoals() {
  goalsData = await fetchJSON('/api/memory/goals');
  if (goalsData.error) { goalsData = []; return; }
  renderGoals();
}

async function loadFacts() {
  const data = await fetchJSON(`/api/memory/facts?page=${factsPage}&limit=${factsLimit}`);
  if (data.error) return;

  factsTotal = data.total;
  renderFacts(data.facts);
  updateFactsPagination();
}

async function loadConversations() {
  const days = document.getElementById('convDays').value;
  const data = await fetchJSON(`/api/memory/conversations?days=${days}`);
  if (data.error) return;
  renderConversations(data);
}

// ==================== RENDERING ====================

function renderConvChart(byDay) {
  const container = document.getElementById('convChart');
  const entries = Object.entries(byDay || {});

  if (entries.length === 0) {
    container.innerHTML = '<div class="chart-empty">No conversation data yet</div>';
    container.classList.remove('chart-container');
    return;
  }

  // Fill in missing days for last 30 days
  const days = [];
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    days.push({ date: key, count: byDay[key] || 0 });
  }

  const maxCount = Math.max(...days.map(d => d.count), 1);

  container.innerHTML = days.map(d => {
    const height = Math.max((d.count / maxCount) * 100, d.count > 0 ? 4 : 1);
    const shortDate = d.date.slice(5); // MM-DD
    return `<div class="chart-bar" style="height: ${height}%">
      <div class="chart-tooltip">${shortDate}: ${d.count} messages</div>
    </div>`;
  }).join('');
}

function renderCategoryBars(byCategory) {
  const container = document.getElementById('categoryBars');
  const entries = Object.entries(byCategory || {});

  if (entries.length === 0) {
    container.innerHTML = '<div class="empty-state">No categories yet</div>';
    return;
  }

  // Sort by count descending
  entries.sort((a, b) => b[1] - a[1]);
  const maxCount = entries[0][1];

  const colors = [
    'var(--accent-blue)', 'var(--accent-purple)', 'var(--accent-green)',
    'var(--accent-orange)', 'var(--accent-yellow)', 'var(--accent-red)',
  ];

  container.innerHTML = entries.map(([name, count], i) => {
    const pct = Math.max((count / maxCount) * 100, 8);
    const color = colors[i % colors.length];
    return `<div class="category-row">
      <span class="category-name" title="${name}">${name || 'uncategorized'}</span>
      <div class="category-bar-track">
        <div class="category-bar-fill" style="width: ${pct}%; background: ${color};">${count}</div>
      </div>
    </div>`;
  }).join('');
}

function renderGoals() {
  const container = document.getElementById('goalsTable');
  let filtered = goalsData;

  if (goalFilter !== 'all') {
    filtered = goalsData.filter(g => g.status === goalFilter);
  }

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state">No goals found</div>';
    return;
  }

  container.innerHTML = filtered.map(g => {
    const isCompleted = g.status === 'completed';
    const meta = [];
    if (g.deadline) meta.push(`Due: ${g.deadline}`);
    if (g.completed_at) meta.push(`Done: ${formatDate(g.completed_at)}`);
    meta.push(`Created: ${formatDate(g.created_at)}`);

    return `<div class="goal-item ${isCompleted ? 'completed-goal' : ''}">
      <div class="goal-priority ${g.priority || 'medium'}"></div>
      <div class="goal-content">
        <div class="goal-text">${escapeHtml(g.text)}</div>
        <div class="goal-meta">${meta.join(' &bull; ')}</div>
      </div>
      <span class="goal-status ${g.status}">${g.status}</span>
    </div>`;
  }).join('');
}

function renderFacts(facts) {
  const container = document.getElementById('factsTable');

  if (!facts || facts.length === 0) {
    container.innerHTML = '<div class="empty-state">No facts stored yet</div>';
    return;
  }

  container.innerHTML = facts.map(f => {
    return `<div class="fact-item">
      <span class="fact-category">${escapeHtml(f.category || 'general')}</span>
      <span class="fact-text">${escapeHtml(f.fact)}</span>
      <span class="fact-date">${formatDate(f.created_at)}</span>
    </div>`;
  }).join('');
}

function renderConversations(convs) {
  const container = document.getElementById('convList');

  if (!convs || convs.length === 0) {
    container.innerHTML = '<div class="empty-state">No conversations in this period</div>';
    return;
  }

  // Show newest first (API returns DESC)
  container.innerHTML = convs.map(c => {
    const content = c.content.length > 300 ? c.content.slice(0, 300) + '...' : c.content;
    return `<div class="conv-item ${c.role}">
      <span class="conv-role">${c.role}</span>
      <span class="conv-content">${escapeHtml(content)}</span>
      <span class="conv-time">${formatDateTime(c.created_at)}</span>
    </div>`;
  }).join('');
}

function updateFactsPagination() {
  const totalPages = Math.max(1, Math.ceil(factsTotal / factsLimit));
  document.getElementById('factsPageInfo').textContent = `${factsPage} / ${totalPages}`;
  document.getElementById('factsPrev').disabled = factsPage <= 1;
  document.getElementById('factsNext').disabled = factsPage >= totalPages;
}

// ==================== HELPERS ====================

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(dateStr) {
  if (!dateStr) return '--';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateTime(dateStr) {
  if (!dateStr) return '--';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ==================== EVENT HANDLERS ====================

// Goal filter buttons
document.getElementById('goalFilters').addEventListener('click', (e) => {
  if (!e.target.classList.contains('filter-btn')) return;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  e.target.classList.add('active');
  goalFilter = e.target.dataset.filter;
  renderGoals();
});

// Facts pagination
document.getElementById('factsPrev').addEventListener('click', () => {
  if (factsPage > 1) { factsPage--; loadFacts(); }
});
document.getElementById('factsNext').addEventListener('click', () => {
  const totalPages = Math.ceil(factsTotal / factsLimit);
  if (factsPage < totalPages) { factsPage++; loadFacts(); }
});

// Conversation days selector
document.getElementById('convDays').addEventListener('change', loadConversations);

// Refresh button
document.getElementById('refreshBtn').addEventListener('click', refreshAll);

// ==================== INIT ====================

async function refreshAll() {
  const btn = document.getElementById('refreshBtn');
  btn.style.opacity = '0.5';

  try {
    await Promise.all([
      loadStats(),
      loadGoals(),
      loadFacts(),
      loadConversations(),
    ]);
  } catch (err) {
    console.error('Refresh error:', err);
  }

  btn.style.opacity = '1';
  const now = new Date();
  document.getElementById('refreshStatus').textContent =
    `Last refresh: ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
}

// Initial load
refreshAll();

// Auto-refresh every 60 seconds
setInterval(refreshAll, 60000);
