const POLL_MS = 500;
const REMOVE_DELAY_MS = 4000;

const THEME_KEY = 'humanai-theme';

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const icon = document.getElementById('toggle-icon');
    const label = document.getElementById('toggle-label');
    if (icon) {
        icon.textContent = theme === 'light' ? '\u263e' : '\u263d';
    }
    if (label) {
        label.textContent = theme === 'light' ? 'Light' : 'Dark';
    }
}

function initTheme() {
    let theme = null;
    try {
        theme = localStorage.getItem(THEME_KEY);
    } catch (e) {}
    if (theme !== 'light' && theme !== 'dark') {
        theme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    }
    applyTheme(theme);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try {
        localStorage.setItem(THEME_KEY, next);
    } catch (e) {}
}

initTheme();

let requests = {};
let idOrder = [];
let selectedId = null;
let lastTabsHTML = null;
let lastToolUIRequestId = null;
let serverInstanceId = null;

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function contentToText(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(p => {
            if (typeof p === 'string') return p;
            if (p.type === 'text') return p.text || '';
            if (p.type === 'image_url') return '[image]';
            return JSON.stringify(p);
        }).join('\n');
    }
    return JSON.stringify(content, null, 2);
}

function reqState(id, request) {
    return {
        id: id,
        request: request,
        handled: false,
        reqView: 'formatted',
        currentMode: 'text',
        responseText: '',
        pendingToolCalls: [],
        availableTools: request.tools || [],
        selectedTool: 0,
        currentToolIndex: 0,
        paramKeys: [],
        paramValues: {},
        focusPending: true
    };
}

function renderTabs() {
    const bar = document.getElementById('tabs-bar');
    const pendingCount = idOrder.filter(id => !requests[id].handled).length;
    let html = '<span class="tab-count">' + pendingCount + ' pending</span>';
    if (!idOrder.length) {
        html += '<span class="no-tabs">No active requests.</span>';
    } else {
        html += idOrder.map(id => {
            const r = requests[id];
            const cls = 'tab' + (id === selectedId ? ' active' : '') + (r.handled ? ' handled' : '');
            return '<button class="' + cls + '" onclick="selectTab(' + id + ')">Request #' + id +
                   (r.handled ? ' (done)' : '') +
                   '<span class="tab-close" onclick="event.stopPropagation();removeTab(' + id + ')">&times;</span></button>';
        }).join('');
    }
    if (lastTabsHTML !== html) {
        lastTabsHTML = html;
        bar.innerHTML = html;
    }
}

function selectTab(id) {
    if (selectedId !== null && requests[selectedId]) {
        requests[selectedId].responseText = document.getElementById('response-input').value;
    }
    selectedId = id;
    renderTabs();
    renderActive();
}

function removeTab(id) {
    if (!(id in requests)) return;
    const wasSelected = selectedId === id;
    delete requests[id];
    idOrder = idOrder.filter(x => x !== id);
    if (wasSelected) {
        selectedId = idOrder.length ? idOrder[idOrder.length - 1] : null;
    }
    renderTabs();
    renderActive();
}

function setReqView(view) {
    if (selectedId !== null && requests[selectedId]) requests[selectedId].reqView = view;
    renderActive();
}

function switchMode(mode) {
    if (selectedId !== null && requests[selectedId]) requests[selectedId].currentMode = mode;
    renderActive();
}

function renderRequestFormatted(req) {
    let html = '';
    html += '<div class="req-meta">';
    html += '<div><span class="meta-label">Model:</span> ' + escapeHtml(req.model || 'unknown') + '</div>';
    html += '<div><span class="meta-label">Stream:</span> ' + (req.stream ? 'yes' : 'no') + '</div>';
    if (req.temperature !== undefined) html += '<div><span class="meta-label">Temperature:</span> ' + escapeHtml(String(req.temperature)) + '</div>';
    if (req.max_tokens !== undefined) html += '<div><span class="meta-label">Max tokens:</span> ' + escapeHtml(String(req.max_tokens)) + '</div>';
    html += '</div>';

    html += '<h3>Messages</h3>';
    const msgs = req.messages || [];
    if (!msgs.length) html += '<div class="no-tools">No messages.</div>';
    msgs.forEach(m => { html += renderMessage(m); });

    return html;
}

