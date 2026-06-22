// ============================================================
// DSkin Cashup — Main Application
// ============================================================

let db;
let _clockInterval = null;

function startLiveClock() {
  const el = document.getElementById('cashup-live-time');
  if (!el) return;
  function tick() {
    const now = new Date();
    el.textContent = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
  }
  tick();
  if (_clockInterval) clearInterval(_clockInterval);
  _clockInterval = setInterval(tick, 1000);
}

function stopLiveClock() {
  if (_clockInterval) { clearInterval(_clockInterval); _clockInterval = null; }
  const el = document.getElementById('cashup-live-time');
  if (el) el.textContent = '';
}
let state = {
  branches: [],
  currentBranch: null,
  pinBuffer: '',
  activeDate: null,
  isAdmin: false,
  adminPIN: null,
  cameFromAdmin: false,
  autocompleteData: { products: [], staff: [], names: [] },
  staffList: [],
  existingSummaryId: null,
  lastCalculatedClosing: 0,
  openingBalance: 0,
  // Payment modes available for sales entries — admin-editable, loaded from DB.
  // 'cash' is required (the cash/non-cash split depends on it).
  paymentModes: [
    { code: 'cash', label: 'Cash' },
    { code: 'scan', label: 'Scan' },
    { code: 'upi', label: 'UPI' },
    { code: 'icici_machine', label: 'ICICI Machine' },
    { code: 'pinelab', label: 'PINELAB' },
    { code: 'bajaj_finance', label: 'Bajaj Finance' },
    { code: 'savein', label: 'SaveIN' },
    { code: 'cheque', label: 'Cheque' },
  ],
};

// ============================================================
// ROUTING + SESSION PERSISTENCE
// Keeps the user logged in and on the same page across refresh,
// and gives every page a real URL (browser back/forward works).
// ============================================================
const SESSION_KEY = 'clinix_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // auto sign-out after 24h

function saveSession(auth, branchId) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ auth, branchId: branchId || null, ts: Date.now() }));
  } catch (e) {}
}
function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!s) return null;
    if (Date.now() - (s.ts || 0) > SESSION_TTL_MS) { clearSession(); return null; }
    return s;
  } catch (e) { return null; }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
}

// Update the URL hash without re-triggering the router (counter handles
// multiple synchronous setRoute calls from nested navigation).
let _suppressHash = 0;
function setRoute(hash) {
  if (location.hash === hash) return;
  _suppressHash++;
  location.hash = hash;
}

function showHome() {
  state.currentBranch = null;
  state.isAdmin = false;
  state.cameFromAdmin = false;
  state.pinBuffer = '';
  showScreen('home');
  loadBranches();
  setRoute('#/');
}

function logout() {
  clearSession();
  showHome();
}

function restoreBranchContext(sess) {
  if (!sess || !sess.branchId) return false;
  const b = state.branches.find(x => x.id === sess.branchId);
  if (!b) return false;
  state.currentBranch = b;
  state.isAdmin = sess.auth === 'admin';
  return true;
}

// Render the correct screen from the current URL hash. Runs on first load
// (to restore where the user was) and on browser back/forward.
async function routeFromHash() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  const root = parts[0] || '';
  const sess = loadSession();

  if (root === 'admin') {
    if (!sess || sess.auth !== 'admin') { showHome(); return; }
    state.isAdmin = true;
    await openAdminPanel();
    const tab = parts[1] || 'overview';
    if (tab !== 'overview') switchAdminTab(tab);
    return;
  }
  if (root === 'branch') {
    if (!restoreBranchContext(sess)) { showHome(); return; }
    if (!state.activeDate) state.activeDate = getISTDate();
    await openDashboard();
    const page = parts[1] || 'cashup';
    if (page !== 'cashup') switchBranchTab(page);
    return;
  }
  if (root === 'cashup') {
    if (!restoreBranchContext(sess)) { showHome(); return; }
    const date = parts[1] || getISTDate();
    state.activeDate = date;
    await openDashboard();       // so "back" from the form lands on the dashboard
    await openCashupForm(date);
    return;
  }
  // No/unknown hash → resume an active session if present, else show home.
  if (sess && sess.auth === 'admin') { state.isAdmin = true; await openAdminPanel(); return; }
  if (restoreBranchContext(sess)) { if (!state.activeDate) state.activeDate = getISTDate(); await openDashboard(); return; }
  showHome();
}

// Branch side-panel tab switching (Daily Cashup / Emails / Leads)
function activateBranchTab(page) {
  document.querySelectorAll('.branch-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('[data-btab]').forEach(b => b.classList.remove('active'));
  document.getElementById('branch-tab-' + page)?.classList.add('active');
  document.querySelectorAll('[data-btab="' + page + '"]').forEach(b => b.classList.add('active'));
}
function switchBranchTab(page) {
  activateBranchTab(page);
  setRoute('#/branch/' + page);
  if (page === 'leads') loadLeadsTab();
}

// Admin tab switching (global so the router can restore a tab on refresh)
function switchAdminTab(tab) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.sidebar-item[data-tab]').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.bottom-nav-item[data-tab]').forEach(b => b.classList.remove('active'));
  const tabEl = document.getElementById('admin-tab-' + tab);
  if (tabEl) tabEl.classList.add('active');
  document.querySelectorAll('[data-tab="' + tab + '"]').forEach(b => b.classList.add('active'));
  if (tab === 'reports') initReportsTab();
  if (tab === 'notifications') loadAdminAlerts();
  if (tab === 'settings') { loadAutomations(); renderPaymentModesList(); }
  setRoute('#/admin/' + tab);
}

// ============================================================
// LEAD HUB — Unified Inbox
// ============================================================

let _leads = [];
let _activeLeadId = null;
let _leadsTabBound = false;

async function loadLeadsTab() {
  const list = document.getElementById('leads-list');
  if (list) list.innerHTML = '<div class="loading-wrap"><div class="spinner"></div></div>';

  if (!_leadsTabBound) {
    _leadsTabBound = true;
    document.getElementById('btn-lead-back')?.addEventListener('click', closeLeadDetail);
    document.getElementById('btn-convo-log')?.addEventListener('click', sendLeadMessage);
    document.getElementById('leads-convo-input')?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendLeadMessage(); }
    });
  }

  console.log('[leads] currentBranch.id =', state.currentBranch?.id);

  const { data: leads, error } = await db
    .from('leads')
    .select('id, customer_name, source, status, created_at, branch_id')
    .eq('branch_id', state.currentBranch.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[leads query]', error.message);
    if (list) list.innerHTML = `<p style="color:var(--danger);padding:16px;font-size:13px;text-align:center">${esc(error.message)}</p>`;
    return;
  }

  console.log('Leads returned:', leads);
  _leads = leads || [];

  if (!_leads.length) {
    renderConversationList(_leads, {});
    return;
  }

  // Fetch last message + unread counts in a single query
  const { data: msgs } = await db
    .from('lead_messages')
    .select('lead_id, message, direction, created_at, is_seen')
    .in('lead_id', _leads.map(l => l.id))
    .order('created_at', { ascending: false });

  console.log('Messages returned:', msgs);

  const lastMsg     = {};
  const unreadCount = {};
  (msgs || []).forEach(m => {
    if (!lastMsg[m.lead_id]) lastMsg[m.lead_id] = m;
    if (['in', 'incoming'].includes(m.direction) && !m.is_seen) {
      unreadCount[m.lead_id] = (unreadCount[m.lead_id] || 0) + 1;
    }
  });

  console.log('Conversation list (lastMsg map):', lastMsg);
  renderConversationList(_leads, lastMsg, unreadCount);
}

function renderConversationList(leads, lastMsg, unreadCount = {}) {
  const list = document.getElementById('leads-list');
  if (!list) return;

  if (!leads.length) {
    list.innerHTML = `
      <div class="leads-empty-state">
        <div class="leads-empty-icon">💬</div>
        <div class="leads-empty-title">No conversations yet</div>
        <div class="leads-empty-sub">Messages from Instagram and Facebook will appear here</div>
      </div>`;
    return;
  }

  list.innerHTML = leads.map(lead => {
    const msg    = lastMsg[lead.id];
    const prev   = msg ? esc(msg.message.length > 50 ? msg.message.slice(0, 50) + '…' : msg.message) : '<em>No messages</em>';
    const time   = msg ? formatConvoTime(msg.created_at) : '';
    const count  = unreadCount[lead.id] || 0;
    const src    = (lead.source || '').toLowerCase();
    const label  = src === 'instagram' ? 'IG' : src === 'facebook' ? 'FB' : (lead.source || '?').slice(0, 2).toUpperCase();

    return `
    <div class="lead-card ${count > 0 ? 'has-unread' : ''}" data-lead-id="${esc(lead.id)}" onclick="openLeadDetail('${esc(lead.id)}')">
      <div class="conv-platform-icon ${esc(src)}">${label}</div>
      <div class="lead-card-info">
        <div class="lead-card-row1">
          <span class="lead-card-name">${esc(lead.customer_name)}</span>
          <span class="lead-card-time ${count > 0 ? 'unread-time' : ''}">${time}</span>
        </div>
        <div class="lead-card-row2">
          <span class="lead-card-preview ${count > 0 ? 'unread-preview' : ''}">${prev}</span>
          ${count > 0 ? '<span class="lead-unread-dot"></span>' : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

function openLeadDetail(leadId) {
  const lead = _leads.find(l => l.id === leadId);
  if (!lead) return;

  document.querySelectorAll('.lead-card').forEach(c => c.classList.remove('active'));
  document.querySelector(`.lead-card[data-lead-id="${leadId}"]`)?.classList.add('active');

  const src   = (lead.source || '').toLowerCase();
  const label = src === 'instagram' ? 'IG' : src === 'facebook' ? 'FB' : src === 'whatsapp' ? 'WA' : (lead.source || '?').slice(0, 2).toUpperCase();

  document.getElementById('lead-detail-name').textContent  = lead.customer_name;

  const avatar = document.getElementById('lead-header-avatar');
  if (avatar) { avatar.textContent = label; avatar.className = 'conv-header-avatar ' + src; }

  const platformLabel = document.getElementById('lead-platform-label');
  if (platformLabel) platformLabel.textContent = lead.source || '';

  _activeLeadId = leadId;
  markConversationSeen(leadId);

  document.getElementById('leads-convo-log').innerHTML = '';
  document.getElementById('leads-detail-empty').style.display   = 'none';
  document.getElementById('leads-detail-content').style.display = 'flex';
  document.getElementById('leads-detail-col').classList.add('active');
  loadLeadMessages(leadId);
}

function closeLeadDetail() {
  _activeLeadId = null;
  document.getElementById('leads-detail-empty').style.display   = 'flex';
  document.getElementById('leads-detail-content').style.display = 'none';
  document.getElementById('leads-detail-col').classList.remove('active');
  document.querySelectorAll('.lead-card').forEach(c => c.classList.remove('active'));
}

async function markConversationSeen(leadId) {
  const card = document.querySelector(`.lead-card[data-lead-id="${leadId}"]`);
  if (card) {
    card.classList.remove('has-unread');
    card.querySelector('.lead-unread-dot')?.remove();
    const t = card.querySelector('.lead-card-time');
    const p = card.querySelector('.lead-card-preview');
    if (t) t.classList.remove('unread-time');
    if (p) p.classList.remove('unread-preview');
  }

  await db
    .from('lead_messages')
    .update({ is_seen: true, seen_at: new Date().toISOString() })
    .eq('lead_id', leadId)
    .in('direction', ['in', 'incoming'])
    .eq('is_seen', false);
}

async function loadLeadMessages(leadId) {
  const log = document.getElementById('leads-convo-log');
  if (!log) return;

  const { data, error } = await db
    .from('lead_messages')
    .select('id, direction, message, created_at')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[lead_messages query]', error.message);
    log.innerHTML = `<div class="leads-convo-empty">${esc(error.message)}</div>`;
    return;
  }

  if (!data || !data.length) {
    log.innerHTML = '<div class="leads-convo-empty">No messages yet</div>';
    return;
  }

  const lead        = _leads.find(l => l.id === leadId);
  const src         = (lead?.source || '').toLowerCase();
  const avatarLabel = src === 'instagram' ? 'IG' : src === 'facebook' ? 'FB' : src === 'whatsapp' ? 'WA' : (lead?.source || '?').slice(0, 2).toUpperCase();

  let lastDate = null;
  log.innerHTML = data.map(m => {
    const isIncoming = ['in', 'incoming'].includes(m.direction);
    const msgDate    = m.created_at.split('T')[0];
    const separator  = msgDate !== lastDate
      ? `<div class="convo-date-sep"><span>${formatDateSeparator(msgDate)}</span></div>`
      : '';
    lastDate = msgDate;
    const timeStr = new Date(m.created_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
    return `${separator}
    <div class="leads-convo-msg ${isIncoming ? 'incoming' : 'outgoing'} convo-msg-anim">
      ${isIncoming ? `<div class="convo-msg-avatar ${esc(src)}">${esc(avatarLabel)}</div>` : ''}
      <div class="convo-msg-body">
        <div class="leads-convo-msg-text">${esc(m.message)}</div>
        <div class="leads-convo-msg-meta">${timeStr}</div>
      </div>
    </div>`;
  }).join('');

  log.scrollTop = log.scrollHeight;
}

async function sendLeadMessage() {
  if (!_activeLeadId) return;
  const input = document.getElementById('leads-convo-input');
  const body  = input.value.trim();
  if (!body) return;

  const btn    = document.getElementById('btn-convo-log');
  btn.disabled = true;

  const { error } = await db.from('lead_messages').insert({
    lead_id:   _activeLeadId,
    direction: 'outgoing',
    message:   body,
  });

  btn.disabled = false;

  if (error) {
    console.error('Send message error:', error);
    showToast(error.message || 'Could not send message.', 'error');
    return;
  }

  input.value = '';
  await loadLeadMessages(_activeLeadId);
}

// ============================================================
// INIT
// ============================================================

async function init() {
  const cfgRes = await fetch('/.netlify/functions/get-config');
  if (!cfgRes.ok) throw new Error('Failed to load app config — check Netlify env vars');
  const { supabaseUrl, supabaseAnonKey } = await cfgRes.json();
  db = window.supabase.createClient(supabaseUrl, supabaseAnonKey);
  await Promise.all([loadBranches(), loadAdminPIN(), loadPaymentModes()]);
  bindGlobalEvents();
  window.addEventListener('hashchange', () => {
    if (_suppressHash > 0) { _suppressHash--; return; }
    routeFromHash();
  });
  await routeFromHash();   // restore where the user left off
}

async function loadAdminPIN() {
  const { data } = await db.from('settings').select('value').eq('key', 'admin_pin').single();
  state.adminPIN = data?.value || null;
}

// ============================================================
// PAYMENT MODES (admin-editable, stored in settings.payment_modes)
// ============================================================
async function loadPaymentModes() {
  try {
    const { data } = await db.from('settings').select('value').eq('key', 'payment_modes').single();
    if (data && data.value) {
      const arr = JSON.parse(data.value);
      if (Array.isArray(arr) && arr.length) {
        // 'cash' must always exist (cash/non-cash split relies on it)
        if (!arr.some(m => m.code === 'cash')) arr.unshift({ code: 'cash', label: 'Cash' });
        state.paymentModes = arr;
      }
    }
  } catch (e) { /* fall back to defaults already in state */ }
  rebuildPaymentLabels();
}

async function savePaymentModesToDB() {
  await db.from('settings').upsert(
    { key: 'payment_modes', value: JSON.stringify(state.paymentModes) },
    { onConflict: 'key' }
  );
  rebuildPaymentLabels();
}

function rebuildPaymentLabels() {
  // Merge, don't reset: PT_LABEL keeps labels for every mode ever known (incl. the
  // built-in defaults), so historical entries that used a since-removed mode still
  // display its proper name instead of the raw code. Stored entry values are never changed.
  state.paymentModes.forEach(m => { PT_LABEL[m.code] = m.label; });
}

// Build <option> HTML for an entry's payment-type select from the current modes.
// Always includes the row's existing value even if that mode was later removed.
function paymentModeOptions(selected) {
  const modes = state.paymentModes.slice();
  if (selected && !modes.some(m => m.code === selected)) {
    modes.push({ code: selected, label: (PT_LABEL[selected] || selected) });
  }
  const sel = selected || 'cash';
  return modes.map(m =>
    `<option value="${esc(m.code)}" ${m.code === sel ? 'selected' : ''}>${esc(m.label)}</option>`
  ).join('');
}

// Admin Settings — Payment Modes management
function renderPaymentModesList() {
  const el = document.getElementById('payment-modes-list');
  if (!el) return;
  el.innerHTML = state.paymentModes.map(m => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px">
      <span style="font-weight:600">${esc(m.label)}</span>
      ${m.code === 'cash'
        ? '<span style="font-size:12px;color:#9ca3af">Required</span>'
        : `<button class="del-row-btn" onclick="removePaymentMode('${esc(m.code)}')" title="Remove">×</button>`}
    </div>`).join('');
}

async function addPaymentMode() {
  const input = document.getElementById('new-payment-mode-input');
  const label = (input?.value || '').trim();
  if (!label) { showToast('Enter a mode name', 'error'); return; }
  const code = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!code) { showToast('Invalid mode name', 'error'); return; }
  if (state.paymentModes.some(m => m.code === code)) { showToast('That mode already exists', 'error'); return; }
  state.paymentModes.push({ code, label });
  await savePaymentModesToDB();
  if (input) input.value = '';
  renderPaymentModesList();
  showToast('Payment mode added ✓', 'success');
}