function renderRequestTools(req) {
    const tools = (req && req.tools) || [];
    if (!tools.length) {
        return '<div class="no-tools">No tools available.</div>';
    }
    let html = '<h3>Available Tools</h3>';
    html += '<div class="tools-details">';
    tools.forEach(t => {
        const fn = t.function || {};
        html += '<div class="tool-card">';
        html += '<div class="tool-card-name">' + escapeHtml(fn.name) + '</div>';
        if (fn.description) html += '<div class="tool-card-desc">' + escapeHtml(fn.description) + '</div>';
        const params = fn.parameters || {};
        if (params.properties && Object.keys(params.properties).length) {
            html += '<details class="tool-schema"><summary>parameters</summary><pre>' + escapeHtml(JSON.stringify(params, null, 2)) + '</pre></details>';
        }
        html += '</div>';
    });
    html += '</div>';
    return html;
}

function renderMessage(m) {
    const role = m.role || 'unknown';
    let html = '<div class="msg msg-' + escapeHtml(role) + '">';
    html += '<div class="msg-role">' + escapeHtml(role) + '</div>';
    if (m.name) html += '<div class="msg-meta-line">name: ' + escapeHtml(m.name) + '</div>';
    if (m.tool_call_id) html += '<div class="msg-meta-line">tool_call_id: ' + escapeHtml(m.tool_call_id) + '</div>';
    const content = contentToText(m.content);
    if (content) html += '<div class="msg-content">' + escapeHtml(content) + '</div>';
    if (m.tool_calls && m.tool_calls.length) {
        m.tool_calls.forEach(tc => {
            const fn = tc.function || {};
            let args = fn.arguments;
            if (typeof args === 'object') args = JSON.stringify(args, null, 2);
            try { args = JSON.stringify(JSON.parse(args), null, 2); } catch(e) {}
            html += '<div class="toolcall">';
            html += '<div class="toolcall-name">' + escapeHtml(fn.name || '') + (tc.id ? ' <span style="color:var(--muted);font-weight:normal">(' + escapeHtml(tc.id) + ')</span>' : '') + '</div>';
            html += '<pre class="toolcall-args">' + escapeHtml(args) + '</pre>';
            html += '</div>';
        });
    }
    html += '</div>';
    return html;
}

function populateToolSelect(r) {
    if (!r) return;
    const select = document.getElementById('tool-select');
    if (!r.availableTools.length) {
        select.innerHTML = '<option value="">No tools available</option>';
    } else {
        select.innerHTML = r.availableTools.map((t, i) => {
            const fn = t.function || {};
            return '<option value="' + i + '">' + escapeHtml(fn.name) + '</option>';
        }).join('');
        if (r.selectedTool >= r.availableTools.length) r.selectedTool = 0;
        select.selectedIndex = r.selectedTool;
    }
}

function onToolSelected() {
    if (selectedId === null) return;
    const r = requests[selectedId];
    r.selectedTool = document.getElementById('tool-select').selectedIndex;
    renderToolParams(r);
}

function getSelectedFn(r) {
    const idx = document.getElementById('tool-select').selectedIndex;
    const t = r.availableTools[idx];
    return t ? (t.function || {}) : null;
}