async function removePaymentMode(code) {
  if (code === 'cash') return; // required
  state.paymentModes = state.paymentModes.filter(m => m.code !== code);
  await savePaymentModesToDB();
  renderPaymentModesList();
  showToast('Payment mode removed ✓', 'success');
}

// ============================================================
// SCREEN NAVIGATION
// ============================================================

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById('screen-' + name);
  if (el) el.classList.add('active');
}

// ============================================================
// HOME — BRANCH LOADING
// ============================================================

async function loadBranches() {
  const { data, error } = await db
    .from('branches')
    .select('*')
    .eq('active', true)
    .order('name');

  if (error) {
    document.getElementById('branch-grid').innerHTML =
      '<p style="color:#e53935;padding:20px;text-align:center">Could not load branches. Check Supabase config.</p>';
    return;
  }

  state.branches = data;
  renderBranchCards(data);
}

function renderBranchCards(branches) {
  const grid = document.getElementById('branch-grid');
  grid.innerHTML = branches.map((b) => `
    <div class="branch-card" data-branch-id="${b.id}">
      <div class="branch-card-left">
        <div class="branch-icon">
          <img src="dskin-logo.png" style="width:36px;height:auto;opacity:0.85" alt="">
        </div>
        <div>
          <div class="branch-name">${esc(b.name)}</div>
          <div class="branch-sub">Tap to continue</div>
        </div>
      </div>
      <div class="branch-arrow">›</div>
    </div>
  `).join('');

  grid.querySelectorAll('.branch-card').forEach(card => {
    card.addEventListener('click', () => {
      const branch = branches.find(b => b.id === card.dataset.branchId);
      selectBranch(branch);
    });
  });
}

// ============================================================
// PIN ENTRY
// ============================================================

function selectBranch(branch) {
  state.currentBranch = branch;
  state.pinBuffer = '';
  document.getElementById('pin-branch-name').textContent = branch.name;
  document.getElementById('pin-error').textContent = '';
  updatePinDots();
  showScreen('pin');
}

function updatePinDots() {
  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById('d' + i);
    dot.className = 'pin-dot';
    if (i < state.pinBuffer.length) dot.classList.add('filled');
  }
}

async function verifyPIN() {
  const entered = state.pinBuffer;

  if (state.adminPIN && entered === state.adminPIN) {
    // Admin PIN — open admin panel
    state.isAdmin = true;
    state.cameFromAdmin = false;
    saveSession('admin', null);
    await openAdminPanel();
  } else if (entered === state.currentBranch.pin) {
    // Branch PIN — open dashboard
    state.isAdmin = false;
    state.cameFromAdmin = false;
    state.activeDate = getISTDate();
    saveSession('branch', state.currentBranch.id);
    await openDashboard();
  } else {
    // Wrong
    document.getElementById('pin-error').textContent = 'Incorrect PIN. Try again.';
    document.querySelectorAll('.pin-dot').forEach(d => {
      d.classList.add('error');
      setTimeout(() => { d.classList.remove('error', 'filled'); }, 600);
    });
    state.pinBuffer = '';
    setTimeout(() => updatePinDots(), 650);
  }
}

// ============================================================
// ADMIN PANEL (PIN-based)
// ============================================================

async function openAdminPanel() {
  showScreen('admin-panel');
  setRoute('#/admin/overview');
  // Always open on Overview tab
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.sidebar-item[data-tab], .bottom-nav-item[data-tab]').forEach(b => b.classList.remove('active'));
  document.getElementById('admin-tab-overview')?.classList.add('active');
  document.querySelectorAll('[data-tab="overview"]').forEach(b => b.classList.add('active'));

  await Promise.all([loadAdminBranches(), loadAdminStats(), loadAdminAlerts()]);
}

async function loadAdminAlerts() {
  const list = document.getElementById('admin-alerts-list');
  const badge = document.getElementById('admin-alert-badge');
  if (!list) return;

  const [{ data: alerts }, { data: feedbacks }] = await Promise.all([
    db.from('cashup_alerts').select('*').eq('is_read', false).order('created_at', { ascending: false }),
    db.from('cashup_feedback').select('*').eq('is_read', false).order('created_at', { ascending: false }),
  ]);

  function updateBadges(count) {
    const show = count > 0;
    [badge, ...['sidebar-notif-badge','bottom-notif-badge'].map(id => document.getElementById(id))].forEach(b => {
      if (!b) return;
      b.textContent = count;
      b.style.display = show ? 'inline-flex' : 'none';
    });
  }

  const totalCount = (alerts?.length || 0) + (feedbacks?.length || 0);

  if (totalCount === 0) {
    updateBadges(0);
    list.innerHTML = `
      <div style="text-align:center;padding:40px 20px;color:#9ca3af">
        <div style="font-size:32px;margin-bottom:10px">🔔</div>
        <div style="font-weight:600;color:#374151;margin-bottom:4px">No notifications</div>
        <div style="font-size:13px">You're all caught up</div>
      </div>`;
    return;
  }

  updateBadges(totalCount);

  const timeAgo = (ts) => {
    const diff = Math.floor((Date.now() - new Date(ts)) / 60000);
    if (diff < 1) return 'Just now';
    if (diff < 60) return diff + 'm ago';
    if (diff < 1440) return Math.floor(diff/60) + 'h ago';
    return Math.floor(diff/1440) + 'd ago';
  };

  const alertRows = (alerts || []).map(a => {
    const varAmt = parseFloat(a.variance) || 0;
    const isOver = varAmt > 0;
    const varLabel = Math.abs(varAmt) < 0.01 ? 'No variance' :
      (isOver ? `+${formatCurrency(varAmt)} over` : `${formatCurrency(Math.abs(varAmt))} short`);
    const varClass = isOver ? 'variance-positive' : 'variance-negative';
    return `
      <div class="notif-row">
        <div class="notif-tag notif-tag-variance">Variance</div>
        <div class="notif-body">
          <div class="notif-title">${esc(a.branch_name)} &mdash; ${formatDisplayDate(a.entry_date)}</div>
          <div class="notif-detail ${varClass}">${varLabel}</div>
          <div class="notif-meta">Calculated ${formatCurrency(a.calculated_closing)} &nbsp;·&nbsp; Actual ${formatCurrency(a.actual_closing)}</div>
        </div>
        <div class="notif-right">
          <div class="notif-time">${timeAgo(a.created_at)}</div>
          <button class="notif-dismiss" onclick="markAlertRead('${a.id}')" title="Dismiss">✕</button>
        </div>
      </div>`;
  });

  const feedbackRows = (feedbacks || []).map(f => {
    const byLine = f.submitted_by ? ` · ${esc(f.submitted_by)}` : '';
    return `
      <div class="notif-row">
        <div class="notif-tag notif-tag-feedback">Feedback</div>
        <div class="notif-body">
          <div class="notif-title">${esc(f.branch_name)} &mdash; ${formatDisplayDate(f.entry_date)}${byLine}</div>
          <div class="notif-detail" style="color:#374151">${esc(f.feedback_text)}</div>
        </div>
        <div class="notif-right">
          <div class="notif-time">${timeAgo(f.created_at)}</div>
          <button class="notif-dismiss" onclick="markFeedbackRead('${f.id}')" title="Dismiss">✕</button>
        </div>
      </div>`;
  });

  list.innerHTML = [...alertRows, ...feedbackRows].join('');
}

async function markFeedbackRead(feedbackId) {
  await db.from('cashup_feedback').update({ is_read: true }).eq('id', feedbackId);
  await loadAdminAlerts();
  showToast('Feedback dismissed');
}

async function markAlertRead(alertId) {
  await db.from('cashup_alerts').update({ is_read: true }).eq('id', alertId);
  await loadAdminAlerts();
  showToast('Alert dismissed');
}

// ============================================================
// FEEDBACK
// ============================================================

function openFeedbackModal() {
  const modal = document.getElementById('modal-feedback');
  if (!modal) return;
  document.getElementById('feedback-text').value = '';
  document.getElementById('feedback-name').value = '';
  modal.style.display = 'flex';
}

document.addEventListener('DOMContentLoaded', () => {
  const cancelBtn = document.getElementById('btn-feedback-cancel');
  const submitBtn = document.getElementById('btn-feedback-submit');
  const modal = document.getElementById('modal-feedback');
  if (cancelBtn) cancelBtn.addEventListener('click', () => { if (modal) modal.style.display = 'none'; });
  if (submitBtn) submitBtn.addEventListener('click', submitFeedback);
});

async function submitFeedback() {
  const text = document.getElementById('feedback-text')?.value?.trim();
  const name = document.getElementById('feedback-name')?.value?.trim() || '';
  const modal = document.getElementById('modal-feedback');
  if (!text) { showToast('Please enter your feedback', 'error'); return; }

  const branch = state.currentBranch;
  const date = state.activeDate;
  if (!branch || !date) { showToast('Cannot submit — branch or date missing', 'error'); return; }

  const { error } = await db.from('cashup_feedback').insert({
    branch_id: branch.id,
    branch_name: branch.name,
    entry_date: date,
    feedback_text: text,
    submitted_by: name,
  });

  if (error) { showToast('Failed to submit feedback', 'error'); return; }
  if (modal) modal.style.display = 'none';
  showToast('Feedback submitted', 'success');

  // Send email notification (fire-and-forget)
  fetch('/.netlify/functions/send-feedback-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      branch_name: branch.name,
      entry_date: date,
      feedback_text: text,
      submitted_by: name,
    }),
  }).catch(() => {}); // silent fail — DB record already saved
}

async function loadAdminBranches() {
  const { data: branches } = await db.from('branches').select('*').order('name');
  state.branches = branches || [];

  const list = document.getElementById('admin-branches-list');
  if (!branches?.length) {
    list.innerHTML = '<p style="padding:20px;color:#6b7280">No branches yet.</p>';
    return;
  }

  list.innerHTML = branches.map(b => `
    <div class="admin-branch-row">
      <div style="flex:1;min-width:0">
        <div class="admin-branch-name">${esc(b.name)}</div>
        <div class="admin-branch-pin">${b.state ? esc(b.state) + ' · ' : ''}PIN: ${esc(b.pin)}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
        <button class="icon-text-btn branch-gear-btn" title="Edit branch" onclick="editBranch('${b.id}','${esc(b.name)}','${esc(b.pin)}','${esc(b.state||'')}')">⚙️</button>
        <button class="link-btn" onclick="viewBranchAsAdmin('${b.id}')" style="color:#C4922A">View →</button>
        <button class="danger-btn" onclick="deleteBranch('${b.id}','${esc(b.name)}')">🗑</button>
      </div>
    </div>
  `).join('');
}

async function viewBranchAsAdmin(branchId) {
  const branch = state.branches.find(b => b.id === branchId);
  if (!branch) return;
  state.currentBranch = branch;
  state.cameFromAdmin = true;
  state.activeDate = getISTDate();
  saveSession('admin', branch.id);   // keep admin auth, remember which branch we're viewing
  await openDashboard();
}

// Overview KPI state — selectedBranches is array of ids, or ['all']
const ovState = { selectedBranches: ['all'], period: 'week', from: null, to: null };

async function loadAdminStats() {
  initOverviewDropdowns();
  await refreshAdminKPIs();
}

function initOverviewDropdowns() {
  // ── Branch multi-select ──
  const trigger = document.getElementById('ov-branch-trigger');
  const dropdown = document.getElementById('ov-branch-dropdown');
  const optionsWrap = document.getElementById('ov-branch-options');
  const checkAll = document.getElementById('ov-check-all');
  const labelEl = document.getElementById('ov-branch-label');
  if (!trigger || !dropdown) return;

  // Populate branch checkboxes
  optionsWrap.innerHTML = '';
  state.branches.forEach(b => {
    const lbl = document.createElement('label');
    lbl.className = 'ov-ms-option';
    lbl.innerHTML = `<input type="checkbox" value="${b.id}"><span>${esc(b.name)}</span>`;
    optionsWrap.appendChild(lbl);
  });

  function updateBranchLabel() {
    if (ovState.selectedBranches.includes('all') || !ovState.selectedBranches.length) {
      labelEl.textContent = 'All Branches';
    } else if (ovState.selectedBranches.length === 1) {
      const b = state.branches.find(x => x.id === ovState.selectedBranches[0]);
      labelEl.textContent = b ? b.name : '1 branch';
    } else {
      labelEl.textContent = ovState.selectedBranches.length + ' branches';
    }
  }

  function syncCheckboxState() {
    const isAll = ovState.selectedBranches.includes('all') || !ovState.selectedBranches.length;
    checkAll.checked = isAll;
    checkAll.indeterminate = false;
    optionsWrap.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.checked = isAll || ovState.selectedBranches.includes(cb.value);
    });
  }

  // Toggle dropdown
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = dropdown.style.display !== 'none';
    dropdown.style.display = open ? 'none' : 'block';
    trigger.classList.toggle('open', !open);
  });
  document.addEventListener('click', (e) => {
    if (!document.getElementById('ov-branch-multiselect')?.contains(e.target)) {
      dropdown.style.display = 'none';
      trigger.classList.remove('open');
    }
  });

  // "All" checkbox
  checkAll.addEventListener('change', () => {
    ovState.selectedBranches = ['all'];
    syncCheckboxState();
    updateBranchLabel();
    refreshAdminKPIs();
  });

  // Individual branch checkboxes
  optionsWrap.addEventListener('change', (e) => {
    const cb = e.target;
    const checked = [...optionsWrap.querySelectorAll('input:checked')].map(c => c.value);
    if (checked.length === 0) {
      ovState.selectedBranches = ['all'];
    } else {
      ovState.selectedBranches = checked;
    }
    checkAll.checked = ovState.selectedBranches.includes('all') || checked.length === state.branches.length;
    updateBranchLabel();
    refreshAdminKPIs();
  });

  syncCheckboxState();
  updateBranchLabel();

  // ── Period dropdown ──
  const periodSel = document.getElementById('ov-period-select');
  if (!periodSel) return;
  periodSel.value = 'week';
  ovState.period = 'week';
  periodSel.addEventListener('change', () => {
    ovState.period = periodSel.value;
    const customEl = document.getElementById('ov-custom-range');
    customEl.style.display = ovState.period === 'custom' ? 'block' : 'none';
    if (ovState.period !== 'custom') refreshAdminKPIs();
  });

  // Custom date inputs
  document.getElementById('ov-date-from')?.addEventListener('change', e => {
    ovState.from = e.target.value; refreshAdminKPIs();
  });
  document.getElementById('ov-date-to')?.addEventListener('change', e => {
    ovState.to = e.target.value; refreshAdminKPIs();
  });
}

async function refreshAdminKPIs() {
  const grid = document.getElementById('admin-kpi-grid');
  if (!grid) return;
  grid.innerHTML = `<div class="loading-wrap" style="padding:20px;grid-column:1/-1"><div class="spinner"></div></div>`;

  const today = getISTDate();
  const ranges = getDateRanges(today);

  let from, to, label;
  switch (ovState.period) {
    case 'week':   from = ranges.weekStart;   to = ranges.weekEnd;   label = 'This Week'; break;
    case 'month':  from = ranges.monthStart;  to = ranges.monthEnd;  label = 'This Month'; break;
    case 'lweek':  from = ranges.lWeekStart;  to = ranges.lWeekEnd;  label = 'Last Week'; break;
    case 'lmonth': from = ranges.lMonthStart; to = ranges.lMonthEnd; label = 'Last Month'; break;
    case 'custom':
      from = ovState.from; to = ovState.to;
      if (!from || !to || from > to) {
        grid.innerHTML = `<p style="grid-column:1/-1;padding:16px;color:#9ca3af;font-size:13px">Set a valid date range above</p>`;
        return;
      }
      label = 'Custom Range';
      break;
  }

  // Update range display
  const fmt = d => { const [y,m,day] = d.split('-').map(Number); return new Date(y,m-1,day).toLocaleDateString('en-IN',{day:'numeric',month:'short'}); };
  document.getElementById('ov-range-display').textContent = from === to ? fmt(from) : fmt(from) + ' → ' + fmt(to);

  // Build query
  const isAll = ovState.selectedBranches.includes('all') || !ovState.selectedBranches.length;
  let query = db.from('cashup_entries').select('amount, payment_type, branch_id').gte('entry_date', from).lte('entry_date', to);
  if (!isAll) query = query.in('branch_id', ovState.selectedBranches);
  const { data } = await query;
  const entries = data || [];

  const total = entries.reduce((s, e) => s + parseFloat(e.amount), 0);
  const scan = entries.filter(e => e.payment_type !== 'cash').reduce((s, e) => s + parseFloat(e.amount), 0);
  const cash = total - scan;

  // Count cashup days
  const { data: summaries } = await (() => {
    let q = db.from('cashup_summaries').select('entry_date, branch_id').gte('entry_date', from).lte('entry_date', to);
    if (!isAll) q = q.in('branch_id', ovState.selectedBranches);
    return q;
  })();
  const days = new Set((summaries || []).map(s => s.entry_date)).size;

  const avgDay = days > 0 ? total / days : 0;

  grid.innerHTML = `
    <div class="admin-kpi-card">
      <div class="admin-kpi-label">Total Sale</div>
      <div class="admin-kpi-value">${formatCurrency(total)}</div>
      <div class="admin-kpi-sub">${label}</div>
    </div>
    <div class="admin-kpi-card">
      <div class="admin-kpi-label">Cash</div>
      <div class="admin-kpi-value" style="color:#43a047">${formatCurrency(cash)}</div>
      <div class="admin-kpi-sub">${((total > 0 ? cash/total : 0)*100).toFixed(0)}% of total</div>
    </div>
    <div class="admin-kpi-card">
      <div class="admin-kpi-label">Scan</div>
      <div class="admin-kpi-value">${formatCurrency(scan)}</div>
      <div class="admin-kpi-sub">${((total > 0 ? scan/total : 0)*100).toFixed(0)}% of total</div>
    </div>
    <div class="admin-kpi-card">
      <div class="admin-kpi-label">Avg / Day</div>
      <div class="admin-kpi-value">${formatCurrency(avgDay)}</div>
      <div class="admin-kpi-sub">Over ${days} day${days !== 1 ? 's' : ''}</div>
    </div>
  `;
}

// ============================================================
// AUTOMATIONS
// ============================================================

async function loadAutomations() {
  const list = document.getElementById('automations-list');
  if (!list) return;
  const { data, error } = await db.from('cashup_automations').select('*').order('created_at');
  if (error) { list.innerHTML = '<div class="automations-empty">Error loading automations</div>'; return; }
  if (!data || !data.length) {
    list.innerHTML = '<div class="automations-empty">No automations yet — click + Add to create one</div>';
    return;
  }
  list.innerHTML = data.map(a => {
    const triggerLabel = a.trigger_type === 'weekly' ? `Every Sunday · ${a.trigger_mode === 'on_submit' ? 'on submit' : 'scheduled 11 pm'}`
      : a.trigger_type === 'monthly' ? `Every last day · ${a.trigger_mode === 'on_submit' ? 'on submit' : 'scheduled 11 pm'}`
      : `One-time: ${a.trigger_date || ''}`;
    const sections = (a.report_sections || []).map(s => ({
      daily_summary: 'Daily Summary', total_sale: 'Total Sales', all_transactions: 'All Transactions',
      staff_breakdown: 'By Staff', payment_breakdown: 'Payment Split', expenses: 'Expenses',
    }[s] || s)).join(', ') || 'No sections selected';
    const branchesLabel = (!a.branches || a.branches.includes('all')) ? 'All Branches'
      : a.branches.map(id => { const b = state.branches.find(x => x.id === id); return b ? b.name : id; }).join(', ');
    const lastSent = a.last_sent_at
      ? `Last sent ${new Date(a.last_sent_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`
      : 'Never sent';
    const actionBadge = a.action_type === 'webhook'
      ? `<span style="display:inline-block;background:#ede9fe;color:#6d28d9;font-size:10px;font-weight:700;padding:1px 6px;border-radius:8px;margin-left:4px">WEBHOOK</span>`
      : `<span style="display:inline-block;background:#dbeafe;color:#1d4ed8;font-size:10px;font-weight:700;padding:1px 6px;border-radius:8px;margin-left:4px">EMAIL</span>`;
    return `<div class="automation-row">
      <button class="auto-toggle ${a.is_active ? 'on' : ''}" title="${a.is_active ? 'Active' : 'Paused'}" onclick="toggleAutomation('${a.id}', ${!a.is_active})"></button>
      <div class="automation-info">
        <div class="automation-name">${a.name}${actionBadge}</div>
        <div class="automation-meta">${triggerLabel} · ${branchesLabel}</div>
        <div class="automation-meta" style="color:#9ca3af">${sections}</div>
        <div class="automation-meta" style="color:#9ca3af">${lastSent}</div>
      </div>
      <div class="automation-actions">
        <button class="auto-icon-btn" title="Edit" onclick="showAutomationModal('${a.id}')">✏️</button>
        <button class="auto-icon-btn delete" title="Delete" onclick="deleteAutomation('${a.id}', '${a.name.replace(/'/g, "\\'")}')">🗑</button>
      </div>
    </div>`;
  }).join('');
}

function _populateAutoBranchList(selectedBranches) {
  // selectedBranches: ['all'] or array of IDs
  const container = document.getElementById('auto-branch-list');
  // Remove individual branch rows (keep the "All" checkbox row)
  container.querySelectorAll('.auto-branch-item').forEach(el => el.remove());
  const isAll = !selectedBranches || selectedBranches.includes('all');
  container.querySelector('input[value="all"]').checked = isAll;
  state.branches.filter(b => b.active !== false).forEach(b => {
    const lbl = document.createElement('label');
    lbl.className = 'auto-check-label auto-branch-item';
    lbl.style.paddingLeft = '18px';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.value = b.id;
    chk.dataset.branchChk = '1';
    chk.checked = isAll || selectedBranches.includes(b.id);
    chk.addEventListener('change', () => {
      // If any individual branch is unchecked, uncheck "All"
      const allChk = container.querySelector('input[value="all"]');
      const indiv = container.querySelectorAll('[data-branch-chk]');
      allChk.checked = Array.from(indiv).every(c => c.checked);
    });
    lbl.appendChild(chk);
    lbl.appendChild(document.createTextNode(' ' + b.name));
    container.appendChild(lbl);
  });
}

function handleAutoBranchAll(allChk) {
  const container = document.getElementById('auto-branch-list');
  container.querySelectorAll('[data-branch-chk]').forEach(c => { c.checked = allChk.checked; });
}

function showAutomationModal(id = null) {
  const modal = document.getElementById('modal-automation');
  document.getElementById('modal-automation-title').textContent = id ? 'Edit Automation' : 'Add Automation';
  document.getElementById('auto-edit-id').value = id || '';

  if (!id) {
    document.getElementById('auto-name').value = '';
    document.getElementById('auto-trigger-type').value = 'weekly';
    document.querySelectorAll('[name="auto-trigger-mode"]')[0].checked = true;
    document.getElementById('auto-trigger-date').value = '';
    document.getElementById('auto-email-to').value = 'hospitalitybee@gmail.com';
    document.querySelectorAll('.auto-section-chk').forEach(c => {
      c.checked = ['daily_summary', 'total_sale'].includes(c.value);
    });
    _populateAutoBranchList(['all']);
    updateAutoTriggerUI('weekly');
    const actionDisplay = document.getElementById('auto-action-display');
    if (actionDisplay) actionDisplay.textContent = '✉ Send Email Report';
    modal.style.display = 'flex';
    return;
  }

  db.from('cashup_automations').select('*').eq('id', id).single().then(({ data }) => {
    if (!data) return;
    document.getElementById('auto-name').value = data.name;
    document.getElementById('auto-trigger-type').value = data.trigger_type;
    document.getElementById('auto-trigger-date').value = data.trigger_date || '';
    document.getElementById('auto-email-to').value = data.email_to;
    // Show/hide trigger panels first, then set the correct radio in the VISIBLE section only.
    // Both weekly and monthly sections share name="auto-trigger-mode", so setting a hidden
    // radio to checked would deselect the visible one via browser radio-group behaviour.
    updateAutoTriggerUI(data.trigger_type);
    const sectionKey = data.trigger_type === 'weekly' ? 'weekly' : data.trigger_type === 'monthly' ? 'monthly' : null;
    if (sectionKey) {
      document.querySelectorAll(`#auto-${sectionKey}-opts [name="auto-trigger-mode"]`).forEach(r => {
        r.checked = r.value === data.trigger_mode;
      });
    }
    document.querySelectorAll('.auto-section-chk').forEach(c => {
      c.checked = (data.report_sections || []).includes(c.value);
    });
    _populateAutoBranchList(data.branches || ['all']);
    // Update action type display badge
    const actionDisplay = document.getElementById('auto-action-display');
    if (actionDisplay) {
      actionDisplay.textContent = data.action_type === 'webhook' ? '↗ Send Webhook' : '✉ Send Email Report';
    }
    modal.style.display = 'flex';
  });
}

function updateAutoTriggerUI(type) {
  document.getElementById('auto-weekly-opts').style.display = type === 'weekly' ? 'flex' : 'none';
  document.getElementById('auto-monthly-opts').style.display = type === 'monthly' ? 'flex' : 'none';
  document.getElementById('auto-single-opts').style.display = type === 'single_date' ? 'block' : 'none';
  // Reset radio selection for the newly shown set
  const visibleRadio = document.querySelector(
    `#auto-${type === 'weekly' ? 'weekly' : type === 'monthly' ? 'monthly' : 'single'}-opts input[type="radio"]`
  );
  if (visibleRadio) visibleRadio.checked = true;
}

async function saveAutomation() {
  const id = document.getElementById('auto-edit-id').value;
  const name = document.getElementById('auto-name').value.trim();
  if (!name) { showToast('Enter a name for this automation', 'error'); return; }

  const trigger_type = document.getElementById('auto-trigger-type').value;
  const trigger_date = trigger_type === 'single_date' ? document.getElementById('auto-trigger-date').value : null;
  if (trigger_type === 'single_date' && !trigger_date) { showToast('Select a date', 'error'); return; }

  const selectedRadio = document.querySelector('[name="auto-trigger-mode"]:checked');
  const trigger_mode = selectedRadio ? selectedRadio.value : 'scheduled';

  const report_sections = Array.from(
    document.querySelectorAll('.auto-section-chk:checked')
  ).map(c => c.value);

  if (!report_sections.length) { showToast('Select at least one report section', 'error'); return; }

  // Collect branch selection
  const allChk = document.querySelector('#auto-branch-list input[value="all"]');
  let branches;
  if (allChk && allChk.checked) {
    branches = ['all'];
  } else {
    branches = Array.from(document.querySelectorAll('[data-branch-chk]:checked')).map(c => c.value);
    if (!branches.length) { showToast('Select at least one branch', 'error'); return; }
  }

  const email_to = document.getElementById('auto-email-to').value.trim();
  if (!email_to) { showToast('Enter a destination email', 'error'); return; }

  const record = { name, trigger_type, trigger_mode, trigger_date, report_sections, branches, email_to };
  let error;
  if (id) {
    ({ error } = await db.from('cashup_automations').update(record).eq('id', id));
  } else {
    ({ error } = await db.from('cashup_automations').insert({ ...record, action_type: 'email' }));
  }

  if (error) { showToast('Error saving automation', 'error'); return; }
  document.getElementById('modal-automation').style.display = 'none';
  showToast(id ? 'Automation updated ✓' : 'Automation created ✓', 'success');
  loadAutomations();
}

async function toggleAutomation(id, newState) {
  const { error } = await db.from('cashup_automations').update({ is_active: newState }).eq('id', id);
  if (error) { showToast('Error updating automation', 'error'); return; }
  loadAutomations();
}

async function deleteAutomation(id, name) {
  if (!confirm(`Delete automation "${name}"?`)) return;
  const { error } = await db.from('cashup_automations').delete().eq('id', id);
  if (error) { showToast('Error deleting automation', 'error'); return; }
  showToast('Automation deleted', 'success');
  loadAutomations();
}

async function checkOnSubmitAutomations(date) {
  try {
    const [y, m, d] = date.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dow = dt.getUTCDay(); // 0=Sun
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const isSunday = dow === 0;
    const isLastDay = d === lastDay;
    if (!isSunday && !isLastDay) return;

    const { data: automations } = await db.from('cashup_automations')
      .select('*')
      .eq('is_active', true)
      .eq('trigger_mode', 'on_submit');

    if (!automations || !automations.length) return;

    for (const auto of automations) {
      if (auto.trigger_type === 'weekly' && !isSunday) continue;
      if (auto.trigger_type === 'monthly' && !isLastDay) continue;

      // Skip if already sent today (prevents double-fire on same day)
      if (auto.last_sent_at && auto.last_sent_at.startsWith(date)) continue;

      // Determine which branches this automation covers
      const targetBranches = (!auto.branches || auto.branches.includes('all'))
        ? state.branches.filter(b => b.active !== false).map(b => b.id)
        : auto.branches;

      // Check if ALL target branches have submitted for this date
      const { data: submitted } = await db.from('cashup_summaries')
        .select('branch_id')
        .in('branch_id', targetBranches)
        .eq('entry_date', date)
        .eq('is_submitted', true);

      const submittedIds = (submitted || []).map(s => s.branch_id);
      const allSubmitted = targetBranches.every(id => submittedIds.includes(id));
      if (!allSubmitted) continue; // still waiting for other branches

      // All branches have submitted — fire the report
      const dateRange = getAutomationDateRange(auto.trigger_type, date);
      fireAutomationEmail(auto, dateRange.from, dateRange.to);
    }
  } catch (e) { console.error('checkOnSubmitAutomations error:', e); }
}

function getAutomationDateRange(trigger_type, anchorDate) {
  const [y, m, d] = anchorDate.split('-').map(Number);
  if (trigger_type === 'weekly') {
    // Mon–Sun of current week
    const dt = new Date(Date.UTC(y, m - 1, d));
    const dow = dt.getUTCDay();
    const mon = new Date(dt); mon.setUTCDate(dt.getUTCDate() - ((dow + 6) % 7));
    return { from: mon.toISOString().split('T')[0], to: anchorDate };
  } else if (trigger_type === 'monthly') {
    const first = new Date(Date.UTC(y, m - 1, 1)).toISOString().split('T')[0];
    return { from: first, to: anchorDate };
  }
  return { from: anchorDate, to: anchorDate };
}

async function fireAutomationEmail(automation, from, to) {
  const endpoint = automation.action_type === 'webhook'
    ? '/.netlify/functions/send-automation-webhook'
    : '/.netlify/functions/send-automation-report';
  const payload = JSON.stringify({ automation_id: automation.id, date_from: from, date_to: to });
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      if (res.ok) return;
      console.warn(`Automation attempt ${attempt} failed: HTTP ${res.status}`);
    } catch (e) {
      console.warn(`Automation attempt ${attempt} error:`, e.message);
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
  }
  console.error('Automation failed after 3 attempts');
}