function renderToolParams(r) {
    if (!r) return;
    const fn = getSelectedFn(r);
    const box = document.getElementById('tool-params');
    if (!fn) {
        box.innerHTML = '<div class="no-tools">No tools available.</div>';
        r.paramKeys = [];
        return;
    }
    const props = (fn.parameters || {}).properties || {};
    const required = (fn.parameters || {}).required || [];
    const keys = Object.keys(props);
    r.paramKeys = keys;
    let html = '';
    html += '<div class="param-tool-name">' + escapeHtml(fn.name) + '</div>';
    if (fn.description) html += '<div class="param-tool-desc">' + escapeHtml(fn.description) + '</div>';
    if (!keys.length) html += '<div class="no-params">No parameters required.</div>';
    keys.forEach((k, i) => {
        const p = props[k];
        const id = 'param-' + i;
        const star = required.includes(k) ? ' <span class="req">*</span>' : '';
        const saved = (k in r.paramValues) ? r.paramValues[k] : undefined;
        html += '<div class="param">';
        html += '<label class="param-label" for="' + id + '">' + escapeHtml(k) + star + '</label>';
        if (p.type === 'boolean') {
            const checked = saved !== undefined ? !!saved : p.default === true;
            html += '<input type="checkbox" id="' + id + '" class="param-input param-bool"' + (checked ? ' checked' : '') + ' onchange="saveParam(' + r.id + ',' + i + ')">';
        } else if (p.type === 'number' || p.type === 'integer') {
            const val = saved !== undefined ? saved : p.default;
            html += '<input type="number" id="' + id + '" class="param-input" step="any"' + (val !== undefined ? ' value="' + escapeHtml(String(val)) + '"' : '') + ' oninput="saveParam(' + r.id + ',' + i + ')">';
        } else if (p.type === 'array' || p.type === 'object') {
            const def = saved !== undefined ? saved : p.default;
            const defStr = (def === undefined || def === null) ? '' : (typeof def === 'object' ? JSON.stringify(def, null, 2) : String(def));
            const ph = p.type === 'array' ? 'e.g. ["a", "b"]' : 'e.g. {"key": "value"}';
            html += '<textarea id="' + id + '" class="param-input param-json" placeholder="' + escapeHtml(ph) + '" oninput="saveParam(' + r.id + ',' + i + ')">' + escapeHtml(defStr) + '</textarea>';
        } else {
            const val = saved !== undefined ? saved : p.default;
            html += '<input type="text" id="' + id + '" class="param-input" placeholder="' + escapeHtml(p.description || '') + '"' + (val !== undefined ? ' value="' + escapeHtml(String(val)) + '"' : '') + ' oninput="saveParam(' + r.id + ',' + i + ')">';
        }
        if (p.description && p.type !== 'string') html += '<div class="param-desc">' + escapeHtml(p.description) + '</div>';
        html += '</div>';
    });
    box.innerHTML = html;
}

function saveParam(rid, i) {
    const r = requests[rid];
    if (!r) return;
    const el = document.getElementById('param-' + i);
    if (!el || !r.paramKeys || i >= r.paramKeys.length) return;
    const k = r.paramKeys[i];
    r.paramValues[k] = (el.type === 'checkbox') ? el.checked : el.value;
}

function collectParams(r) {
    const fn = getSelectedFn(r);
    const args = {};
    if (!fn) return args;
    const props = (fn.parameters || {}).properties || {};
    r.paramKeys.forEach((k, i) => {
        const el = document.getElementById('param-' + i);
        if (!el) return;
        const p = props[k];
        if (p.type === 'boolean') {
            args[k] = el.checked;
        } else if (p.type === 'number' || p.type === 'integer') {
            if (el.value !== '') args[k] = Number(el.value);
        } else if (p.type === 'array') {
            try { args[k] = el.value.trim() ? JSON.parse(el.value) : []; } catch(e) { args[k] = el.value; }
        } else if (p.type === 'object') {
            try { args[k] = el.value.trim() ? JSON.parse(el.value) : {}; } catch(e) { args[k] = el.value; }
        } else {
            args[k] = el.value;
        }
    });
    return args;
}

function addToolCall() {
    if (selectedId === null) return;
    const r = requests[selectedId];
    const fn = getSelectedFn(r);
    const statusEl = document.getElementById('submit-status');
    if (!fn) {
        statusEl.textContent = "No tools available to call.";
        statusEl.style.color = "#f87171";
        return;
    }
    const args = collectParams(r);
    r.currentToolIndex += 1;
    r.pendingToolCalls.push({
        id: 'call_' + r.currentToolIndex,
        function: { name: fn.name, arguments: JSON.stringify(args, null, 2) }
    });
    renderToolCallList(r);
    statusEl.textContent = "";
}