async function saveAdminPIN() {
  const newPin = document.getElementById('new-admin-pin-input').value.trim();
  if (!/^\d{4}$/.test(newPin)) {
    showToast('Admin PIN must be 4 digits', 'error');
    return;
  }
  // Can't match any active branch PIN
  const conflict = state.branches.find(b => b.pin === newPin && b.active !== false);
  if (conflict) {
    showToast(`PIN conflicts with "${conflict.name}" branch`, 'error');
    return;
  }
  const { error } = await db.from('settings').upsert({ key: 'admin_pin', value: newPin });
  if (error) { showToast('Error saving PIN', 'error'); return; }
  state.adminPIN = newPin;
  document.getElementById('new-admin-pin-input').value = '';
  showToast('Admin PIN updated ✓', 'success');
}

// Branch CRUD
function showAddBranchModal() {
  document.getElementById('modal-branch-title').textContent = 'Add Branch';
  document.getElementById('modal-branch-name').value = '';
  document.getElementById('modal-branch-state').value = '';
  document.getElementById('modal-branch-pin').value = '';
  document.getElementById('modal-branch-id').value = '';
  document.getElementById('modal-branch').style.display = 'flex';
}

function editBranch(id, name, pin, stateVal) {
  document.getElementById('modal-branch-title').textContent = 'Edit Branch';
  document.getElementById('modal-branch-name').value = name;
  document.getElementById('modal-branch-state').value = stateVal || '';
  document.getElementById('modal-branch-pin').value = pin;
  document.getElementById('modal-branch-id').value = id;
  document.getElementById('modal-branch').style.display = 'flex';
}

async function saveBranchModal() {
  const name = document.getElementById('modal-branch-name').value.trim();
  const stateVal = document.getElementById('modal-branch-state').value;
  const pin = document.getElementById('modal-branch-pin').value.trim();
  const id = document.getElementById('modal-branch-id').value;

  if (!name) { showToast('Enter branch name', 'error'); return; }
  if (!/^\d{4}$/.test(pin)) { showToast('PIN must be 4 digits', 'error'); return; }
  if (pin === state.adminPIN) { showToast('Cannot use Admin PIN for a branch', 'error'); return; }

  if (id) {
    await db.from('branches').update({ name, pin, state: stateVal || null }).eq('id', id);
    showToast('Branch updated ✓', 'success');
  } else {
    await db.from('branches').insert({ name, pin, state: stateVal || null, active: true });
    showToast('Branch added ✓', 'success');
  }

  document.getElementById('modal-branch').style.display = 'none';
  await loadAdminBranches();
  await loadBranches();
}

function deleteBranch(id, name) {
  const modal = document.getElementById('modal-delete-branch');
  const msg = document.getElementById('modal-delete-branch-msg');
  if (msg) msg.textContent = `Are you sure you want to delete "${name}"? This cannot be undone.`;
  if (modal) modal.style.display = 'flex';

  const confirmBtn = document.getElementById('btn-delete-confirm');
  // Remove any old listener before adding a new one
  const newConfirmBtn = confirmBtn.cloneNode(true);
  confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

  newConfirmBtn.addEventListener('click', async () => {
    modal.style.display = 'none';
    await db.from('branches').update({ active: false }).eq('id', id);
    showToast('Branch removed', 'success');
    await loadAdminBranches();
    await loadBranches();
  });
}

// Forgot PIN — shows modal
function forgotPIN() {
  document.getElementById('forgot-pin-email').value = '';
  document.getElementById('forgot-pin-msg').textContent = '';
  document.getElementById('forgot-pin-msg').className = 'admin-msg';
  document.getElementById('modal-forgot-pin').style.display = 'flex';
}

async function sendForgotPIN() {
  const email = document.getElementById('forgot-pin-email').value.trim().toLowerCase();
  const msg = document.getElementById('forgot-pin-msg');
  const btn = document.getElementById('btn-forgot-submit');

  if (!email) {
    msg.textContent = 'Enter your email address.';
    msg.className = 'admin-msg error';
    return;
  }

  if (email !== CONFIG.ADMIN_EMAIL.toLowerCase()) {
    msg.textContent = '⛔ Not authorized.';
    msg.className = 'admin-msg error';
    return;
  }

  // Send PIN to admin email via Netlify function (PIN never exposed on screen)
  btn.disabled = true;
  btn.textContent = 'Sending…';
  msg.textContent = '';
  msg.className = 'admin-msg';

  try {
    // Always sends the ADMIN PIN to the admin email (never a branch PIN).
    // This is the admin's private recovery path; for staff it's a decoy.
    // branch_id is sent only so the email can show which branch attempted it.
    const res = await fetch('/.netlify/functions/send-pin-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, branch_id: state.currentBranch?.id || null }),
    });

    if (res.ok) {
      msg.textContent = '✅ PIN sent to your email.';
      msg.className = 'admin-msg success';
    } else {
      const err = await res.json().catch(() => ({}));
      msg.textContent = err.error === 'Not authorized' ? '⛔ Not authorized.' : '⚠️ Could not send email. Try again.';
      msg.className = 'admin-msg error';
    }
  } catch {
    msg.textContent = '⚠️ Network error. Try again.';
    msg.className = 'admin-msg error';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Get PIN';
  }
}

// ============================================================
// DASHBOARD
// ============================================================

async function openDashboard() {
  showScreen('dashboard');
  activateBranchTab('cashup');
  setRoute('#/branch/cashup');
  const branch = state.currentBranch;
  const date = state.activeDate;

  const _sidebarSub = document.getElementById('branch-sidebar-sub');
  if (_sidebarSub) _sidebarSub.textContent = branch.name;
  const _dashTitle = document.getElementById('dash-branch-title');
  if (_dashTitle) _dashTitle.textContent = branch.name;
  const today = getISTDate();
  const dateLabel = document.getElementById('dash-date-label');
  const nextBtn = document.getElementById('btn-date-next');
  if (dateLabel) dateLabel.textContent = (date === today ? 'Today — ' : '📅 ') + formatDisplayDate(date);
  if (nextBtn) nextBtn.disabled = date >= today;

  // Show loading placeholder while status loads (prevents "Not Started" flash)
  const statusCard = document.getElementById('cashup-status-card');
  if (statusCard) {
    statusCard.innerHTML = `<div class="status-info"><div class="status-dot" style="background:#d1d5db"></div><div><div class="status-label" style="color:#9ca3af">Loading…</div></div></div>`;
  }

  // (Date override panel removed — use date navigator at top)

  await loadTodayStatus(branch.id, date);
  await loadDashboardStats(branch.id, date);

  // Only check yesterday warning when viewing today
  if (date === today) {
    await checkYesterdayWarning(branch.id);
  } else {
    const w = document.getElementById('yesterday-warning');
    if (w) w.style.display = 'none';
  }
}

async function checkYesterdayWarning(branchId) {
  const w = document.getElementById('yesterday-warning');
  if (!w) return;
  const yesterday = getPrevDate(getISTDate());
  const { data: ySummary } = await db
    .from('cashup_summaries')
    .select('actual_closing_balance')
    .eq('branch_id', branchId)
    .eq('entry_date', yesterday)
    .single();

  // Show warning if no summary at all OR summary exists but no actual closing
  const isPending = !ySummary || ySummary.actual_closing_balance === null;
  w.style.display = isPending ? 'flex' : 'none';

  if (isPending) {
    // Show which date is pending in the title
    const titleEl = document.getElementById('yesterday-warning-title');
    if (titleEl) {
      const [y, m, d] = yesterday.split('-').map(Number);
      const shortDate = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' }).format(new Date(y, m - 1, d));
      titleEl.textContent = `${shortDate} closing is pending`;
    }
    const btn = document.getElementById('btn-fix-yesterday');
    if (btn) {
      btn.onclick = () => {
        state.activeDate = yesterday;
        openCashupForm(yesterday);
      };
    }
  }
}

async function loadTodayStatus(branchId, date) {
  const statusCard = document.getElementById('cashup-status-card');
  const openBtn = document.getElementById('btn-open-cashup');

  // Non-admin staff cannot access dates older than 7 days
  const isLocked = !state.isAdmin && date < getISTDateOffset(-7);
  if (isLocked) {
    statusCard.innerHTML = `
      <div class="status-info">
        <div class="status-dot" style="background:#d1d5db"></div>
        <div>
          <div class="status-label" style="color:#9ca3af">Restricted</div>
          <div class="status-sub">Records older than 7 days are not accessible</div>
        </div>
      </div>
    `;
    openBtn.style.display = 'none';
    return;
  }
  openBtn.style.display = '';

  const { data: summary } = await db
    .from('cashup_summaries')
    .select('*')
    .eq('branch_id', branchId)
    .eq('entry_date', date)
    .single();

  const { data: entries } = await db
    .from('cashup_entries')
    .select('amount')
    .eq('branch_id', branchId)
    .eq('entry_date', date);

  const hasData = summary || (entries && entries.length > 0);
  const isFinalSubmit = summary && summary.actual_closing_balance !== null;

  if (hasData) {
    const total = (entries || []).reduce((s, e) => s + parseFloat(e.amount), 0);
    if (isFinalSubmit) {
      statusCard.innerHTML = `
        <div class="status-info">
          <div class="status-dot done"></div>
          <div>
            <div class="status-label">Complete ✓</div>
            <div class="status-sub">Total Sale: ${formatCurrency(total)} · Closing: ${formatCurrency(summary.actual_closing_balance)}</div>
          </div>
        </div>
        <button class="secondary-btn" id="btn-edit-cashup" style="font-size:13px;padding:8px 14px">Edit</button>
      `;
    } else {
      statusCard.innerHTML = `
        <div class="status-info">
          <div class="status-dot draft"></div>
          <div>
            <div class="status-label">Draft Saved</div>
            <div class="status-sub">Total Sale: ${formatCurrency(total)} · Till count pending</div>
          </div>
        </div>
        <button class="secondary-btn" id="btn-edit-cashup" style="font-size:13px;padding:8px 14px">Continue</button>
      `;
    }
    openBtn.textContent = isFinalSubmit ? '📋 View / Edit Cashup' : '📋 Continue Cashup';
    document.getElementById('btn-edit-cashup')?.addEventListener('click', () => openCashupForm(date));
  } else {
    statusCard.innerHTML = `
      <div class="status-info">
        <div class="status-dot none"></div>
        <div>
          <div class="status-label">Not Started</div>
          <div class="status-sub">${date !== getISTDate() ? 'No cashup for this date' : "Today's cashup is pending"}</div>
        </div>
      </div>
    `;
    openBtn.textContent = date !== getISTDate() ? '📋 Enter Cashup for This Date' : '📋 Enter Today\'s Cashup';
  }
}

async function loadDashboardStats(branchId, date) {
  const { weekStart, weekEnd, lWeekStart, lWeekEnd, monthStart, monthEnd, lMonthStart, lMonthEnd } = getDateRanges(date);

  const calcTotals = async (from, to) => {
    const { data } = await db
      .from('cashup_entries')
      .select('amount, payment_type')
      .eq('branch_id', branchId)
      .gte('entry_date', from)
      .lte('entry_date', to);

    if (!data || !data.length) return { total: 0, cash: 0, scan: 0 };
    const total = data.reduce((s, e) => s + parseFloat(e.amount), 0);
    const scan = data.filter(e => e.payment_type !== 'cash').reduce((s, e) => s + parseFloat(e.amount), 0);
    return { total, cash: total - scan, scan };
  };

  const [tw, lw, tm, lm] = await Promise.all([
    calcTotals(weekStart, weekEnd),
    calcTotals(lWeekStart, lWeekEnd),
    calcTotals(monthStart, monthEnd),
    calcTotals(lMonthStart, lMonthEnd),
  ]);

  // KPI cards show total only — cash/scan breakdown intentionally removed per request
  document.getElementById('stat-week-val').textContent = formatCurrency(tw.total);
  document.getElementById('stat-month-val').textContent = formatCurrency(tm.total);
  document.getElementById('stat-lweek-val').textContent = formatCurrency(lw.total);
  document.getElementById('stat-lmonth-val').textContent = formatCurrency(lm.total);
}

// ============================================================
// CASHUP FORM
// ============================================================

function getPrevDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Use UTC methods for reliable date arithmetic regardless of where the browser is running
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().split('T')[0];
}

function getNextDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().split('T')[0];
}

async function navigateDashboardDate(date) {
  state.activeDate = date;
  const today = getISTDate();
  // Update label and arrow states
  const label = document.getElementById('dash-date-label');
  const prevBtn = document.getElementById('btn-date-prev');
  const nextBtn = document.getElementById('btn-date-next');
  if (label) label.textContent = (date === today ? 'Today — ' : '📅 ') + formatDisplayDate(date);
  if (nextBtn) nextBtn.disabled = date >= today;
  if (prevBtn) {
    const minDate = state.isAdmin ? null : getISTDateOffset(-7);
    prevBtn.disabled = !state.isAdmin && date <= minDate;
  }
  // Reload status and stats for the new date
  const branch = state.currentBranch;
  if (branch) {
    await Promise.all([
      loadTodayStatus(branch.id, date),
      loadDashboardStats(branch.id, date),
    ]);
    // Yesterday warning only relevant when viewing today
    if (date === today) {
      await checkYesterdayWarning(branch.id);
    } else {
      const w = document.getElementById('yesterday-warning');
      if (w) w.style.display = 'none';
    }
  }
}

async function openCashupForm(date) {
  // Non-admin staff cannot open cashup sheets older than 7 days
  if (!state.isAdmin && date < getISTDateOffset(-7)) {
    showToast('You can only view up to 7 days back', 'error');
    return;
  }
  showScreen('cashup');
  setRoute('#/cashup/' + date);
  startLiveClock();
  const branch = state.currentBranch;

  document.getElementById('cashup-form-title').textContent = branch.name;
  document.getElementById('cashup-form-date').textContent =
    branch.name + ' — ' + formatDisplayDate(date);

  // Clear form
  document.getElementById('entries-list').innerHTML = '';
  document.getElementById('expenses-list').innerHTML = '';
  document.getElementById('extras-list').innerHTML = '';
  document.getElementById('s-less-scan').textContent = '₹0.00';
  document.getElementById('s-less-handover').value = '';
  document.getElementById('s-actual-closing').value = '';
  document.getElementById('s-notes').value = '';
  document.getElementById('variance-row').style.display = 'none';
  state.existingSummaryId = null;
  state.openingBalance = 0;

  await loadAutocompleteData(branch.id);

  // Load all data in parallel
  const prevDate = getPrevDate(date);
  const [
    { data: entries },
    { data: expenses },
    { data: extras },
    { data: summary },
    { data: prevSummary },
  ] = await Promise.all([
    db.from('cashup_entries').select('*').eq('branch_id', branch.id).eq('entry_date', date).order('sort_order'),
    db.from('cashup_expenses').select('*').eq('branch_id', branch.id).eq('entry_date', date).order('sort_order'),
    db.from('cashup_extras').select('*').eq('branch_id', branch.id).eq('entry_date', date),
    db.from('cashup_summaries').select('*').eq('branch_id', branch.id).eq('entry_date', date).single(),
    db.from('cashup_summaries').select('closing_balance').eq('branch_id', branch.id).eq('entry_date', prevDate).single(),
  ]);

  // Opening balance from previous day's closing (read-only)
  state.openingBalance = parseFloat(prevSummary?.closing_balance) || 0;
  const openingEl = document.getElementById('s-opening-display');
  if (openingEl) openingEl.textContent = formatCurrency(state.openingBalance);

  if (entries && entries.length > 0) {
    entries.forEach(e => addEntryRow(e));
  } else {
    addEntryRow();
  }

  if (expenses && expenses.length > 0) {
    expenses.forEach(e => addExpenseRow(e));
  }

  if (extras && extras.length > 0) {
    extras.forEach(e => addExtraRow(e));
  }

  if (summary) {
    state.existingSummaryId = summary.id;
    document.getElementById('s-less-handover').value = summary.less_cash_handover || '';
    document.getElementById('s-actual-closing').value = summary.actual_closing_balance != null ? summary.actual_closing_balance : '';
    document.getElementById('s-notes').value = summary.notes || '';
  }

  recalcSummary();

  // Admin can edit any date; branch staff can edit today, or yesterday ONLY if not yet submitted final
  const isYesterday = date === getPrevDate(getISTDate());
  const yesterdaySubmitted = isYesterday && summary?.actual_closing_balance !== null && summary?.actual_closing_balance !== undefined;
  const canEdit = state.isAdmin || date === getISTDate() || (isYesterday && !yesterdaySubmitted);
  const formWrap = document.getElementById('cashup-form-wrap');
  const submitSection = document.querySelector('.submit-section');
  const submitNote = document.getElementById('submit-note');
  const banner = document.getElementById('cashup-view-banner');
  if (canEdit) {
    formWrap.classList.remove('view-mode');
    if (submitSection) submitSection.style.display = 'block';
    if (submitNote) submitNote.style.display = 'block';
    if (banner) banner.style.display = 'none';
  } else {
    formWrap.classList.add('view-mode');
    if (submitSection) submitSection.style.display = 'none';
    if (submitNote) submitNote.style.display = 'none';
    if (banner) banner.style.display = 'block';
  }
}

function addEntryRow(data = {}) {
  const list = document.getElementById('entries-list');
  const id = 'er-' + Date.now() + Math.random().toString(36).slice(2);
  const div = document.createElement('div');
  div.className = 'entry-row';
  div.id = id;
  div.dataset.dbId = data.id || '';
  div.innerHTML = `
    <div>
      <input type="text" class="entry-input e-product" placeholder="Product / Service"
        value="${esc(data.product_service || '')}" autocomplete="off">
    </div>
    <div>
      <input type="text" class="entry-input e-name" placeholder="Name"
        value="${esc(data.customer_name || '')}" autocomplete="off">
    </div>
    <div class="entry-cell-amount">
      <span class="currency-prefix">₹</span>
      <input type="number" class="entry-input e-amount" placeholder="0" step="0.01" min="0"
        value="${data.amount || ''}">
    </div>
    <div>
      <select class="entry-select e-type">
        ${paymentModeOptions(data.payment_type)}
      </select>
    </div>
    <div class="staff-dropdown-wrap">
      <input type="hidden" class="e-staff" value="${esc(data.staff || '')}">
      <div class="staff-trigger" onclick="toggleStaffDropdown(this)">
        <span class="staff-trigger-text">${data.staff ? esc(data.staff) : '— Staff —'}</span>
        <span class="staff-chevron">▾</span>
      </div>
      <div class="staff-panel" style="display:none"></div>
    </div>
    <div>
      <button class="del-row-btn" onclick="removeRow('${id}')">×</button>
    </div>
  `;
  list.appendChild(div);

  div.querySelectorAll('.e-amount, .e-type').forEach(el => {
    el.addEventListener('input', recalcSummary);
    el.addEventListener('change', recalcSummary);
  });

  const productInput = div.querySelector('.e-product');
  const nameInput = div.querySelector('.e-name');
  bindAutocomplete(productInput, 'products');
  bindAutocomplete(nameInput, 'names');
}

function addExpenseRow(data = {}) {
  const list = document.getElementById('expenses-list');
  const id = 'exp-' + Date.now() + Math.random().toString(36).slice(2);
  const div = document.createElement('div');
  div.className = 'expense-row';
  div.id = id;
  div.dataset.dbId = data.id || '';
  div.innerHTML = `
    <div>
      <input type="text" class="entry-input exp-reason" placeholder="Expense reason"
        value="${esc(data.reason || '')}" autocomplete="off">
    </div>
    <div class="entry-cell-amount">
      <span class="currency-prefix">₹</span>
      <input type="number" class="entry-input exp-amount" placeholder="0" step="0.01" min="0"
        value="${data.amount || ''}">
    </div>
    <div>
      <button class="del-row-btn" onclick="removeRow('${id}')">×</button>
    </div>
  `;
  list.appendChild(div);

  div.querySelector('.exp-amount').addEventListener('input', recalcSummary);
}

function addExtraRow(data = {}) {
  const list = document.getElementById('extras-list');
  const id = 'ext-' + Date.now() + Math.random().toString(36).slice(2);
  const div = document.createElement('div');
  div.className = 'extra-row';
  div.id = id;
  div.dataset.dbId = data.id || '';
  div.innerHTML = `
    <div>
      <input type="text" class="entry-input extra-reason" placeholder="Reason (e.g. float top-up)"
        value="${esc(data.reason || '')}" autocomplete="off">
    </div>
    <div class="entry-cell-amount">
      <span class="currency-prefix">₹</span>
      <input type="number" class="entry-input extra-amount" placeholder="0" step="0.01" min="0"
        value="${data.amount || ''}">
    </div>
    <div>
      <button class="del-row-btn" onclick="removeRow('${id}')">×</button>
    </div>
  `;
  list.appendChild(div);
  div.querySelector('.extra-amount').addEventListener('input', recalcSummary);
}

// ── Staff custom dropdown (portal-based — renders at body level to escape overflow:hidden) ───
let _staffActiveWrap = null;

function _getOrCreatePortalPanel() {
  let panel = document.getElementById('staff-portal-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'staff-portal-panel';
    panel.className = 'staff-panel';
    panel.style.display = 'none';
    panel.style.position = 'fixed';
    // Stop ALL clicks inside the panel from reaching the document close-handler
    panel.addEventListener('click', e => e.stopPropagation());
    document.body.appendChild(panel);
  }
  return panel;
}

function buildStaffPanel(panel) {
  if (!_staffActiveWrap) return;
  const current = _staffActiveWrap.querySelector('.e-staff').value;
  const items = state.staffList.map(s => `
    <div class="staff-option${s === current ? ' active' : ''}" onclick="pickStaff('${s.replace(/'/g,"\\'")}')">
      <span>${esc(s)}</span>
      <button class="staff-del-btn" onclick="event.stopPropagation();deleteStaffMember('${s.replace(/'/g,"\\'")}')">×</button>
    </div>`).join('');
  panel.innerHTML = items + `<div class="staff-add-row">
    <div class="staff-add-trigger" onclick="showStaffInput(this)">+ Add Staff</div>
  </div>`;
}

function toggleStaffDropdown(trigger) {
  const wrap = trigger.parentElement;
  const panel = _getOrCreatePortalPanel();
  const isOpen = panel.style.display !== 'none' && _staffActiveWrap === wrap;
  closeAllStaffPanels();
  if (!isOpen) {
    _staffActiveWrap = wrap;
    buildStaffPanel(panel);
    // position under the trigger
    const rect = trigger.getBoundingClientRect();
    panel.style.left = rect.left + 'px';
    panel.style.top = (rect.bottom + 4) + 'px';
    panel.style.width = Math.max(rect.width, 240) + 'px';
    panel.style.display = 'block';
  }
}

function closeAllStaffPanels() {
  const panel = document.getElementById('staff-portal-panel');
  if (panel) panel.style.display = 'none';
  _staffActiveWrap = null;
}

function pickStaff(name) {
  if (!_staffActiveWrap) return;
  _staffActiveWrap.querySelector('.e-staff').value = name;
  _staffActiveWrap.querySelector('.staff-trigger-text').textContent = name;
  closeAllStaffPanels();
}

function showStaffInput(addTrigger) {
  const row = addTrigger.parentElement;
  row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:8px;border-top:1px solid #f3f4f6';
  row.innerHTML = `
    <input class="staff-add-input" type="text" placeholder="Name...">
    <button class="staff-add-confirm" onclick="confirmAddStaff(this)" title="Add staff">✓</button>`;
  const inp = row.querySelector('.staff-add-input');
  inp.focus();
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmAddStaff(row.querySelector('.staff-add-confirm'));
    if (e.key === 'Escape') closeAllStaffPanels();
  });
}

async function confirmAddStaff(btn) {
  const inp = btn.previousElementSibling;
  const name = inp.value.trim().toUpperCase();
  if (!name) return;
  if (state.staffList.includes(name)) { showToast('Already in list', 'error'); return; }
  const { error } = await db.from('staff_members').insert({ name, name_key: name });
  if (error) { showToast('Save failed: ' + error.message, 'error'); return; }
  state.staffList.push(name);
  state.staffList.sort();
  if (_staffActiveWrap) {
    _staffActiveWrap.querySelector('.e-staff').value = name;
    _staffActiveWrap.querySelector('.staff-trigger-text').textContent = name;
  }
  closeAllStaffPanels();
  showToast(`${name} added ✓`, 'success');
}

async function deleteStaffMember(name) {
  const { error } = await db.from('staff_members').delete().eq('name_key', name);
  if (error) { showToast('Delete failed', 'error'); return; }
  state.staffList = state.staffList.filter(s => s !== name);
  document.querySelectorAll('.staff-dropdown-wrap').forEach(wrap => {
    const hidden = wrap.querySelector('.e-staff');
    if (hidden.value === name) {
      hidden.value = '';
      wrap.querySelector('.staff-trigger-text').textContent = '— Staff —';
    }
  });
  // rebuild panel if open
  const panel = document.getElementById('staff-portal-panel');
  if (panel && panel.style.display !== 'none') buildStaffPanel(panel);
  showToast(`${name} removed`, 'success');
}

function removeRow(id) {
  document.getElementById(id)?.remove();
  recalcSummary();
}

function recalcSummary() {
  let totalSale = 0, totalScan = 0;
  document.querySelectorAll('.entry-row').forEach(row => {
    const amt = parseFloat(row.querySelector('.e-amount')?.value) || 0;
    const type = row.querySelector('.e-type')?.value;
    totalSale += amt;
    if (type !== 'cash') totalScan += amt;
  });

  let totalExtras = 0;
  document.querySelectorAll('.extra-row').forEach(row => {
    totalExtras += parseFloat(row.querySelector('.extra-amount')?.value) || 0;
  });

  let totalExp = 0;
  document.querySelectorAll('.expense-row').forEach(row => {
    totalExp += parseFloat(row.querySelector('.exp-amount')?.value) || 0;
  });

  const opening = state.openingBalance || 0;
  const lessScan = totalScan;
  const lessHandover = parseFloat(document.getElementById('s-less-handover')?.value) || 0;

  const balance1 = opening + totalSale;
  const cashBalance = balance1 - lessScan;
  const balance2 = cashBalance - lessHandover;
  const closing = balance2 + totalExtras - totalExp;

  state.lastCalculatedClosing = closing;

  document.getElementById('s-total-sale').textContent = formatCurrency(totalSale);
  document.getElementById('s-balance-1').textContent = formatCurrency(balance1);
  document.getElementById('s-less-scan').textContent = formatCurrency(lessScan);
  document.getElementById('s-cash-balance').textContent = formatCurrency(cashBalance);
  document.getElementById('s-balance-2').textContent = formatCurrency(balance2);
  document.getElementById('s-add-extra').textContent = formatCurrency(totalExtras);
  document.getElementById('s-less-exp').textContent = formatCurrency(totalExp);
  document.getElementById('s-closing').textContent = formatCurrency(closing);
  document.getElementById('entries-total').textContent = formatCurrency(totalSale);
  document.getElementById('expenses-total').textContent = formatCurrency(totalExp);
  const extTotalEl = document.getElementById('extras-total');
  if (extTotalEl) extTotalEl.textContent = formatCurrency(totalExtras);

  // Variance
  const actualEl = document.getElementById('s-actual-closing');
  const varianceRow = document.getElementById('variance-row');
  const varianceEl = document.getElementById('s-variance');
  if (actualEl && actualEl.value !== '' && varianceRow && varianceEl) {
    const actual = parseFloat(actualEl.value) || 0;
    const variance = actual - closing;
    varianceRow.style.display = 'flex';
    if (Math.abs(variance) < 0.01) {
      varianceEl.textContent = '✓ All good';
      varianceEl.className = 'summary-value variance-zero';
    } else if (variance > 0) {
      varianceEl.textContent = '+' + formatCurrency(variance) + ' over';
      varianceEl.className = 'summary-value variance-positive';
    } else {
      varianceEl.textContent = formatCurrency(Math.abs(variance)) + ' short';
      varianceEl.className = 'summary-value variance-negative';
    }
  } else if (varianceRow) {
    varianceRow.style.display = 'none';
  }
}

// ============================================================
// SAVE CASHUP
// ============================================================

async function saveCashup(isFinal = false) {
  const draftBtn = document.getElementById('btn-save-draft');
  const finalBtn = document.getElementById('btn-submit-final');
  const activeBtn = isFinal ? finalBtn : draftBtn;
  if (activeBtn) { activeBtn.disabled = true; activeBtn.textContent = 'Saving…'; }

  // Final submit requires actual closing to be filled
  if (isFinal) {
    const actualVal = document.getElementById('s-actual-closing').value;
    if (actualVal === '' || actualVal === null) {
      showToast('Enter Actual Closing (till count) before submitting final', 'error');
      if (activeBtn) { activeBtn.disabled = false; activeBtn.textContent = '✓ Submit Final'; }
      document.getElementById('s-actual-closing').focus();
      return;
    }
  }

  const branch = state.currentBranch;
  const date = state.activeDate;

  // Safety guard: staff can only save today or yesterday (grace exception)
  const yesterday = getPrevDate(getISTDate());
  if (!state.isAdmin && date !== getISTDate() && date !== yesterday) {
    showToast('You can only edit today\'s or yesterday\'s cashup', 'error');
    const draftBtnG = document.getElementById('btn-save-draft');
    const finalBtnG = document.getElementById('btn-submit-final');
    if (draftBtnG) { draftBtnG.disabled = false; draftBtnG.textContent = '💾 Save Draft'; }
    if (finalBtnG) { finalBtnG.disabled = false; finalBtnG.textContent = '✓ Submit Final'; }
    return;
  }

  // Every entry that has an amount must have a Product/Service filled in.
  // (Auto-capture can prefill amount + payment mode + branch, but not the product
  // label — staff fill that. Validate on FINAL submit, before any DB write.)
  if (isFinal) {
    const rows = [...document.querySelectorAll('.entry-row')];
    let firstBad = null;
    rows.forEach(row => {
      const prodEl = row.querySelector('.e-product');
      const amt = parseFloat(row.querySelector('.e-amount')?.value) || 0;
      const prod = prodEl?.value?.trim() || '';
      if (amt > 0 && !prod) {
        prodEl?.classList.add('field-error');
        if (!firstBad) firstBad = prodEl;
      } else {
        prodEl?.classList.remove('field-error');
      }
    });
    if (firstBad) {
      showToast('Every entry with an amount needs a Product/Service — fill the highlighted rows.', 'error');
      if (activeBtn) { activeBtn.disabled = false; activeBtn.textContent = '✓ Submit Final'; }
      firstBad.scrollIntoView({ behavior: 'smooth', block: 'center' });
      firstBad.focus();
      return;
    }
  }

  try {
    // Delete existing rows for this date before re-inserting
    const [delEntries, delExpenses, delExtras] = await Promise.all([
      db.from('cashup_entries').delete().eq('branch_id', branch.id).eq('entry_date', date),
      db.from('cashup_expenses').delete().eq('branch_id', branch.id).eq('entry_date', date),
      db.from('cashup_extras').delete().eq('branch_id', branch.id).eq('entry_date', date),
    ]);
    if (delEntries.error) throw delEntries.error;
    if (delExpenses.error) throw delExpenses.error;
    if (delExtras.error) throw delExtras.error;

    const entryRows = [...document.querySelectorAll('.entry-row')];
    const entryData = entryRows.map((row, i) => ({
      branch_id: branch.id,
      entry_date: date,
      product_service: row.querySelector('.e-product')?.value?.trim() || '',
      customer_name: row.querySelector('.e-name')?.value?.trim() || '',
      amount: parseFloat(row.querySelector('.e-amount')?.value) || 0,
      payment_type: row.querySelector('.e-type')?.value || 'cash',
      staff: row.querySelector('.e-staff')?.value?.trim() || '',
      sort_order: i,
    })).filter(e => e.product_service || e.amount > 0);

    if (entryData.length > 0) {
      const { error: entryErr } = await db.from('cashup_entries').insert(entryData);
      if (entryErr) throw entryErr;
    }

    const expenseRows = [...document.querySelectorAll('.expense-row')];
    const expenseData = expenseRows.map((row, i) => ({
      branch_id: branch.id,
      entry_date: date,
      reason: row.querySelector('.exp-reason')?.value?.trim() || '',
      amount: parseFloat(row.querySelector('.exp-amount')?.value) || 0,
      sort_order: i,
    })).filter(e => e.reason || e.amount > 0);

    if (expenseData.length > 0) {
      const { error: expErr } = await db.from('cashup_expenses').insert(expenseData);
      if (expErr) throw expErr;
    }

    const extraRows = [...document.querySelectorAll('.extra-row')];
    const extraData = extraRows.map((row) => ({
      branch_id: branch.id,
      entry_date: date,
      reason: row.querySelector('.extra-reason')?.value?.trim() || '',
      amount: parseFloat(row.querySelector('.extra-amount')?.value) || 0,
    })).filter(e => e.reason || e.amount > 0);

    if (extraData.length > 0) {
      const { error: extErr } = await db.from('cashup_extras').insert(extraData);
      if (extErr) throw extErr;
    }

    const actualClosingVal = document.getElementById('s-actual-closing').value;
    const actualClosing = actualClosingVal !== '' ? parseFloat(actualClosingVal) : null;
    const closingBalance = state.lastCalculatedClosing || 0;
    const variance = actualClosing !== null ? actualClosing - closingBalance : null;

    const summaryData = {
      branch_id: branch.id,
      entry_date: date,
      opening_balance: state.openingBalance || 0,
      less_cash_handover: parseFloat(document.getElementById('s-less-handover').value) || 0,
      add_extra: extraData.reduce((s, e) => s + e.amount, 0),
      closing_balance: closingBalance,
      actual_closing_balance: actualClosing,
      variance: variance,
      notes: document.getElementById('s-notes').value?.trim() || '',
      // is_submitted mirrors the app's "final" definition (actual closing entered).
      // The on-submit automation gate queries is_submitted=true, so this must be set.
      is_submitted: actualClosing !== null,
      submitted_at: actualClosing !== null ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    };

    const { error: sumErr } = await db
      .from('cashup_summaries')
      .upsert(summaryData, { onConflict: 'branch_id,entry_date' });

    if (sumErr) throw sumErr;

    // Variance alert — delete any existing alert for this date then insert fresh
    if (variance !== null && Math.abs(variance) >= 0.01) {
      await db.from('cashup_alerts').delete().eq('branch_id', branch.id).eq('entry_date', date);
      const { error: alertErr } = await db.from('cashup_alerts').insert({
        branch_id: branch.id,
        branch_name: branch.name,
        entry_date: date,
        calculated_closing: closingBalance,
        actual_closing: actualClosing,
        variance: variance,
      });
      if (alertErr) console.error('Alert insert error:', alertErr);
      // Fire-and-forget email
      fetch('/.netlify/functions/send-variance-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          branch_name: branch.name,
          entry_date: date,
          calculated_closing: closingBalance,
          actual_closing: actualClosing,
          variance: variance,
        }),
      }).catch(() => {});
    }

    // Fire on_submit automations if this is a final submission
    if (isFinal) checkOnSubmitAutomations(date);

    showToast(isFinal ? 'Cashup submitted ✓' : 'Draft saved ✓', 'success');
    setTimeout(async () => {
      // Always return to today's view — prevents stale status when submitting a previous day's cashup
      state.activeDate = getISTDate();
      await openDashboard();
    }, 1000);

  } catch (err) {
    console.error('Save error:', err);
    const msg = err?.message || err?.details || 'Unknown error';
    showToast(state.isAdmin ? `Save failed: ${msg}` : 'Error saving. Try again.', 'error');
  } finally {
    const draftBtnF = document.getElementById('btn-save-draft');
    const finalBtnF = document.getElementById('btn-submit-final');
    if (draftBtnF) { draftBtnF.disabled = false; draftBtnF.textContent = '💾 Save Draft'; }
    if (finalBtnF) { finalBtnF.disabled = false; finalBtnF.textContent = '✓ Submit Final'; }
  }
}