function removeToolCall(i) {
    if (selectedId === null) return;
    requests[selectedId].pendingToolCalls.splice(i, 1);
    renderToolCallList(requests[selectedId]);
}

function renderToolCallList(r) {
    if (!r) return;
    const list = document.getElementById('tool-call-list');
    let html = '<h3>Pending Tool Calls</h3>';
    if (!r.pendingToolCalls.length) {
        html += '<div class="no-tools">None yet. Pick a tool, fill in the fields, then click "Add Tool Call".</div>';
    }
    r.pendingToolCalls.forEach((tc, i) => {
        let args = tc.function.arguments;
        try { args = JSON.stringify(JSON.parse(args), null, 2); } catch(e) {}
        html += '<div class="pending-call">';
        html += '<div class="pending-call-header"><span class="toolcall-name">' + escapeHtml(tc.function.name) + '</span><span class="pending-call-id">' + escapeHtml(tc.id) + '</span><button class="remove-btn" onclick="removeToolCall(' + i + ')">Remove</button></div>';
        html += '<pre class="pending-call-args">' + escapeHtml(args) + '</pre>';
        html += '</div>';
    });
    list.innerHTML = html;
}

function scrollFormattedToBottom() {
    if (selectedId === null || !requests[selectedId]) return;
    if (requests[selectedId].reqView !== 'formatted') return;
    const el = document.getElementById('request-formatted');
    if (el) el.scrollTop = el.scrollHeight;
}

function renderActive() {
    const statusEl = document.getElementById('status');
    const payloadEl = document.getElementById('request-payload');
    const reqFormattedEl = document.getElementById('request-formatted');
    const reqToolsEl = document.getElementById('request-tools');
    const modeToggle = document.getElementById('mode-toggle');
    const responseInput = document.getElementById('response-input');
    const toolUI = document.getElementById('tool-call-ui');
    const submitBtn = document.getElementById('submit-btn');
    const submitStatus = document.getElementById('submit-status');
    const btnFormatted = document.getElementById('btn-formatted');
    const btnTools = document.getElementById('btn-tools');
    const btnRaw = document.getElementById('btn-raw');

    if (selectedId === null || !requests[selectedId]) {
        statusEl.textContent = "Idle. Waiting for CLI requests...";
        statusEl.className = "status idle";
        payloadEl.style.display = 'block';
        payloadEl.textContent = "No request selected.";
        reqFormattedEl.style.display = 'none';
        reqToolsEl.style.display = 'none';
        btnFormatted.classList.toggle('active', true);
        btnTools.classList.toggle('active', false);
        btnRaw.classList.toggle('active', false);
        responseInput.value = '';
        responseInput.disabled = true;
        submitBtn.disabled = true;
        modeToggle.style.display = 'none';
        toolUI.style.display = 'none';
        submitStatus.textContent = '';
        return;
    }

    const r = requests[selectedId];

    if (r.handled) {
        statusEl.textContent = "Handled. This request was answered.";
        statusEl.className = "status idle";
        payloadEl.style.display = 'block';
        payloadEl.textContent = "Request handled successfully.";
        reqFormattedEl.style.display = 'none';
        reqToolsEl.style.display = 'none';
        responseInput.disabled = true;
        submitBtn.disabled = true;
        modeToggle.style.display = 'none';
        toolUI.style.display = 'none';
        submitStatus.textContent = '';
        return;
    }

    statusEl.textContent = "Waiting for your response...";
    statusEl.className = "status waiting";
    submitStatus.textContent = '';

    const rawPayload = JSON.stringify(r.request, null, 2);
    if (payloadEl.textContent !== rawPayload) {
        payloadEl.textContent = rawPayload;
    }
    payloadEl.style.display = r.reqView === 'raw' ? 'block' : 'none';
    reqFormattedEl.style.display = r.reqView === 'formatted' ? 'block' : 'none';
    reqToolsEl.style.display = r.reqView === 'tools' ? 'block' : 'none';
    btnFormatted.classList.toggle('active', r.reqView === 'formatted');
    btnTools.classList.toggle('active', r.reqView === 'tools');
    btnRaw.classList.toggle('active', r.reqView === 'raw');
    if (r.reqView === 'formatted') {
        const html = renderRequestFormatted(r.request);
        if (reqFormattedEl.innerHTML !== html) {
            reqFormattedEl.innerHTML = html;
        }
    } else if (r.reqView === 'tools') {
        const html = renderRequestTools(r.request);
        if (reqToolsEl.innerHTML !== html) {
            reqToolsEl.innerHTML = html;
        }
    }

    modeToggle.style.display = 'flex';
    document.querySelectorAll('input[name="resp-mode"]').forEach(inp => {
        inp.checked = (inp.value === r.currentMode);
    });
    if (document.activeElement !== responseInput && responseInput.value !== r.responseText) {
        responseInput.value = r.responseText;
    }
    responseInput.disabled = false;
    if (r.currentMode === 'tool_calls') {
        responseInput.style.display = 'none';
        toolUI.style.display = 'block';
    } else {
        responseInput.style.display = '';
        toolUI.style.display = 'none';
    }
    submitBtn.disabled = false;

    if (lastToolUIRequestId !== r.id) {
        populateToolSelect(r);
        renderToolParams(r);
        lastToolUIRequestId = r.id;
    }
    renderToolCallList(r);

    if (r.focusPending) {
        r.focusPending = false;
        responseInput.focus();
    }
}