// ============================================================
// AUTOCOMPLETE (Smart Fill)
// ============================================================

async function loadAutocompleteData(branchId) {
  const [{ data: productData }, { data: nameData }, { data: staffData }] = await Promise.all([
    db.from('cashup_entries').select('product_service').eq('branch_id', branchId)
      .not('product_service', 'is', null).neq('product_service', ''),
    db.from('cashup_entries').select('customer_name').eq('branch_id', branchId)
      .not('customer_name', 'is', null).neq('customer_name', ''),
    db.from('staff_members').select('name').order('name'),
  ]);

  const products = [...new Set((productData || []).map(r => r.product_service).filter(Boolean))].sort();
  const names = [...new Set((nameData || []).map(r => r.customer_name).filter(Boolean))].sort();
  state.staffList = (staffData || []).map(r => r.name).filter(Boolean);
  state.autocompleteData = { products, names };
}

function bindAutocomplete(input, type) {
  const dropdown = document.getElementById('autocomplete-dropdown');

  input.addEventListener('focus', () => showAutocomplete(input, type));
  input.addEventListener('input', () => showAutocomplete(input, type));
  input.addEventListener('blur', () => setTimeout(() => { dropdown.style.display = 'none'; }, 150));
}

function showAutocomplete(input, type) {
  const dropdown = document.getElementById('autocomplete-dropdown');
  const val = input.value.toLowerCase();
  const list = state.autocompleteData[type] || [];
  const matches = val ? list.filter(item => item.toLowerCase().includes(val)) : list;

  if (!matches.length) { dropdown.style.display = 'none'; return; }

  const rect = input.getBoundingClientRect();
  dropdown.style.left = rect.left + 'px';
  dropdown.style.top = (rect.bottom + window.scrollY + 2) + 'px';
  dropdown.style.width = rect.width + 'px';
  dropdown.style.display = 'block';

  dropdown.innerHTML = matches.slice(0, 8).map(m =>
    `<div class="autocomplete-item">${esc(m)}</div>`
  ).join('');

  dropdown.querySelectorAll('.autocomplete-item').forEach(item => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      input.value = item.textContent;
      dropdown.style.display = 'none';
      recalcSummary();
    });
  });
}

// ============================================================
// REPORTS
// ============================================================

let reportState = {
  preset: 'today',
  from: null,
  to: null,
  branch: 'all',
};

function getISTDateOffset(offsetDays) {
  // Use getISTDate() as base and UTC arithmetic to avoid timezone shifts
  const today = getISTDate();
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + offsetDays);
  return dt.toISOString().split('T')[0];
}

function getPresetRange(preset) {
  const today = getISTDate();
  const [y, m] = today.split('-').map(Number);

  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'week': {
      const dt = new Date(Date.UTC(y, m - 1, parseInt(today.split('-')[2])));
      const dow = dt.getUTCDay();
      const mon = new Date(dt); mon.setUTCDate(dt.getUTCDate() - ((dow + 6) % 7));
      return { from: mon.toISOString().split('T')[0], to: today };
    }
    case 'month': {
      const first = new Date(Date.UTC(y, m - 1, 1)).toISOString().split('T')[0];
      return { from: first, to: today };
    }
    case 'lastmonth': {
      const first = new Date(Date.UTC(y, m - 2, 1)).toISOString().split('T')[0];
      const last = new Date(Date.UTC(y, m - 1, 0)).toISOString().split('T')[0];
      return { from: first, to: last };
    }
    default:
      return null;
  }
}

function updateReportsRangeDisplay() {
  const el = document.getElementById('reports-range-display');
  if (!el) return;
  const { from, to } = reportState;
  if (!from || !to) { el.textContent = ''; return; }
  const fmt = d => {
    const [y, m, day] = d.split('-').map(Number);
    return new Date(y, m - 1, day).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  el.textContent = from === to ? fmt(from) : fmt(from) + ' → ' + fmt(to);
}

let _reportsTabInit = false;
function initReportsTab() {
  if (!_reportsTabInit) {
    document.querySelectorAll('.report-preset-btn[data-preset]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.report-preset-btn[data-preset]').forEach(x => x.classList.remove('active'));
        btn.classList.add('active');
        reportState.preset = btn.dataset.preset;
        if (btn.dataset.preset === 'custom') {
          document.getElementById('reports-custom-range').style.display = 'block';
          const today = getPresetRange('today').from;
          document.getElementById('report-date-from').value = reportState.from || today;
          document.getElementById('report-date-to').value = reportState.to || today;
        } else {
          document.getElementById('reports-custom-range').style.display = 'none';
          const r = getPresetRange(btn.dataset.preset);
          reportState.from = r.from;
          reportState.to = r.to;
          updateReportsRangeDisplay();
        }
      });
    });
    document.getElementById('report-date-from').addEventListener('change', e => {
      reportState.from = e.target.value; updateReportsRangeDisplay();
    });
    document.getElementById('report-date-to').addEventListener('change', e => {
      reportState.to = e.target.value; updateReportsRangeDisplay();
    });
    document.getElementById('btn-run-report').addEventListener('click', () => {
      if (!reportState.from || !reportState.to) { showToast('Select a date range first', 'error'); return; }
      if (reportState.from > reportState.to) { showToast('"From" must be before "To"', 'error'); return; }
      runReport();
    });
    _reportsTabInit = true;
  }

  // Populate branch buttons
  const branchFilter = document.getElementById('reports-branch-filter');
  branchFilter.innerHTML = `<button class="report-preset-btn active" data-branch="all">All Branches</button>`;
  state.branches.forEach(b => {
    const btn = document.createElement('button');
    btn.className = 'report-preset-btn';
    btn.dataset.branch = b.id;
    btn.textContent = b.name;
    btn.addEventListener('click', () => {
      branchFilter.querySelectorAll('.report-preset-btn').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      reportState.branch = b.id;
    });
    branchFilter.appendChild(btn);
  });
  branchFilter.querySelector('[data-branch="all"]').addEventListener('click', function() {
    branchFilter.querySelectorAll('.report-preset-btn').forEach(x => x.classList.remove('active'));
    this.classList.add('active');
    reportState.branch = 'all';
  });

  // Reset to "This Month" each time tab opens
  const defaultPreset = 'month';
  document.querySelectorAll('.report-preset-btn[data-preset]').forEach(b => b.classList.toggle('active', b.dataset.preset === defaultPreset));
  const range = getPresetRange(defaultPreset);
  reportState.from = range.from;
  reportState.to = range.to;
  reportState.preset = defaultPreset;
  document.getElementById('reports-custom-range').style.display = 'none';
  updateReportsRangeDisplay();
}

// ============================================================
// REPORTS ENGINE
// ============================================================

// Rebuilt from state.paymentModes by rebuildPaymentLabels(); seeded with defaults here.
let PT_LABEL = {
  cash: 'Cash', scan: 'Scan', upi: 'UPI', icici_machine: 'ICICI Machine',
  pinelab: 'PINELAB', bajaj_finance: 'Bajaj Finance', savein: 'SaveIN', cheque: 'Cheque'
};
const CHART_COLORS = ['#C4922A','#10b981','#3b82f6','#f59e0b','#8b5cf6','#ef4444','#06b6d4','#ec4899'];

let _pendingCharts = [];
let _chartInstances = {};

function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function fmtDateFull(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function getDatesInRange(from, to) {
  const dates = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  let cur = new Date(Date.UTC(fy, fm - 1, fd));
  const end = new Date(Date.UTC(ty, tm - 1, td));
  while (cur <= end) {
    dates.push(cur.toISOString().split('T')[0]);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

function ptBadge(type) {
  const label = PT_LABEL[type] || type;
  const cls = type === 'cash' ? 'cash' : type === 'scan' ? 'scan' : type === 'upi' ? 'upi' : 'other';
  return `<span class="rpt-badge ${cls}">${esc(label)}</span>`;
}

function queueChart(id, type, data, options) {
  _pendingCharts.push({ id, type, data, options });
}

function renderAllCharts() {
  Object.values(_chartInstances).forEach(c => { try { c.destroy(); } catch(e) {} });
  _chartInstances = {};
  _pendingCharts.forEach(({ id, type, data, options }) => {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    _chartInstances[id] = new Chart(canvas, { type, data, options });
  });
  _pendingCharts = [];
}

async function runReport() {
  const { from, to, branch } = reportState;
  const showStaff = true;

  const output = document.getElementById('reports-output');
  output.innerHTML = '<div style="text-align:center;padding:48px 20px;color:#6b7280"><div style="font-size:28px;margin-bottom:12px">⏳</div>Loading report…</div>';

  try {
    let eQ = db.from('cashup_entries').select('*').gte('entry_date', from).lte('entry_date', to).order('entry_date').order('sort_order');
    let xQ = db.from('cashup_expenses').select('*').gte('entry_date', from).lte('entry_date', to).order('entry_date').order('sort_order');
    let sQ = db.from('cashup_summaries').select('*').gte('entry_date', from).lte('entry_date', to).order('entry_date');
    if (branch !== 'all') {
      eQ = eQ.eq('branch_id', branch);
      xQ = xQ.eq('branch_id', branch);
      sQ = sQ.eq('branch_id', branch);
    }
    const [{ data: entries }, { data: expenses }, { data: summaries }] = await Promise.all([eQ, xQ, sQ]);

    const dates = getDatesInRange(from, to);
    const branchMap = Object.fromEntries(state.branches.map(b => [b.id, b.name]));
    const showBranch = branch === 'all' && state.branches.length > 1;
    const branchLabel = branch === 'all' ? 'All Branches' : (branchMap[branch] || branch);
    const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    const E = entries || [], EX = expenses || [], S = summaries || [];

    // KPIs
    const totalSale    = E.reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    const cashSale     = E.filter(e => e.payment_type === 'cash').reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    const nonCashSale  = totalSale - cashSale;
    const totalExp     = EX.reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    const totalHandover = S.reduce((s, r) => s + parseFloat(r.less_cash_handover || 0), 0);
    const totalAdded   = S.reduce((s, r) => s + parseFloat(r.add_extra || 0), 0);

    // Payment types present (non-cash only for donut, all for pills)
    const payTypes = [...new Set(E.map(e => e.payment_type).filter(Boolean))];

    // ── Header ───────────────────────────────────────────────────
    let html = `
      <div class="rpt-header">
        <div class="rpt-header-info">
          <div class="rpt-header-title">📊 Cashup Report — ${esc(branchLabel)}</div>
          <div class="rpt-header-sub">${from === to ? fmtDateFull(from) : fmtDateFull(from) + ' → ' + fmtDateFull(to)} &nbsp;·&nbsp; Generated ${esc(now)}</div>
        </div>
      </div>`;

    // ── KPI grid ─────────────────────────────────────────────────
    html += `<div class="rpt-kpi-grid">
      <div class="rpt-kpi-card accent"><div class="rpt-kpi-label">Total Sale</div><div class="rpt-kpi-value">${formatCurrency(totalSale)}</div></div>
      <div class="rpt-kpi-card green"><div class="rpt-kpi-label">Cash Sale</div><div class="rpt-kpi-value">${formatCurrency(cashSale)}</div></div>
      <div class="rpt-kpi-card"><div class="rpt-kpi-label">Non-Cash Sale</div><div class="rpt-kpi-value">${formatCurrency(nonCashSale)}</div></div>
      <div class="rpt-kpi-card red"><div class="rpt-kpi-label">Expenses</div><div class="rpt-kpi-value">${formatCurrency(totalExp)}</div></div>
      <div class="rpt-kpi-card blue"><div class="rpt-kpi-label">Handovers</div><div class="rpt-kpi-value">${formatCurrency(totalHandover)}</div></div>
      <div class="rpt-kpi-card"><div class="rpt-kpi-label">Cash Added</div><div class="rpt-kpi-value">${formatCurrency(totalAdded)}</div></div>
    </div>`;

    // ── Trend chart (stacked bar + total line) ────────────────────
    if (dates.length > 1 && E.length) {
      const chartId = 'chart-trend-' + Date.now();
      const dailyCash    = dates.map(d => E.filter(e => e.entry_date === d && e.payment_type === 'cash').reduce((s, e) => s + parseFloat(e.amount || 0), 0));
      const dailyNonCash = dates.map(d => E.filter(e => e.entry_date === d && e.payment_type !== 'cash').reduce((s, e) => s + parseFloat(e.amount || 0), 0));
      const dailyTotal   = dates.map((_, i) => dailyCash[i] + dailyNonCash[i]);
      queueChart(chartId, 'bar', {
        labels: dates.map(fmtDate),
        datasets: [
          { label: 'Cash',     data: dailyCash,    backgroundColor: '#10b981', borderRadius: 4, stack: 'a' },
          { label: 'Non-Cash', data: dailyNonCash, backgroundColor: '#C4922A', borderRadius: 4, stack: 'a' },
          { type: 'line', label: 'Total', data: dailyTotal, borderColor: '#374151', backgroundColor: 'transparent',
            tension: 0.3, pointRadius: 3, borderWidth: 2, order: 0 }
        ]
      }, {
        plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, boxWidth: 12 } } },
        scales: {
          y: { stacked: true, ticks: { callback: v => '₹' + (v >= 1000 ? (v/1000).toFixed(0) + 'k' : v), font: { size: 11 } }, grid: { color: '#f3f4f6' } },
          x: { ticks: { font: { size: 11 } }, grid: { display: false } }
        },
        responsive: true, maintainAspectRatio: true
      });
      html += `<div class="rpt-section"><div class="rpt-section-title">Daily Sales Trend</div>
        <div class="rpt-chart-wrap"><canvas id="${chartId}" height="220"></canvas></div></div>`;
    }

    // ── All Transactions (one table, filterable) ──────────────────
    html += buildTransactionsSection(E, showBranch, branchMap, showStaff, payTypes);

    // ── Top Performers ────────────────────────────────────────────
    html += buildTopBranchesSection(E, branchMap);
    html += buildTopStaffSection(E);
    html += buildTopClientsSection(E);

    // ── Expenses ──────────────────────────────────────────────────
    html += buildExpensesSection(EX, showBranch, branchMap);

    // ── Daily Summary (collapsible) ───────────────────────────────
    html += buildDailySummarySection(E, EX, S, dates, showBranch, branchMap);

    output.innerHTML = html;
    renderAllCharts();

  } catch (err) {
    output.innerHTML = `<div class="reports-empty-state"><div style="color:#ef4444;font-size:14px">Error: ${esc(err.message)}</div></div>`;
  }
}

// ── Transactions table with filter pills ─────────────────────────
function buildTransactionsSection(entries, showBranch, branchMap, showStaff, payTypes) {
  if (!entries.length) return rptSection('All Transactions', null, '<div class="rpt-no-data">No transactions for this period</div>');
  const total = entries.reduce((s, e) => s + parseFloat(e.amount || 0), 0);

  const pills = [`<button class="rpt-filter-pill active" onclick="applyTxFilter('all',this)">All</button>`];
  payTypes.forEach(pt => {
    pills.push(`<button class="rpt-filter-pill" onclick="applyTxFilter('${esc(pt)}',this)">${esc(PT_LABEL[pt] || pt)}</button>`);
  });

  const cols = ['Date', ...(showBranch ? ['Branch'] : []), 'Product / Service', 'Customer', ...(showStaff ? ['Staff'] : []), 'Type', 'Amount'];
  const rows = entries.map(e => {
    const amt = parseFloat(e.amount || 0);
    return `<tr class="rpt-tx-row" data-pay-type="${esc(e.payment_type)}" data-amount="${amt}">
      <td>${fmtDate(e.entry_date)}</td>
      ${showBranch ? `<td>${esc(branchMap[e.branch_id] || '')}</td>` : ''}
      <td>${esc(e.product_service || '—')}</td>
      <td>${esc(e.customer_name || '—')}</td>
      ${showStaff ? `<td>${esc(e.staff || '—')}</td>` : ''}
      <td>${ptBadge(e.payment_type)}</td>
      <td class="amt">${formatCurrency(amt)}</td>
    </tr>`;
  }).join('');

  const tfoot = `<tr><td colspan="${cols.length - 1}" style="font-weight:700">Total</td><td class="amt" id="rpt-tx-total">${formatCurrency(total)}</td></tr>`;
  const ths = cols.map(c => `<th${c === 'Amount' ? ' class="amt"' : ''}>${c}</th>`).join('');
  const tableContent = `
    <div class="rpt-filter-pills">${pills.join('')}</div>
    <div class="rpt-table-wrap"><table class="rpt-table" id="rpt-tx-table">
      <thead><tr>${ths}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>${tfoot}</tfoot>
    </table></div>`;

  return `<div class="rpt-section">
    <div class="rpt-section-header">
      <div>
        <div class="rpt-section-title">All Transactions</div>
        <div class="rpt-section-kpi">${formatCurrency(total)}</div>
      </div>
      <button class="rpt-tx-export-btn" onclick="exportTransactionsToDoc()">⬇ Export .doc</button>
    </div>
    ${tableContent}
  </div>`;
}