function resetState() {
    requests = {};
    idOrder = [];
    selectedId = null;
    lastTabsHTML = null;
    lastToolUIRequestId = null;
}

async function poll() {
    let res, data;
    try {
        res = await fetch('/api/status');
        data = await res.json();
    } catch (e) {
        return;
    }

    if (data.instance_id !== serverInstanceId) {
        resetState();
        serverInstanceId = data.instance_id;
    }

    const serverIds = data.requests.map(x => x.request_id);

    const hadActiveSelection = selectedId !== null && requests[selectedId] && !requests[selectedId].handled;
    let newMessageArrived = false;
    data.requests.forEach(x => {
        if (!(x.request_id in requests)) {
            requests[x.request_id] = reqState(x.request_id, x.request);
            idOrder.push(x.request_id);
            if (!hadActiveSelection) {
                selectedId = x.request_id;
            }
            newMessageArrived = true;
        }
    });

    if (newMessageArrived) {
        scrollFormattedToBottom();
    }

    idOrder.forEach(id => {
        if (!serverIds.includes(id) && !requests[id].handled) {
            requests[id].handled = true;
            setTimeout(function() { removeTab(id); }, REMOVE_DELAY_MS);
        }
    });

    if (selectedId !== null && !requests[selectedId]) {
        selectedId = idOrder.length ? idOrder[idOrder.length - 1] : null;
    }

    renderTabs();
    renderActive();
}

async function submitResponse() {
    if (selectedId === null) return;
    const r = requests[selectedId];
    const statusEl = document.getElementById('submit-status');
    const submitBtn = document.getElementById('submit-btn');

    r.responseText = document.getElementById('response-input').value;

    let payload;
    if (r.currentMode === 'tool_calls') {
        if (!r.pendingToolCalls.length) {
            statusEl.textContent = "Error: Add at least one tool call first.";
            statusEl.style.color = "#f87171";
            return;
        }
        payload = { request_id: r.id, response_type: "tool_calls", tool_calls: r.pendingToolCalls };
    } else {
        payload = { request_id: r.id, response_type: "text", response: r.responseText };
    }

    submitBtn.disabled = true;
    statusEl.textContent = "Sending to CLI...";
    statusEl.style.color = "#fbbf24";

    const res = await fetch('/api/respond', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
    });

    if (res.ok) {
        statusEl.textContent = "Response sent!";
        statusEl.style.color = "#34d399";
    } else {
        const err = await res.json().catch(() => ({}));
        statusEl.textContent = "Error: " + (err.error || 'failed');
        statusEl.style.color = "#f87171";
        submitBtn.disabled = false;
    }
}

renderTabs();
renderActive();
setInterval(poll, POLL_MS);
poll();