function exportTransactionsToDoc() {
  const table = document.getElementById('rpt-tx-table');
  if (!table) { showToast('No transactions to export', 'error'); return; }

  // Get active filter label
  const activePill = document.querySelector('.rpt-filter-pill.active');
  const filterLabel = activePill ? activePill.textContent.trim() : 'All';

  // Capture only visible rows
  const thead = table.querySelector('thead').outerHTML;
  const visibleRows = [...table.querySelectorAll('tbody .rpt-tx-row')]
    .filter(r => r.style.display !== 'none')
    .map(r => {
      // Replace badge spans with plain text for .doc
      const clone = r.cloneNode(true);
      clone.querySelectorAll('.rpt-badge').forEach(b => {
        b.style.cssText = 'display:inline-block;padding:1px 6px;border-radius:8px;font-size:11px;font-weight:600;background:#f3f4f6;';
      });
      return clone.outerHTML;
    }).join('');

  const totalEl = document.getElementById('rpt-tx-total');
  const totalText = totalEl ? totalEl.textContent : '';
  const colCount = table.querySelector('thead tr')?.children.length || 6;
  const tfoot = `<tfoot><tr><td colspan="${colCount - 1}" style="font-weight:700;padding:7px 10px;border-top:2px solid #e5e7eb">Total</td><td style="text-align:right;font-weight:700;padding:7px 10px;border-top:2px solid #e5e7eb">${totalText}</td></tr></tfoot>`;

  const { from, to, branch } = reportState;
  const branchMap = Object.fromEntries(state.branches.map(b => [b.id, b.name]));
  const bLabel = branch === 'all' ? 'All Branches' : (branchMap[branch] || branch);
  const dateRange = from === to ? fmtDateFull(from) : `${fmtDateFull(from)} → ${fmtDateFull(to)}`;
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const styles = `
    body { font-family: Arial, sans-serif; font-size: 13px; color: #374151; max-width: 900px; margin: 0 auto; padding: 24px; }
    h2 { font-size: 18px; font-weight: 700; color: #111827; margin: 0 0 4px; }
    .sub { font-size: 12px; color: #6b7280; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { background: #f9fafb; color: #6b7280; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; padding: 7px 10px; text-align: left; border-bottom: 2px solid #e5e7eb; }
    td { padding: 7px 10px; border-bottom: 1px solid #f3f4f6; }
    .amt { text-align: right; font-weight: 600; }
  `;

  const html = `<html><head><meta charset="UTF-8"><style>${styles}</style></head><body>
    <h2>Transactions — ${bLabel}${filterLabel !== 'All' ? ' · ' + filterLabel : ''}</h2>
    <div class="sub">${dateRange} &nbsp;·&nbsp; Generated ${now}</div>
    <table>${thead}<tbody>${visibleRows}</tbody>${tfoot}</table>
  </body></html>`;

  const blob = new Blob([html], { type: 'application/msword' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const fnBranch = bLabel.replace(/\s+/g, '_');
  const fnFilter = filterLabel !== 'All' ? `_${filterLabel.replace(/\s+/g, '')}` : '';
  a.download = `Transactions_${fnBranch}${fnFilter}_${from}_to_${to}.doc`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('Transactions exported ✓', 'success');
}

function applyTxFilter(type, btn) {
  document.querySelectorAll('.rpt-filter-pill').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  let visibleTotal = 0;
  document.querySelectorAll('.rpt-tx-row').forEach(row => {
    const show = type === 'all' || row.dataset.payType === type;
    row.style.display = show ? '' : 'none';
    if (show) visibleTotal += parseFloat(row.dataset.amount || 0);
  });
  const el = document.getElementById('rpt-tx-total');
  if (el) el.textContent = formatCurrency(visibleTotal);
}

// ── Top Performing Branches ───────────────────────────────────────
function buildTopBranchesSection(entries, branchMap) {
  if (!entries.length) return '';
  const totals = {};
  entries.forEach(e => {
    const name = branchMap[e.branch_id] || e.branch_id;
    totals[name] = (totals[name] || 0) + parseFloat(e.amount || 0);
  });
  const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  if (ranked.length < 2) return ''; // only show if more than 1 branch
  const grandTotal = ranked.reduce((s, [, v]) => s + v, 0);
  const medals = ['🥇', '🥈', '🥉'];
  const rows = ranked.map(([name, total], i) => {
    const pct = grandTotal > 0 ? ((total / grandTotal) * 100).toFixed(1) : 0;
    return `<tr>
      <td style="width:32px;font-size:18px;text-align:center">${medals[i] || (i + 1)}</td>
      <td style="font-weight:600">${esc(name)}</td>
      <td class="amt">${formatCurrency(total)}</td>
      <td style="width:140px">
        <div style="background:#f3f4f6;border-radius:99px;height:8px;overflow:hidden">
          <div style="background:var(--primary);height:100%;width:${pct}%;border-radius:99px"></div>
        </div>
      </td>
      <td style="width:48px;text-align:right;font-size:12px;color:#6b7280">${pct}%</td>
    </tr>`;
  }).join('');
  const table = `<div class="rpt-table-wrap"><table class="rpt-table">
    <thead><tr><th></th><th>Branch</th><th class="amt">Total Sale</th><th>Share</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
  return rptSection('Top Performing Branches', null, table);
}

// ── Top Performing Staff ──────────────────────────────────────────
function buildTopStaffSection(entries) {
  if (!entries.length) return '';
  const totals = {};
  entries.forEach(e => {
    const name = (e.staff || '').trim().replace(/\./g, '').replace(/\s+/g, ' ').toUpperCase();
    if (!name) return;
    totals[name] = (totals[name] || 0) + parseFloat(e.amount || 0);
  });
  const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!ranked.length) return '';
  const top = ranked[0][1];
  const medals = ['🥇', '🥈', '🥉'];
  const rows = ranked.map(([name, total], i) => {
    const pct = top > 0 ? ((total / top) * 100).toFixed(1) : 0;
    return `<tr>
      <td style="width:32px;font-size:18px;text-align:center">${medals[i] || (i + 1)}</td>
      <td style="font-weight:600">${esc(name)}</td>
      <td class="amt">${formatCurrency(total)}</td>
      <td style="width:140px">
        <div style="background:#f3f4f6;border-radius:99px;height:8px;overflow:hidden">
          <div style="background:#2563eb;height:100%;width:${pct}%;border-radius:99px"></div>
        </div>
      </td>
      <td style="width:48px;text-align:right;font-size:12px;color:#6b7280">${pct}%</td>
    </tr>`;
  }).join('');
  const table = `<div class="rpt-table-wrap"><table class="rpt-table">
    <thead><tr><th></th><th>Staff</th><th class="amt">Total Sale</th><th>vs. #1</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
  return rptSection('Top 5 Staff', null, table);
}

// ── Top Paying Clients ────────────────────────────────────────────
function buildTopClientsSection(entries) {
  if (!entries.length) return '';
  const totals = {};
  entries.forEach(e => {
    const name = (e.customer_name || '').trim().replace(/\./g, '').replace(/\s+/g, ' ').toUpperCase();
    if (!name) return;
    totals[name] = (totals[name] || 0) + parseFloat(e.amount || 0);
  });
  const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!ranked.length) return '';
  const top = ranked[0][1];
  const medals = ['🥇', '🥈', '🥉'];
  const rows = ranked.map(([name, total], i) => {
    const pct = top > 0 ? ((total / top) * 100).toFixed(1) : 0;
    return `<tr>
      <td style="width:32px;font-size:18px;text-align:center">${medals[i] || (i + 1)}</td>
      <td style="font-weight:600">${esc(name)}</td>
      <td class="amt">${formatCurrency(total)}</td>
      <td style="width:140px">
        <div style="background:#f3f4f6;border-radius:99px;height:8px;overflow:hidden">
          <div style="background:#059669;height:100%;width:${pct}%;border-radius:99px"></div>
        </div>
      </td>
      <td style="width:48px;text-align:right;font-size:12px;color:#6b7280">${pct}%</td>
    </tr>`;
  }).join('');
  const table = `<div class="rpt-table-wrap"><table class="rpt-table">
    <thead><tr><th></th><th>Client</th><th class="amt">Total Spent</th><th>vs. #1</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
  return rptSection('Top 5 Clients', null, table);
}

// ── Expenses table ────────────────────────────────────────────────
function buildExpensesSection(expenses, showBranch, branchMap) {
  const total = expenses.reduce((s, e) => s + parseFloat(e.amount || 0), 0);
  const cols = ['Date', ...(showBranch ? ['Branch'] : []), 'Reason', 'Amount'];
  let rows = expenses.map(e => `<tr>
    <td>${fmtDate(e.entry_date)}</td>
    ${showBranch ? `<td>${esc(branchMap[e.branch_id] || '')}</td>` : ''}
    <td>${esc(e.reason || '—')}</td>
    <td class="amt">${formatCurrency(parseFloat(e.amount || 0))}</td>
  </tr>`).join('');
  if (!expenses.length) rows = `<tr><td colspan="${cols.length}" class="rpt-no-data">No expenses for this period</td></tr>`;
  else rows += `<tr><tfoot><td colspan="${cols.length - 1}" style="font-weight:700">Total</td><td class="amt">${formatCurrency(total)}</td></tfoot></tr>`;
  const tableContent = `<div class="rpt-table-wrap"><table class="rpt-table" id="rpt-exp-table">
    <thead><tr>${cols.map(c => `<th${c === 'Amount' ? ' class="amt"' : ''}>${c}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
  return `<div class="rpt-section">
    <div class="rpt-section-header">
      <div>
        <div class="rpt-section-title">Expenses</div>
        ${expenses.length ? `<div class="rpt-section-kpi">${formatCurrency(total)}</div>` : ''}
      </div>
      ${expenses.length ? `<button class="rpt-tx-export-btn" onclick="exportExpensesToDoc()">⬇ Export .doc</button>` : ''}
    </div>
    ${tableContent}
  </div>`;
}

function exportExpensesToDoc() {
  const table = document.getElementById('rpt-exp-table');
  if (!table) { showToast('No expenses to export', 'error'); return; }

  const { from, to, branch } = reportState;
  const branchMap = Object.fromEntries(state.branches.map(b => [b.id, b.name]));
  const bLabel = branch === 'all' ? 'All Branches' : (branchMap[branch] || branch);
  const dateRange = from === to ? fmtDateFull(from) : `${fmtDateFull(from)} → ${fmtDateFull(to)}`;
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const styles = `
    body { font-family: Arial, sans-serif; font-size: 13px; color: #374151; max-width: 900px; margin: 0 auto; padding: 24px; }
    h2 { font-size: 18px; font-weight: 700; color: #111827; margin: 0 0 4px; }
    .sub { font-size: 12px; color: #6b7280; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { background: #f9fafb; color: #6b7280; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; padding: 7px 10px; text-align: left; border-bottom: 2px solid #e5e7eb; }
    td { padding: 7px 10px; border-bottom: 1px solid #f3f4f6; }
    .amt { text-align: right; font-weight: 600; }
    tfoot td { font-weight: 700; border-top: 2px solid #e5e7eb; border-bottom: none; }
  `;

  const html = `<html><head><meta charset="UTF-8"><style>${styles}</style></head><body>
    <h2>Expenses — ${bLabel}</h2>
    <div class="sub">${dateRange} &nbsp;·&nbsp; Generated ${now}</div>
    ${table.outerHTML}
  </body></html>`;

  const blob = new Blob([html], { type: 'application/msword' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `Expenses_${bLabel.replace(/\s+/g, '_')}_${from}_to_${to}.doc`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast('Expenses exported ✓', 'success');
}

// ── Daily Summary (collapsible) ───────────────────────────────────
function buildDailySummarySection(entries, expenses, summaries, dates, showBranch, branchMap) {
  if (!summaries.length) return '';
  const cols = ['Date', ...(showBranch ? ['Branch'] : []), 'Total Sale', 'Cash', 'Non-Cash', 'Handover', 'Expenses', 'Closing Bal'];
  const amtCols = new Set(['Total Sale', 'Cash', 'Non-Cash', 'Handover', 'Expenses', 'Closing Bal']);
  const ths = cols.map(c => `<th${amtCols.has(c) ? ' class="amt"' : ''}>${c}</th>`).join('');

  const rows = summaries.map(s => {
    const bid = s.branch_id;
    const d = s.entry_date;
    const dayE = entries.filter(e => e.branch_id === bid && e.entry_date === d);
    const dayX = expenses.filter(e => e.branch_id === bid && e.entry_date === d);
    const dayTotal = dayE.reduce((a, e) => a + parseFloat(e.amount || 0), 0);
    const dayCash  = dayE.filter(e => e.payment_type === 'cash').reduce((a, e) => a + parseFloat(e.amount || 0), 0);
    const dayExp   = dayX.reduce((a, e) => a + parseFloat(e.amount || 0), 0);
    const handover = parseFloat(s.less_cash_handover || 0);
    const closing  = parseFloat(s.closing_balance || 0);
    return `<tr>
      <td>${fmtDate(d)}</td>
      ${showBranch ? `<td>${esc(branchMap[bid] || '')}</td>` : ''}
      <td class="amt">${formatCurrency(dayTotal)}</td>
      <td class="amt">${formatCurrency(dayCash)}</td>
      <td class="amt">${formatCurrency(dayTotal - dayCash)}</td>
      <td class="amt">${handover > 0 ? formatCurrency(handover) : '—'}</td>
      <td class="amt">${dayExp > 0 ? formatCurrency(dayExp) : '—'}</td>
      <td class="amt">${formatCurrency(closing)}</td>
    </tr>`;
  }).join('');

  const tableContent = `<div class="rpt-table-wrap"><table class="rpt-table">
    <thead><tr>${ths}</tr></thead><tbody>${rows}</tbody>
  </table></div>`;

  return `<div class="rpt-section">
    <button class="rpt-summary-toggle" onclick="toggleDailySummary(this)">
      <span class="toggle-arrow">▶</span>&nbsp; Daily Summary
    </button>
    <div class="rpt-daily-body" style="display:none">${tableContent}</div>
  </div>`;
}

function toggleDailySummary(btn) {
  btn.classList.toggle('open');
  const body = btn.nextElementSibling;
  body.style.display = body.style.display === 'none' ? '' : 'none';
}

function rptSection(title, kpi, body) {
  return `<div class="rpt-section">
    <div class="rpt-section-title">${title}</div>
    ${kpi ? `<div class="rpt-section-kpi">${kpi}</div>` : ''}
    ${body}
  </div>`;
}

function tableHtml(cols, rows) {
  const ths = cols.map(c => `<th${c === 'Amount' ? ' class="amt"' : ''}>${c}</th>`).join('');
  return `<div class="rpt-table-wrap"><table class="rpt-table"><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function chartOpts(prefix = '') {
  return {
    plugins: { legend: { display: false } },
    scales: {
      y: {
        ticks: {
          callback: v => prefix + (v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v),
          font: { size: 11 }
        },
        grid: { color: '#f3f4f6' }
      },
      x: { ticks: { font: { size: 11 } }, grid: { display: false } }
    },
    responsive: true,
    maintainAspectRatio: true,
  };
}

async function exportReportToDoc() {
  const output = document.getElementById('reports-output');
  if (!output || output.querySelector('.reports-empty-state')) { showToast('Run a report first', 'error'); return; }

  // Capture charts as images
  Object.entries(_chartInstances).forEach(([id, chart]) => {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    const img = document.createElement('img');
    img.src = canvas.toDataURL('image/png');
    img.style.cssText = 'max-width:100%;margin-bottom:16px;display:block';
    canvas.parentNode.replaceChild(img, canvas);
  });

  const styles = `
    body { font-family: Arial, sans-serif; font-size: 13px; color: #374151; max-width: 800px; margin: 0 auto; padding: 20px; }
    .rpt-header { padding: 16px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 4px; margin-bottom: 16px; }
    .rpt-header-title { font-size: 18px; font-weight: 700; color: #111827; }
    .rpt-header-sub { font-size: 12px; color: #6b7280; margin-top: 4px; }
    .rpt-export-btn { display: none; }
    .rpt-section { background: #fff; border: 1px solid #e5e7eb; border-radius: 4px; padding: 16px; margin-bottom: 16px; page-break-inside: avoid; }
    .rpt-section-title { font-size: 14px; font-weight: 700; margin-bottom: 4px; }
    .rpt-section-kpi { font-size: 22px; font-weight: 800; color: #C4922A; margin-bottom: 12px; }
    .rpt-chart-wrap { margin-bottom: 14px; }
    .rpt-chart-wrap img { max-width: 100%; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { background: #f9fafb; color: #6b7280; font-weight: 600; font-size: 11px; padding: 7px 10px; text-align: left; border-bottom: 1px solid #e5e7eb; }
    td { padding: 7px 10px; border-bottom: 1px solid #f3f4f6; }
    .amt { text-align: right; font-weight: 600; }
    .rpt-badge { padding: 1px 6px; border-radius: 8px; font-size: 11px; font-weight: 600; background: #f3f4f6; }
    .rpt-badge.cash { background: #dcfce7; } .rpt-badge.scan { background: #dbeafe; }
    .rpt-badge.upi { background: #ede9fe; } .rpt-badge.other { background: #fef3c7; }
    tfoot td { font-weight: 700; border-top: 2px solid #e5e7eb; border-bottom: none; }
  `;

  const html = `<html><head><meta charset="UTF-8"><style>${styles}</style></head><body>${output.innerHTML}</body></html>`;
  const blob = new Blob([html], { type: 'application/msword' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);

  const { from, to, branch } = reportState;
  const branchMap = Object.fromEntries(state.branches.map(b => [b.id, b.name]));
  const bLabel = branch === 'all' ? 'All' : (branchMap[branch] || branch).replace(/\s+/g, '_');
  a.download = `CashupReport_${bLabel}_${from}_to_${to}.doc`;
  a.click();
  URL.revokeObjectURL(a.href);

  showToast('Report exported ✓', 'success');

  // Re-render charts (we replaced canvases with images for export)
  runReport();
}

// ============================================================
// EVENT BINDINGS
// ============================================================

function bindGlobalEvents() {
  // Close staff dropdowns when clicking outside
  document.addEventListener('click', e => {
    if (!e.target.closest('.staff-dropdown-wrap') && !e.target.closest('#staff-portal-panel')) closeAllStaffPanels();
  });

  // PIN screen
  document.getElementById('btn-pin-back').addEventListener('click', () => {
    state.currentBranch = null;
    state.pinBuffer = '';
    showScreen('home');
  });

  document.getElementById('btn-pin-clear').addEventListener('click', () => {
    state.pinBuffer = '';
    document.getElementById('pin-error').textContent = '';
    updatePinDots();
  });

  document.getElementById('btn-pin-del').addEventListener('click', () => {
    state.pinBuffer = state.pinBuffer.slice(0, -1);
    updatePinDots();
  });

  document.querySelectorAll('.num-btn[data-val]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (state.pinBuffer.length >= 4) return;
      state.pinBuffer += btn.dataset.val;
      updatePinDots();
      if (state.pinBuffer.length === 4) {
        setTimeout(verifyPIN, 150);
      }
    });
  });

  // Keyboard / numpad input for PIN screen
  document.addEventListener('keydown', (e) => {
    const pinScreen = document.getElementById('screen-pin');
    if (!pinScreen || !pinScreen.classList.contains('active')) return;
    // Ignore if focus is inside a text input (e.g. forgot PIN modal)
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.key >= '0' && e.key <= '9') {
      if (state.pinBuffer.length >= 4) return;
      state.pinBuffer += e.key;
      updatePinDots();
      if (state.pinBuffer.length === 4) setTimeout(verifyPIN, 150);
    } else if (e.key === 'Backspace') {
      state.pinBuffer = state.pinBuffer.slice(0, -1);
      updatePinDots();
    } else if (e.key === 'Escape') {
      state.pinBuffer = '';
      document.getElementById('pin-error').textContent = '';
      updatePinDots();
    }
  });

  document.getElementById('btn-forgot-pin').addEventListener('click', forgotPIN);

  // Forgot PIN modal
  document.getElementById('btn-forgot-cancel').addEventListener('click', () => {
    document.getElementById('modal-forgot-pin').style.display = 'none';
  });
  document.getElementById('btn-forgot-submit').addEventListener('click', sendForgotPIN);

  // Branch panel — logout / back-to-admin
  function branchExit() {
    if (state.cameFromAdmin) {
      state.cameFromAdmin = false;
      saveSession('admin', null);
      openAdminPanel();
    } else {
      logout();
    }
  }
  document.getElementById('btn-branch-logout')?.addEventListener('click', branchExit);
  document.getElementById('btn-branch-logout-mobile')?.addEventListener('click', branchExit);

  // Branch side-panel tab switching (Daily Cashup / Emails / Leads)
  document.querySelectorAll('.sidebar-item[data-btab], .bottom-nav-item[data-btab]').forEach(btn => {
    btn.addEventListener('click', () => switchBranchTab(btn.dataset.btab));
  });

  document.getElementById('btn-open-cashup').addEventListener('click', () => {
    openCashupForm(state.activeDate);
  });

  // Date navigator — prev/next arrows
  document.getElementById('btn-date-prev').addEventListener('click', () => {
    const prev = getPrevDate(state.activeDate);
    const minDate = state.isAdmin ? null : getISTDateOffset(-7);
    if (!state.isAdmin && prev < minDate) return;
    navigateDashboardDate(prev);
  });

  document.getElementById('btn-date-next').addEventListener('click', () => {
    const next = getNextDate(state.activeDate);
    const today = getISTDate();
    if (next <= today) navigateDashboardDate(next);
  });

  // Date navigator — click label to open calendar picker
  document.getElementById('dash-date-badge').addEventListener('click', () => {
    const picker = document.getElementById('dash-date-picker');
    picker.max = getISTDate();
    picker.min = state.isAdmin ? '' : getISTDateOffset(-7);
    picker.value = state.activeDate;
    picker.showPicker?.();
    picker.focus();
  });

  document.getElementById('dash-date-picker').addEventListener('change', (e) => {
    const val = e.target.value;
    const today = getISTDate();
    const minDate = state.isAdmin ? null : getISTDateOffset(-7);
    if (!val || val > today) return;
    if (!state.isAdmin && val < minDate) return;
    navigateDashboardDate(val);
  });

  // (Date override listeners removed — date navigation handled by date-nav at top)

  // Cashup form
  document.getElementById('btn-cashup-back').addEventListener('click', () => {
    stopLiveClock();
    openDashboard();
  });

  document.getElementById('btn-add-entry').addEventListener('click', () => addEntryRow());
  document.getElementById('btn-add-expense').addEventListener('click', () => addExpenseRow());
  document.getElementById('btn-add-extra-row').addEventListener('click', () => addExtraRow());
  document.getElementById('btn-save-draft').addEventListener('click', () => saveCashup(false));
  document.getElementById('btn-submit-final').addEventListener('click', () => saveCashup(true));

  ['s-less-handover', 's-actual-closing'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', recalcSummary);
  });

  // Admin Panel — exit (sidebar + mobile) → full logout to home
  document.getElementById('btn-admin-panel-back')?.addEventListener('click', logout);
  document.getElementById('btn-admin-panel-back-mobile')?.addEventListener('click', logout);

  // Admin sidebar + bottom nav tab switching (switchAdminTab is global)
  document.querySelectorAll('.sidebar-item[data-tab], .bottom-nav-item[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchAdminTab(btn.dataset.tab));
  });

  document.getElementById('btn-add-branch-admin').addEventListener('click', showAddBranchModal);

  // Automations
  loadAutomations();
  document.getElementById('btn-add-automation').addEventListener('click', () => showAutomationModal());
  document.getElementById('btn-automation-cancel').addEventListener('click', () => {
    document.getElementById('modal-automation').style.display = 'none';
  });
  document.getElementById('modal-automation').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-automation'))
      document.getElementById('modal-automation').style.display = 'none';
  });
  document.getElementById('btn-automation-save').addEventListener('click', saveAutomation);
  document.getElementById('auto-trigger-type').addEventListener('change', (e) => {
    updateAutoTriggerUI(e.target.value);
  });
  // Reload automations when switching to settings tab


  // Date override panel removed from Overview (was replaced by KPI filters)

  document.getElementById('btn-save-admin-pin').addEventListener('click', saveAdminPIN);

  // Clear the "Product/Service required" highlight as soon as staff start typing
  document.addEventListener('input', (e) => {
    if (e.target?.classList?.contains('e-product')) e.target.classList.remove('field-error');
  });

  // Collapsible Settings sections — toggle on header click (ignore clicks on controls)
  document.querySelectorAll('#admin-tab-settings .settings-head').forEach(head => {
    head.addEventListener('click', (e) => {
      if (e.target.closest('button, input, select, a')) return;
      head.closest('.settings-card')?.classList.toggle('collapsed');
    });
  });

  // Payment Modes (admin settings)
  document.getElementById('btn-add-payment-mode')?.addEventListener('click', addPaymentMode);
  document.getElementById('new-payment-mode-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addPaymentMode(); }
  });

  // Branch modal
  document.getElementById('btn-modal-cancel').addEventListener('click', () => {
    document.getElementById('modal-branch').style.display = 'none';
  });
  document.getElementById('btn-modal-save').addEventListener('click', saveBranchModal);

  // Delete branch confirmation modal
  document.getElementById('btn-delete-cancel').addEventListener('click', () => {
    document.getElementById('modal-delete-branch').style.display = 'none';
  });

  // Close autocomplete on scroll
  window.addEventListener('scroll', () => {
    document.getElementById('autocomplete-dropdown').style.display = 'none';
  });
}

// ============================================================
// DATE UTILITIES
// ============================================================

function getISTDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.TIMEZONE }).format(new Date());
}

function formatDisplayDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  }).format(date);
}

function formatDateSeparator(dateStr) {
  const today   = new Date();
  const msgDate = new Date(dateStr + 'T00:00:00');
  const diff    = Math.floor((today - msgDate) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return msgDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatConvoTime(isoStr) {
  const date    = new Date(isoStr);
  const now     = new Date();
  const diffMs  = now - date;
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffDay === 0) return date.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7)  return date.toLocaleDateString('en-IN', { weekday: 'short' });
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function formatShortDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

function getDateRanges(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  // Use UTC throughout for reliable date arithmetic
  const today = new Date(Date.UTC(y, m - 1, d));

  const dow = today.getUTCDay();
  const diffToMon = (dow === 0 ? -6 : 1 - dow);
  const weekStart = new Date(today); weekStart.setUTCDate(today.getUTCDate() + diffToMon);
  const weekEnd = new Date(weekStart); weekEnd.setUTCDate(weekStart.getUTCDate() + 6);

  const lWeekStart = new Date(weekStart); lWeekStart.setUTCDate(weekStart.getUTCDate() - 7);
  const lWeekEnd = new Date(weekEnd); lWeekEnd.setUTCDate(weekEnd.getUTCDate() - 7);

  const monthStart = new Date(Date.UTC(y, m - 1, 1));
  const monthEnd = new Date(Date.UTC(y, m, 0));

  const lMonthStart = new Date(Date.UTC(y, m - 2, 1));
  const lMonthEnd = new Date(Date.UTC(y, m - 1, 0));

  const fmt = dt => dt.toISOString().split('T')[0];
  return {
    weekStart: fmt(weekStart), weekEnd: fmt(weekEnd),
    lWeekStart: fmt(lWeekStart), lWeekEnd: fmt(lWeekEnd),
    monthStart: fmt(monthStart), monthEnd: fmt(monthEnd),
    lMonthStart: fmt(lMonthStart), lMonthEnd: fmt(lMonthEnd),
  };
}

// ============================================================
// CURRENCY + UTILS
// ============================================================

function formatCurrency(amount) {
  const n = parseFloat(amount) || 0;
  return CONFIG.CURRENCY + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let toastTimer;
function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 2800);
}

// ============================================================
// BOOT
// ============================================================

document.addEventListener('DOMContentLoaded', init);
