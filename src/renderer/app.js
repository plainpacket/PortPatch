'use strict';

const api = window.sshRouter;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  config: null,
  secrets: {},
  encryption: null,
  statuses: {},
  logs: [],
  platform: 'win32',
  selectedRouteId: null,
  selectedNodeId: null,
  saveQueue: Promise.resolve(),
  edgeDraft: null,
  nodeDrag: null,
  canvasPan: null,
  routeEditor: null,
  modalCleanup: null,
  suppressNodeClick: false,
  zoom: 1,
  logViewClearedAt: 0,
};

const GRAPH_WIDTH = 1200;
const GRAPH_HEIGHT = 1200;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.8;
const PARALLEL_EDGE_GAP = 136;

const STATUS_LABELS = {
  idle: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  reconnecting: 'Reconnecting',
  stopping: 'Stopping',
  error: 'Error',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function clone(value) {
  return structuredClone(value);
}

function applyTheme(theme) {
  const normalized = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = normalized;
  api.setWindowTheme(normalized).catch(() => {});
}

function expandIpv6(host) {
  const expandEmbeddedIpv4 = (groups) => {
    const index = groups.findIndex((group) => group.includes('.'));
    if (index === -1) return groups;
    if (index !== groups.length - 1) return null;
    const octets = groups[index].split('.');
    if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return null;
    return [
      ...groups.slice(0, index),
      ((Number(octets[0]) << 8) | Number(octets[1])).toString(16),
      ((Number(octets[2]) << 8) | Number(octets[3])).toString(16),
    ];
  };
  const parts = host.split('::');
  if (parts.length > 2) return null;
  const left = expandEmbeddedIpv4(parts[0] ? parts[0].split(':') : []);
  const right = expandEmbeddedIpv4(parts[1] ? parts[1].split(':') : []);
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((parts.length === 1 && missing !== 0) || (parts.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

function canonicalHost(value) {
  let host = String(value || '').trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.split('%')[0];
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4 && ipv4.slice(1).every((part) => Number(part) <= 255)) return ipv4.slice(1).map(Number).join('.');
  const ipv6 = expandIpv6(host);
  if (ipv6) return ipv6.map((group) => group.toString(16)).join(':');
  return host;
}

function isLoopbackBind(value) {
  const host = canonicalHost(value);
  if (host === 'localhost' || host.startsWith('127.')) return true;
  const groups = expandIpv6(host);
  return Boolean(groups && groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1);
}

function isWildcardBind(value) {
  const host = canonicalHost(value);
  if (host === '*' || host === '0.0.0.0') return true;
  const groups = expandIpv6(host);
  return Boolean(groups && groups.every((group) => group === 0));
}

function bindsOverlap(first, second) {
  const left = canonicalHost(first);
  const right = canonicalHost(second);
  if (left === right || isWildcardBind(left) || isWildcardBind(right)) return true;
  return (left === 'localhost' && isLoopbackBind(right)) || (right === 'localhost' && isLoopbackBind(left));
}

function routeRequiresExternalConsent(sourceNodeId, bindHost) {
  return sourceNodeId !== 'local' || !isLoopbackBind(bindHost);
}

function makeId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function nodeById(nodeId) {
  if (nodeId === 'local') return { ...state.config.localNode, kind: 'local' };
  const server = state.config.servers.find((item) => item.id === nodeId);
  return server ? { ...server, kind: 'server' } : null;
}

function configNodeById(nodeId) {
  if (nodeId === 'local') return state.config.localNode;
  return state.config.servers.find((item) => item.id === nodeId) || null;
}

function nodeName(nodeId) {
  return nodeById(nodeId)?.name || nodeId;
}

function routeStatus(routeId) {
  return state.statuses[routeId] || {
    routeId,
    state: 'idle',
    desired: false,
    activeConnections: 0,
    bytesUp: 0,
    bytesDown: 0,
    lastError: null,
  };
}

function statusClass(status) {
  return ['starting', 'running', 'reconnecting', 'error'].includes(status?.state) ? status.state : 'idle';
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function describeRoute(route) {
  const source = nodeName(route.source.nodeId);
  const target = nodeName(route.target.nodeId);
  if (route.protocol === 'socks5') {
    return `Listen for SOCKS5 on ${source} at ${route.source.bindHost}:${route.source.port} and use ${target} as egress`;
  }
  return `Listen on ${source} at ${route.source.bindHost}:${route.source.port} and forward to ${target} at ${route.target.host}:${route.target.port}`;
}

function toast(message, type = '') {
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.textContent = message;
  $('#toast-stack').append(element);
  setTimeout(() => element.remove(), 4200);
}

async function persistConfig(secretUpdates = {}) {
  const snapshot = clone(state.config);
  const serializedSnapshot = JSON.stringify(snapshot);
  const operation = state.saveQueue
    .catch(() => {})
    .then(() => api.saveConfig({ config: snapshot, secretUpdates }));
  state.saveQueue = operation;
  try {
    const result = await operation;
    if (JSON.stringify(state.config) === serializedSnapshot) state.config = result.config;
    state.secrets = result.secrets;
    return result;
  } catch (error) {
    try {
      const current = await api.getState();
      state.config = current.config;
      state.secrets = current.secrets;
      state.encryption = current.encryption;
      state.statuses = current.statuses;
      renderAll();
    } catch {
      // Preserve the original save error.
    }
    throw error;
  }
}

function renderSecurityBadge() {
  const badge = $('#security-badge');
  if (!badge) return;
  if (!state.encryption) return;
  if (state.encryption.warning || !state.encryption.available) {
    badge.classList.add('warning');
    badge.textContent = state.encryption.backend === 'basic_text' ? 'Secure storage warning' : 'Secure storage unavailable';
    badge.title = state.encryption.warning || 'Operating-system encryption is unavailable.';
  } else {
    badge.classList.remove('warning');
    const names = { dpapi: 'Windows DPAPI', keychain: 'macOS Keychain' };
    badge.textContent = `Credentials protected - ${names[state.encryption.backend] || state.encryption.backend}`;
    badge.title = 'Passwords and key passphrases are encrypted by the operating system.';
  }
}

function nodeAggregate(nodeId) {
  const related = state.config.routes.filter((route) => route.source.nodeId === nodeId || route.target.nodeId === nodeId);
  const statuses = related.map((route) => routeStatus(route.id));
  return {
    routes: related.length,
    desired: statuses.filter((status) => status.desired).length,
    connections: statuses.reduce((total, status) => total + Number(status.activeConnections || 0), 0),
    hasError: statuses.some((status) => status.state === 'error'),
  };
}

function renderSidebar() {
  const nodes = [nodeById('local'), ...state.config.servers.map((server) => ({ ...server, kind: 'server' }))];
  $('#node-list').innerHTML = nodes.map((node) => {
    const aggregate = nodeAggregate(node.id);
    const meta = node.kind === 'local' ? 'This computer' : `${node.username}@${node.host}:${node.port}`;
    return `
      <button class="side-item ${node.kind === 'local' ? 'local' : ''} ${state.selectedNodeId === node.id ? 'selected' : ''}" data-node-list-id="${escapeHtml(node.id)}" type="button">
        <span class="side-icon">${node.kind === 'local' ? 'PC' : 'SSH'}</span>
        <span class="side-copy"><strong>${escapeHtml(node.name)}</strong><span>${escapeHtml(meta)}</span></span>
        <i class="side-state ${aggregate.hasError ? 'error' : aggregate.desired ? 'running' : ''}"></i>
      </button>`;
  }).join('');

  const routes = state.config.routes;
  $('#route-list').innerHTML = routes.length ? routes.map((route) => {
    const status = routeStatus(route.id);
    return `
      <button class="side-item ${state.selectedRouteId === route.id ? 'selected' : ''}" data-route-list-id="${escapeHtml(route.id)}" type="button">
        <span class="side-icon">${route.protocol === 'socks5' ? 'S5' : 'TCP'}</span>
        <span class="side-copy"><strong>${escapeHtml(route.name)}</strong><span>${escapeHtml(nodeName(route.source.nodeId))} :${route.source.port} &rarr; ${escapeHtml(nodeName(route.target.nodeId))}</span></span>
        <i class="side-state ${statusClass(status)}"></i>
      </button>`;
  }).join('') : '<div class="side-empty">Hold Ctrl and drag one node<br>onto another to create a route.</div>';

  const active = routes.filter((route) => routeStatus(route.id).desired).length;
  $('#active-count').textContent = `${active}/${routes.length}`;
  $('#start-all-button').disabled = routes.length === 0;
  $('#stop-all-button').disabled = active === 0;

  $$('[data-node-list-id]').forEach((button) => button.addEventListener('click', () => {
    selectNode(button.dataset.nodeListId);
  }));
  $$('[data-route-list-id]').forEach((button) => button.addEventListener('click', () => {
    selectRoute(button.dataset.routeListId);
  }));
}

function graphNodes() {
  return [
    { ...state.config.localNode, kind: 'local' },
    ...state.config.servers.map((server) => ({ ...server, kind: 'server' })),
  ];
}

function initials(name) {
  const cleaned = String(name || '').trim();
  if (!cleaned) return 'SSH';
  const chunks = cleaned.split(/\s+/).filter(Boolean);
  return chunks.length > 1 ? `${chunks[0][0]}${chunks[1][0]}`.toUpperCase() : cleaned.slice(0, 2).toUpperCase();
}

function visibleNodePosition(node) {
  return {
    x: Math.max(30, Math.min(GRAPH_WIDTH - 260, Number(node.position?.x || 0))),
    y: Math.max(30, Math.min(GRAPH_HEIGHT - 142, Number(node.position?.y || 0))),
  };
}

function renderGraph() {
  const nodes = graphNodes();
  $('#nodes').innerHTML = nodes.map((node) => {
    const aggregate = nodeAggregate(node.id);
    const meta = node.kind === 'local' ? 'Local network' : `${node.username}@${node.host}`;
    const footer = aggregate.desired
      ? `${aggregate.desired} routes running - ${aggregate.connections} connections`
      : aggregate.routes ? `${aggregate.routes} routes - all stopped` : 'No connected routes';
    return `
      <article class="node-card ${node.kind === 'local' ? 'local' : ''} ${state.selectedNodeId === node.id ? 'selected' : ''}" data-node-id="${escapeHtml(node.id)}" aria-label="Drag ${escapeHtml(node.name)} to move it. Hold Ctrl and drag to create a route.">
        <div class="node-drag">
          <span class="node-avatar">${escapeHtml(node.kind === 'local' ? 'PC' : initials(node.name))}</span>
          <span class="node-title"><strong>${escapeHtml(node.name)}</strong><span>${escapeHtml(meta)}</span></span>
          <button class="node-menu" type="button" data-edit-node="${escapeHtml(node.id)}" aria-label="Node settings">...</button>
        </div>
        <div class="node-footer"><span class="node-health ${aggregate.desired ? 'active' : ''}"><i></i>${escapeHtml(footer)}</span><span>${node.kind === 'local' ? 'LOCAL' : `:${node.port}`}</span></div>
      </article>`;
  }).join('');

  for (const node of nodes) {
    const card = $(`[data-node-id="${CSS.escape(node.id)}"]`);
    const position = visibleNodePosition(node);
    card.style.left = `${position.x}px`;
    card.style.top = `${position.y}px`;
  }

  $$('.node-card').forEach((card) => card.addEventListener('click', (event) => {
    if (state.suppressNodeClick) {
      event.stopPropagation();
      return;
    }
    if (!event.target.closest('.node-menu')) selectNode(card.dataset.nodeId);
  }));
  $$('.node-card').forEach((card) => card.addEventListener('dblclick', (event) => {
    if (!event.target.closest('.node-menu')) editNode(card.dataset.nodeId);
  }));
  $$('[data-edit-node]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    editNode(button.dataset.editNode);
  }));
  $$('.node-card').forEach((card) => card.addEventListener('pointerdown', beginNodeInteraction));

  $('#canvas-empty-hint').classList.toggle('is-hidden', state.config.servers.length > 0);
  renderEdges();
}

function nodeCenter(nodeId) {
  const node = nodeById(nodeId);
  if (!node) return { x: 0, y: 0 };
  const position = visibleNodePosition(node);
  return {
    x: position.x + 115,
    y: position.y + 56,
  };
}

function nodeBoundaryPoint(nodeId, toward) {
  const center = nodeCenter(nodeId);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  if (!dx && !dy) return { x: center.x + 115, y: center.y };
  const scale = 1 / Math.max(Math.abs(dx) / 115, Math.abs(dy) / 56);
  return { x: center.x + dx * scale, y: center.y + dy * scale };
}

function edgePath(source, target) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const direction = Math.sign(dx) || 1;
    const control = Math.max(80, Math.min(260, Math.abs(dx) * 0.48));
    return `M ${source.x} ${source.y} C ${source.x + direction * control} ${source.y}, ${target.x - direction * control} ${target.y}, ${target.x} ${target.y}`;
  }
  const direction = Math.sign(dy) || 1;
  const control = Math.max(65, Math.min(220, Math.abs(dy) * 0.45));
  return `M ${source.x} ${source.y} C ${source.x} ${source.y + direction * control}, ${target.x} ${target.y - direction * control}, ${target.x} ${target.y}`;
}

function routePairKey(route) {
  return [route.source.nodeId, route.target.nodeId].sort().join('\u0000');
}

function routeLaneOffset(route) {
  const pairKey = routePairKey(route);
  const parallelRoutes = state.config.routes.filter((candidate) => routePairKey(candidate) === pairKey);
  const index = parallelRoutes.findIndex((candidate) => candidate.id === route.id);
  return (index - (parallelRoutes.length - 1) / 2) * PARALLEL_EDGE_GAP;
}

function cubicPoint(source, firstControl, secondControl, target, progress = 0.5) {
  const remaining = 1 - progress;
  return {
    x: remaining ** 3 * source.x
      + 3 * remaining ** 2 * progress * firstControl.x
      + 3 * remaining * progress ** 2 * secondControl.x
      + progress ** 3 * target.x,
    y: remaining ** 3 * source.y
      + 3 * remaining ** 2 * progress * firstControl.y
      + 3 * remaining * progress ** 2 * secondControl.y
      + progress ** 3 * target.y,
  };
}

function routeGeometry(route) {
  const sourceCenter = nodeCenter(route.source.nodeId);
  const targetCenter = nodeCenter(route.target.nodeId);
  const canonicalIds = [route.source.nodeId, route.target.nodeId].sort();
  const canonicalSource = nodeCenter(canonicalIds[0]);
  const canonicalTarget = nodeCenter(canonicalIds[1]);
  const dx = canonicalTarget.x - canonicalSource.x;
  const dy = canonicalTarget.y - canonicalSource.y;
  const distance = Math.hypot(dx, dy) || 1;
  const laneOffset = routeLaneOffset(route);
  const normal = { x: -dy / distance, y: dx / distance };
  const midpoint = {
    x: (sourceCenter.x + targetCenter.x) / 2 + (-dy / distance) * laneOffset,
    y: (sourceCenter.y + targetCenter.y) / 2 + (dx / distance) * laneOffset,
  };
  const source = nodeBoundaryPoint(route.source.nodeId, midpoint);
  const target = nodeBoundaryPoint(route.target.nodeId, midpoint);
  const firstControl = {
    x: source.x + (target.x - source.x) / 3 + normal.x * laneOffset,
    y: source.y + (target.y - source.y) / 3 + normal.y * laneOffset,
  };
  const secondControl = {
    x: source.x + (target.x - source.x) * 2 / 3 + normal.x * laneOffset,
    y: source.y + (target.y - source.y) * 2 / 3 + normal.y * laneOffset,
  };
  return {
    source,
    target,
    firstControl,
    secondControl,
    label: cubicPoint(source, firstControl, secondControl, target),
    path: `M ${source.x} ${source.y} C ${firstControl.x} ${firstControl.y}, ${secondControl.x} ${secondControl.y}, ${target.x} ${target.y}`,
  };
}

function formatEdgeEndpoint(host, port) {
  const displayPort = String(port || '----');
  if (isLoopbackBind(host)) return displayPort;
  let displayHost = String(host || '').trim();
  if (displayHost.startsWith('[') && displayHost.endsWith(']')) displayHost = displayHost.slice(1, -1);
  if (displayHost.includes(':')) displayHost = `[${displayHost}]`;
  return `${displayHost}:${displayPort}`;
}

function renderEdges() {
  const groups = state.config.routes.map((route) => {
    const geometry = routeGeometry(route);
    const { path } = geometry;
    const status = routeStatus(route.id);
    const selected = state.selectedRouteId === route.id ? 'selected' : '';
    const x = geometry.label.x;
    const y = geometry.label.y - 9;
    const labelSource = formatEdgeEndpoint(route.source.bindHost, route.source.port);
    const labelTarget = route.protocol === 'socks5'
      ? 'SOCKS5'
      : formatEdgeEndpoint(route.target.host, route.target.port);
    const labelWidth = Math.max(96, Math.min(230, 34 + `${labelSource} -> ${labelTarget}`.length * 5.7));
    return `
      <g class="edge-group" data-edge-id="${escapeHtml(route.id)}">
        <path class="route-edge ${statusClass(status)} ${selected}" d="${path}"></path>
        <path class="route-edge-hit" d="${path}"></path>
        <rect class="edge-label-bg" x="${x - labelWidth / 2}" y="${y - 10}" width="${labelWidth}" height="29"></rect>
        <text class="edge-label" x="${x}" y="${y + 1}"><tspan>${escapeHtml(labelSource)}</tspan><tspan class="edge-label-arrow"> &#8594; </tspan><tspan>${escapeHtml(labelTarget)}</tspan></text>
        <text class="edge-label-protocol" x="${x}" y="${y + 12}">${status.activeConnections || 0} connections</text>
      </g>`;
  }).join('');
  $('#edges').innerHTML = groups;
  $$('.edge-group').forEach((group) => group.addEventListener('click', (event) => {
    event.stopPropagation();
    openRouteEditor(group.dataset.edgeId);
  }));
  positionRouteEditor();
}

function updateGraphNodesRuntime() {
  for (const node of graphNodes()) {
    const card = $(`[data-node-id="${CSS.escape(node.id)}"]`);
    if (!card) continue;
    const aggregate = nodeAggregate(node.id);
    const footer = aggregate.desired
      ? `${aggregate.desired} routes running - ${aggregate.connections} connections`
      : aggregate.routes ? `${aggregate.routes} routes - all stopped` : 'No connected routes';
    const health = $('.node-health', card);
    health.classList.toggle('active', aggregate.desired > 0);
    health.innerHTML = `<i></i>${escapeHtml(footer)}`;
  }
}

function applyZoom(nextZoom, clientX = null, clientY = null) {
  const viewport = $('#canvas-viewport');
  const world = $('#graph-world');
  const canvas = $('#graph-canvas');
  const oldZoom = state.zoom;
  const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
  if (Math.abs(next - oldZoom) < 0.001) return;
  const viewportRect = viewport.getBoundingClientRect();
  const anchorX = clientX == null ? viewport.clientWidth / 2 : clientX - viewportRect.left;
  const anchorY = clientY == null ? viewport.clientHeight / 2 : clientY - viewportRect.top;
  const sceneX = (viewport.scrollLeft + anchorX) / oldZoom;
  const sceneY = (viewport.scrollTop + anchorY) / oldZoom;
  state.zoom = next;
  world.style.width = `${GRAPH_WIDTH * next}px`;
  world.style.height = `${GRAPH_HEIGHT * next}px`;
  canvas.style.transform = `scale(${next})`;
  viewport.scrollLeft = sceneX * next - anchorX;
  viewport.scrollTop = sceneY * next - anchorY;
  $('#zoom-level').textContent = `${Math.round(next * 100)}%`;
}

function zoomCanvasBy(factor, clientX = null, clientY = null) {
  applyZoom(state.zoom * factor, clientX, clientY);
}

function handleCanvasWheel(event) {
  event.preventDefault();
  zoomCanvasBy(Math.exp(-event.deltaY * 0.0012), event.clientX, event.clientY);
}

function canvasPoint(clientX, clientY) {
  const rect = $('#graph-canvas').getBoundingClientRect();
  const scaleX = rect.width / GRAPH_WIDTH || state.zoom;
  const scaleY = rect.height / GRAPH_HEIGHT || state.zoom;
  return {
    x: (clientX - rect.left) / scaleX,
    y: (clientY - rect.top) / scaleY,
  };
}

function beginNodeInteraction(event) {
  event.stopPropagation();
  if (event.ctrlKey) beginEdgeDraft(event);
  else beginNodeDrag(event);
}

function beginNodeDrag(event) {
  if (event.button !== 0 || event.target.closest('.node-menu')) return;
  const nodeId = event.currentTarget.dataset.nodeId;
  const node = nodeById(nodeId);
  const position = visibleNodePosition(node);
  const pointer = canvasPoint(event.clientX, event.clientY);
  state.nodeDrag = {
    nodeId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    grabOffsetX: pointer.x - position.x,
    grabOffsetY: pointer.y - position.y,
    active: false,
  };
  document.addEventListener('pointermove', moveNodeDrag);
  document.addEventListener('pointerup', endNodeDrag, { once: true });
}

function moveNodeDrag(event) {
  const drag = state.nodeDrag;
  if (!drag) return;
  if (!drag.active) {
    const distance = Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY);
    if (distance < 5) return;
    closeRouteEditor(true);
    drag.active = true;
  }
  const node = configNodeById(drag.nodeId);
  if (!node) return;
  const pointer = canvasPoint(event.clientX, event.clientY);
  const x = Math.max(30, Math.min(GRAPH_WIDTH - 260, pointer.x - drag.grabOffsetX));
  const y = Math.max(30, Math.min(GRAPH_HEIGHT - 142, pointer.y - drag.grabOffsetY));
  node.position = { x, y };
  const card = $(`[data-node-id="${CSS.escape(drag.nodeId)}"]`);
  if (card) {
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
  }
  renderEdges();
  event.preventDefault();
}

function endNodeDrag() {
  document.removeEventListener('pointermove', moveNodeDrag);
  const drag = state.nodeDrag;
  state.nodeDrag = null;
  if (!drag?.active) return;
  state.suppressNodeClick = true;
  setTimeout(() => { state.suppressNodeClick = false; }, 0);
  persistConfig().catch((error) => toast(error.message, 'error'));
}

function beginCanvasPan(event) {
  if (event.button !== 0 || event.target.closest('.node-card, .edge-group, .edge-editor-card, .canvas-empty-hint, button, input, select, summary')) return;
  const viewport = $('#canvas-viewport');
  state.canvasPan = {
    startClientX: event.clientX,
    startClientY: event.clientY,
    originScrollLeft: viewport.scrollLeft,
    originScrollTop: viewport.scrollTop,
    active: false,
  };
  document.addEventListener('pointermove', moveCanvasPan);
  document.addEventListener('pointerup', endCanvasPan, { once: true });
  event.preventDefault();
}

function moveCanvasPan(event) {
  const pan = state.canvasPan;
  if (!pan) return;
  if (!pan.active) {
    const distance = Math.hypot(event.clientX - pan.startClientX, event.clientY - pan.startClientY);
    if (distance < 4) return;
    pan.active = true;
    $('#canvas-viewport').classList.add('is-panning');
  }
  const viewport = $('#canvas-viewport');
  viewport.scrollLeft = pan.originScrollLeft - (event.clientX - pan.startClientX);
  viewport.scrollTop = pan.originScrollTop - (event.clientY - pan.startClientY);
  event.preventDefault();
}

function endCanvasPan() {
  document.removeEventListener('pointermove', moveCanvasPan);
  state.canvasPan = null;
  $('#canvas-viewport').classList.remove('is-panning');
}

function beginEdgeDraft(event) {
  if (event.button !== 0 || event.target.closest('.node-menu')) return;
  const sourceNodeId = event.currentTarget.dataset.nodeId;
  state.edgeDraft = {
    sourceNodeId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    active: false,
  };
  document.addEventListener('pointermove', moveEdgeDraft);
  document.addEventListener('pointerup', endEdgeDraft, { once: true });
  event.preventDefault();
}

function moveEdgeDraft(event) {
  const draftState = state.edgeDraft;
  if (!draftState) return;
  if (!draftState.active) {
    const distance = Math.hypot(event.clientX - draftState.startClientX, event.clientY - draftState.startClientY);
    if (distance < 7) return;
    closeRouteEditor(true);
    draftState.active = true;
    $(`[data-node-id="${CSS.escape(draftState.sourceNodeId)}"]`)?.classList.add('route-source');
    $('#draft-edge').classList.remove('is-hidden');
  }
  const pointer = canvasPoint(event.clientX, event.clientY);
  const source = nodeBoundaryPoint(draftState.sourceNodeId, pointer);
  $('#draft-edge').setAttribute('d', edgePath(source, pointer));
  $$('.node-card').forEach((card) => card.classList.remove('drop-target'));
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.node-card');
  if (target && target.dataset.nodeId !== draftState.sourceNodeId) target.classList.add('drop-target');
  event.preventDefault();
}

function endEdgeDraft(event) {
  document.removeEventListener('pointermove', moveEdgeDraft);
  const draft = state.edgeDraft;
  state.edgeDraft = null;
  $$('.node-card').forEach((card) => card.classList.remove('drop-target', 'route-source'));
  $('#draft-edge').classList.add('is-hidden');
  if (!draft?.active) return;
  state.suppressNodeClick = true;
  setTimeout(() => { state.suppressNodeClick = false; }, 0);
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.node-card');
  if (target && target.dataset.nodeId !== draft.sourceNodeId) createRouteEdge(draft.sourceNodeId, target.dataset.nodeId);
}

function selectNode(nodeId) {
  closeRouteEditor(true);
  state.selectedNodeId = nodeId;
  state.selectedRouteId = null;
  renderSidebar();
  renderGraph();
  renderInspector();
  const node = nodeById(nodeId);
  if (node) {
    const viewport = $('#canvas-viewport');
    viewport.scrollTo({
      left: Math.max(0, node.position.x * state.zoom - 180),
      top: Math.max(0, node.position.y * state.zoom - 160),
      behavior: 'smooth',
    });
  }
}

function selectRoute(routeId) {
  if (state.routeEditor?.routeId !== routeId) closeRouteEditor(true);
  state.selectedRouteId = routeId;
  state.selectedNodeId = null;
  renderSidebar();
  renderGraph();
  renderInspector();
}

function renderInspector() {
  const route = state.config.routes.find((item) => item.id === state.selectedRouteId);
  $('#inspector-empty').classList.toggle('is-hidden', Boolean(route));
  $('#inspector-content').classList.toggle('is-hidden', !route);
  if (!route) return;
  const status = routeStatus(route.id);
  const isDraft = Boolean(state.routeEditor?.isNew && state.routeEditor.routeId === route.id);
  const isRunning = status.desired;
  const targetAddress = route.protocol === 'socks5' ? 'Determined per request' : `${route.target.host}:${route.target.port}`;
  $('#inspector-content').innerHTML = `
    <span class="inspector-kicker">${route.protocol === 'socks5' ? 'SOCKS5 EGRESS' : 'TCP ROUTE'}</span>
    <div class="inspector-title-row">
      <h2>${escapeHtml(route.name)}</h2>
      <span class="status-pill ${statusClass(status)}">${isDraft ? 'Editing' : (STATUS_LABELS[status.state] || status.state)}</span>
    </div>
    <p class="inspector-description">${escapeHtml(describeRoute(route))}</p>
    <div class="route-flow">
      <div class="flow-endpoint"><span>LISTEN</span><strong>${escapeHtml(nodeName(route.source.nodeId))}</strong><code>${escapeHtml(route.source.bindHost)}:${route.source.port}</code></div>
      <div class="flow-arrow">&rarr;</div>
      <div class="flow-endpoint"><span>${route.protocol === 'socks5' ? 'EGRESS' : 'TARGET'}</span><strong>${escapeHtml(nodeName(route.target.nodeId))}</strong><code>${escapeHtml(targetAddress)}</code></div>
    </div>
    <div class="metrics">
      <div class="metric"><span>Connections</span><strong>${status.activeConnections || 0}</strong></div>
      <div class="metric"><span>Sent</span><strong>${formatBytes(status.bytesUp)}</strong></div>
      <div class="metric"><span>Received</span><strong>${formatBytes(status.bytesDown)}</strong></div>
    </div>
    ${status.lastError ? `<div class="error-card">${escapeHtml(status.lastError)}${status.retryInMs ? `<br>Retrying in ${Math.ceil(status.retryInMs / 1000)} seconds.` : ''}</div>` : ''}
    <div class="route-options">
      <span class="option-chip">${route.reconnect ? 'Automatic reconnection' : 'No reconnection'}</span>
      <span class="option-chip">${escapeHtml(route.source.bindHost)}</span>
    </div>
    <div class="inspector-actions">
      <button id="route-toggle-button" class="button ${isRunning ? 'button-danger' : 'button-success'} wide" type="button" ${isDraft ? 'disabled' : ''}>${isRunning ? 'Stop route' : 'Start route'}</button>
      <button id="route-edit-button" class="button button-ghost" type="button">Edit settings</button>
      <button id="route-delete-button" class="button button-ghost" type="button">Delete route</button>
    </div>`;
  if (!isDraft) $('#route-toggle-button').addEventListener('click', () => toggleRoute(route.id));
  $('#route-edit-button').addEventListener('click', () => openRouteEditor(route.id));
  $('#route-delete-button').addEventListener('click', () => deleteRoute(route.id));
}

async function toggleRoute(routeId) {
  const status = routeStatus(routeId);
  try {
    if (status.desired) await api.stopRoute(routeId);
    else await api.startRoute(routeId);
  } catch (error) {
    toast(error.message, 'error');
  }
}

function openModal(content, wide = false, cleanup = null) {
  closeRouteEditor(true);
  state.modalCleanup = cleanup;
  const modal = $('#modal');
  modal.className = `modal ${wide ? 'wide' : ''}`;
  modal.innerHTML = content;
  $('#modal-backdrop').classList.remove('is-hidden');
  $$('[data-close-modal]', modal).forEach((button) => button.addEventListener('click', closeModal));
}

function closeModal(options = {}) {
  const cleanup = state.modalCleanup;
  state.modalCleanup = null;
  $('#modal-backdrop').classList.add('is-hidden');
  $('#modal').innerHTML = '';
  if (!options?.skipCleanup) cleanup?.();
}

function credentialStorageNote() {
  if (state.encryption?.backend === 'dpapi') {
    return 'Encrypted with Windows DPAPI for your Windows account. Stored at %APPDATA%\\PortPatch\\secrets.json.';
  }
  if (state.encryption?.backend === 'keychain') {
    return 'Encrypted with the system keychain and stored in PortPatch per-user app data as secrets.json.';
  }
  return 'Stored in PortPatch per-user app data as secrets.json using the secure storage available on this system.';
}

function serverFormTemplate(server, existing, metadata) {
  return `
    <div class="modal-header">
      <div><h2 id="modal-title">${existing ? 'Server settings' : 'Add SSH server'}</h2><p>Only servers with a verified host key can be used in port routes.</p></div>
      <button class="icon-button small" data-close-modal type="button" aria-label="Close">x</button>
    </div>
    <div class="modal-body">
      <form id="server-form" class="form-grid">
        <div class="form-field full"><label for="server-name">Display name</label><input id="server-name" value="${escapeHtml(server.name)}" placeholder="Example: GPU Server" required></div>
        <div class="form-field"><label for="server-host">Host or IP address</label><input id="server-host" value="${escapeHtml(server.host)}" placeholder="gpu.example.com" required></div>
        <div class="form-field"><label for="server-port">SSH port</label><input id="server-port" type="number" min="1" max="65535" value="${server.port || 22}" required></div>
        <div class="form-field"><label for="server-username">Username</label><input id="server-username" value="${escapeHtml(server.username)}" placeholder="ubuntu" required></div>
        <div class="form-field"><label for="server-auth">Authentication</label><select id="server-auth"><option value="key" ${server.authMode === 'key' ? 'selected' : ''}>Private key</option><option value="password" ${server.authMode === 'password' ? 'selected' : ''}>Password</option><option value="agent" ${server.authMode === 'agent' ? 'selected' : ''}>SSH Agent</option></select></div>
        <details id="key-options" class="form-details full">
          <summary>Private key options <span id="key-options-summary">${server.keyPath ? 'Custom key configured' : 'Detecting a key in ~/.ssh...'}</span></summary>
          <div class="form-details-body">
            <div id="key-fields" class="form-field full">
              <label for="server-key-path">Private key file</label>
              <div class="input-with-button"><input id="server-key-path" value="${escapeHtml(server.keyPath)}" placeholder="~/.ssh/id_ed25519"><button id="browse-key" class="button button-ghost" type="button">Browse</button></div>
              <span id="key-detection-status" class="form-help">Looking for a private key in ~/.ssh...</span>
            </div>
            <div id="passphrase-field" class="form-field full"><label for="server-passphrase">Key passphrase ${metadata.hasPassphrase ? '- saved' : '- optional'}</label><input id="server-passphrase" type="password" autocomplete="new-password" placeholder="${metadata.hasPassphrase ? 'Enter a new value to change it' : 'Required only for encrypted keys'}"></div>
            <div id="clear-passphrase-field" class="checkbox-field full ${metadata.hasPassphrase ? '' : 'is-hidden'}"><input id="clear-passphrase" type="checkbox"><label for="clear-passphrase">Remove the saved passphrase; the new private key has no passphrase</label></div>
          </div>
        </details>
        <div id="password-field" class="form-field full">
          <div class="credential-label-row">
            <label for="server-password">SSH password</label>
            <span class="credential-state ${metadata.hasPassword ? 'saved' : ''}">${metadata.hasPassword ? 'Saved securely' : 'Not saved'}</span>
          </div>
          <input id="server-password" type="password" autocomplete="new-password" placeholder="${metadata.hasPassword ? 'Leave blank to keep the saved password' : 'Enter password'}">
          <span class="credential-storage-note">${metadata.hasPassword ? 'A password is already saved. Leave this field blank to keep it. ' : ''}${escapeHtml(credentialStorageNote())}</span>
        </div>
        <div id="agent-notice" class="notice info">Uses a key already unlocked in Windows OpenSSH Agent or Pageant. PortPatch does not read a private key file or store a passphrase in this mode.</div>
        <div class="form-divider"></div>
        <div class="form-field full"><label for="server-fingerprint">Trusted host-key fingerprint - SHA-256</label><input id="server-fingerprint" value="${escapeHtml(server.hostFingerprint)}" readonly placeholder="Shown after a connection test"><span class="form-help">Verify it again if the server address or key changes.</span></div>
        <div id="test-result" class="is-hidden"></div>
      </form>
      ${existing ? `<div class="danger-zone"><span>Routes connected to this server will also be deleted.</span><button id="delete-server" class="button button-danger" type="button">Delete server</button></div>` : ''}
    </div>
    <div class="modal-footer">
      <button id="test-server" class="button button-ghost" type="button">Test connection</button>
      <span style="flex:1"></span>
      <button class="button button-ghost" data-close-modal type="button">Cancel</button>
      <button id="save-server" class="button button-primary" type="button">Save</button>
    </div>`;
}

function readServerForm(base) {
  const host = $('#server-host').value.trim();
  const port = Number($('#server-port').value);
  const changedEndpoint = base.host && (base.host !== host || Number(base.port) !== port);
  return {
    ...base,
    name: $('#server-name').value.trim(),
    host,
    port,
    username: $('#server-username').value.trim(),
    authMode: $('#server-auth').value,
    keyPath: $('#server-key-path').value.trim(),
    hostFingerprint: changedEndpoint ? '' : $('#server-fingerprint').value.trim(),
  };
}

function validateServerDraft(server, credentialDraft) {
  if (!server.name || !server.host || !server.username) return 'Enter a name, host, and username.';
  if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) return 'The SSH port must be between 1 and 65535.';
  if (server.authMode === 'key' && !server.keyPath) return 'Select a private key file.';
  if (server.authMode === 'password' && !credentialDraft.password && !state.secrets[server.id]?.hasPassword) return 'Enter the SSH password.';
  return null;
}

function serverCredentialContextChanged(previous, next) {
  if (!previous) return true;
  return ['host', 'port', 'username', 'authMode', 'keyPath', 'hostFingerprint']
    .some((field) => String(previous[field] ?? '') !== String(next[field] ?? ''));
}

function openServerModal(serverId = null) {
  const existing = state.config.servers.find((item) => item.id === serverId);
  const index = state.config.servers.length;
  const server = existing ? clone(existing) : {
    id: makeId('server'), name: '', host: '', port: 22, username: '', authMode: 'key', keyPath: '', hostFingerprint: '',
    position: { x: 410 + (index % 3) * 300, y: 150 + Math.floor(index / 3) * 210 },
  };
  const metadata = state.secrets[server.id] || { hasPassword: false, hasPassphrase: false };
  openModal(serverFormTemplate(server, Boolean(existing), metadata));

  const updateAuthFields = () => {
    const mode = $('#server-auth').value;
    $('#key-options').classList.toggle('is-hidden', mode !== 'key');
    $('#clear-passphrase-field').classList.toggle('is-hidden', mode !== 'key' || !metadata.hasPassphrase);
    $('#password-field').classList.toggle('is-hidden', mode !== 'password');
    $('#agent-notice').classList.toggle('is-hidden', mode !== 'agent');
  };
  updateAuthFields();
  $('#server-auth').addEventListener('change', updateAuthFields);
  $('#server-passphrase').addEventListener('input', () => {
    if ($('#server-passphrase').value) $('#clear-passphrase').checked = false;
  });
  $('#clear-passphrase').addEventListener('change', () => {
    if ($('#clear-passphrase').checked) $('#server-passphrase').value = '';
  });
  const clearFingerprintIfEndpointChanged = () => {
    const hostChanged = $('#server-host').value.trim() !== server.host;
    const portChanged = Number($('#server-port').value) !== Number(server.port);
    if (hostChanged || portChanged) $('#server-fingerprint').value = '';
  };
  $('#server-host').addEventListener('input', clearFingerprintIfEndpointChanged);
  $('#server-port').addEventListener('input', clearFingerprintIfEndpointChanged);
  $('#browse-key').addEventListener('click', async () => {
    const file = await api.selectKeyFile();
    if (file) {
      $('#server-key-path').value = file;
      $('#key-options-summary').textContent = 'Custom key selected';
    }
  });
  const loadDetectedKeys = async () => {
    const status = $('#key-detection-status');
    const summary = $('#key-options-summary');
    const keyPath = $('#server-key-path');
    try {
      const keys = await api.listPrivateKeys();
      if (!$('#server-form') || !status || !summary || !keyPath) return;
      if (!keys.length) {
        status.textContent = 'No private key was detected. Select a file manually.';
        summary.textContent = 'No key detected';
        if (!keyPath.value) $('#key-options').open = true;
        return;
      }
      const detected = keys.find((key) => key.path === keyPath.value) || keys[0];
      if (!keyPath.value) keyPath.value = detected.path;
      const usingDetectedKey = keyPath.value === detected.path;
      summary.textContent = usingDetectedKey ? `${detected.name} detected automatically` : 'Custom key configured';
      status.textContent = usingDetectedKey
        ? `Using ${detected.name} from ~/.ssh. Browse only if this server uses another key.`
        : 'Using the configured private key file.';
    } catch (error) {
      if (status) status.textContent = `Could not scan ~/.ssh: ${error.message}`;
    }
  };
  loadDetectedKeys();

  $('#test-server').addEventListener('click', async () => {
    const button = $('#test-server');
    const resultBox = $('#test-result');
    const draft = readServerForm(server);
    const credentialDraft = {
      password: $('#server-password').value,
      passphrase: $('#server-passphrase').value,
      clearPassphrase: $('#clear-passphrase').checked,
    };
    const validation = validateServerDraft(draft, credentialDraft);
    if (validation) {
      if (draft.authMode === 'key' && !draft.keyPath) $('#key-options').open = true;
      return toast(validation, 'error');
    }
    button.disabled = true;
    button.textContent = 'Connecting...';
    resultBox.className = 'test-result';
    resultBox.textContent = 'Retrieving the server host key...';
    try {
      if (!draft.hostFingerprint) {
        const probe = await api.probeServerKey(draft);
        if (!probe.ok || !probe.fingerprint) {
          resultBox.className = 'test-result error';
          resultBox.textContent = probe.message || 'The server did not provide a host key.';
          return;
        }
        const accepted = window.confirm(`The server presented this SHA-256 host-key fingerprint:\n\n${probe.fingerprint}\n\nNo password or private key has been sent. Continue only after verifying the fingerprint with the server administrator or another trusted source.`);
        if (!accepted) {
          resultBox.className = 'test-result error';
          resultBox.textContent = 'The host key was not trusted. Verify the server and test again.';
          return;
        }
        draft.hostFingerprint = probe.fingerprint;
        $('#server-fingerprint').value = probe.fingerprint;
      }
      resultBox.textContent = 'Testing SSH authentication with the verified host key...';
      const result = await api.testServer(draft, credentialDraft);
      if (!result.ok) {
        resultBox.className = 'test-result error';
        resultBox.textContent = result.message;
        return;
      }
      resultBox.className = 'test-result ok';
      resultBox.innerHTML = `${escapeHtml(result.message)}<code>${escapeHtml(result.fingerprint)}</code>`;
    } catch (error) {
      resultBox.className = 'test-result error';
      resultBox.textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = 'Test connection';
    }
  });

  $('#save-server').addEventListener('click', async () => {
    const draft = readServerForm(server);
    draft.hostFingerprint = $('#server-fingerprint').value.trim();
    const credentialDraft = {
      password: $('#server-password').value,
      passphrase: $('#server-passphrase').value,
      clearPassphrase: $('#clear-passphrase').checked,
    };
    const validation = validateServerDraft(draft, credentialDraft);
    if (validation) return toast(validation, 'error');
    const signatureChanged = Boolean(existing && serverCredentialContextChanged(existing, draft));
    if (draft.authMode === 'password' && signatureChanged && !credentialDraft.password) {
      return toast('The server address or authentication details changed. Enter the SSH password again.', 'error');
    }
    if (
      draft.authMode === 'key'
      && signatureChanged
      && metadata.hasPassphrase
      && !credentialDraft.passphrase
      && !credentialDraft.clearPassphrase
    ) {
      return toast('The server or private key changed. Enter the passphrase again or choose to remove the saved passphrase.', 'error');
    }
    if (!draft.hostFingerprint && !window.confirm('The host key has not been verified. You can save this server, but routes cannot start yet. Continue?')) return;
    if (existing) {
      const indexToReplace = state.config.servers.findIndex((item) => item.id === existing.id);
      state.config.servers[indexToReplace] = draft;
    } else {
      state.config.servers.push(draft);
    }
    const secretUpdates = {};
    if (draft.authMode === 'agent') {
      secretUpdates[draft.id] = { clearPassword: true, clearPassphrase: true };
    } else if (draft.authMode === 'password') {
      secretUpdates[draft.id] = { password: credentialDraft.password, clearPassphrase: true };
    } else {
      secretUpdates[draft.id] = {
        passphrase: credentialDraft.passphrase,
        clearPassword: true,
        clearPassphrase: credentialDraft.clearPassphrase,
      };
    }
    renderAll();
    closeModal();
    try {
      await persistConfig(secretUpdates);
      toast(existing ? 'Server settings saved.' : 'Server added.', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  $('#delete-server')?.addEventListener('click', () => deleteServer(server.id));
}

async function deleteServer(serverId) {
  const server = state.config.servers.find((item) => item.id === serverId);
  const related = state.config.routes.filter((route) => route.source.nodeId === serverId || route.target.nodeId === serverId);
  const suffix = related.length ? `\n${related.length} connected routes will also be deleted.` : '';
  if (!window.confirm(`Delete the server ${server.name}?${suffix}`)) return;
  state.config.servers = state.config.servers.filter((item) => item.id !== serverId);
  state.config.routes = state.config.routes.filter((route) => route.source.nodeId !== serverId && route.target.nodeId !== serverId);
  state.selectedNodeId = null;
  if (related.some((route) => route.id === state.selectedRouteId)) state.selectedRouteId = null;
  closeModal();
  renderAll();
  try {
    await persistConfig();
    toast('The server and its connected routes were deleted.', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function editNode(nodeId) {
  if (nodeId === 'local') openSettingsModal();
  else openServerModal(nodeId);
}

function routeEditorTemplate(route, isNew) {
  const exposed = routeRequiresExternalConsent(route.source.nodeId, route.source.bindHost);
  return `
    <form id="edge-route-form" class="edge-editor-card" data-route-id="${escapeHtml(route.id)}">
      <div class="edge-editor-context">
        <span>${escapeHtml(nodeName(route.source.nodeId))}</span>
        <i>&rarr;</i>
        <span>${escapeHtml(nodeName(route.target.nodeId))}</span>
        <button id="edge-editor-close" type="button" aria-label="${isNew ? 'Discard route' : 'Close editor'}">x</button>
      </div>
      <div class="edge-editor-main">
        <input id="edge-source-port" class="edge-port-input" type="number" min="1" max="65535" value="${route.source.port || ''}" placeholder="port" aria-label="Listen port" required>
        <span class="edge-editor-arrow">&rarr;</span>
        <input id="edge-target-port" class="edge-port-input" type="number" min="1" max="65535" value="${route.target.port || ''}" placeholder="port" aria-label="Target port">
        <span id="edge-socks-target" class="edge-socks-target is-hidden">SOCKS5</span>
        <select id="edge-protocol" aria-label="Route type">
          <option value="tcp" ${route.protocol === 'tcp' ? 'selected' : ''}>TCP</option>
          <option value="socks5" ${route.protocol === 'socks5' ? 'selected' : ''}>SOCKS5</option>
        </select>
        <button id="edge-route-save" class="edge-save-button" type="submit">${isNew ? 'Add' : 'Save'}</button>
      </div>
      <details id="edge-advanced" class="edge-editor-advanced" ${exposed ? 'open' : ''}>
        <summary>Advanced</summary>
        <div class="edge-advanced-grid">
          <label>Route name<input id="edge-route-name" value="${escapeHtml(route.name)}"></label>
          <label>Bind address<input id="edge-source-bind" value="${escapeHtml(route.source.bindHost)}"></label>
          <label id="edge-target-host-field">Target address<input id="edge-target-host" value="${escapeHtml(route.target.host)}"></label>
          <label class="edge-check"><input id="edge-route-reconnect" type="checkbox" ${route.reconnect ? 'checked' : ''}> Reconnect automatically</label>
          <div id="edge-exposure-warning" class="edge-exposure-warning ${exposed ? '' : 'is-hidden'}">
            A remote or non-loopback listener may be exposed by the SSH server's GatewayPorts policy.
            <label><input id="edge-route-allow-external" type="checkbox" ${route.allowExternal ? 'checked' : ''}> I understand and allow this listener</label>
          </div>
        </div>
      </details>
    </form>`;
}

function positionRouteEditor() {
  const editorState = state.routeEditor;
  const editor = $('#edge-route-form');
  if (!editorState || !editor) return;
  const route = state.config.routes.find((item) => item.id === editorState.routeId);
  if (!route) return;
  const geometry = routeGeometry(route);
  editor.style.left = `${geometry.label.x}px`;
  editor.style.top = `${geometry.label.y + 22}px`;
}

function closeRouteEditor(discardNew = true) {
  const editorState = state.routeEditor;
  state.routeEditor = null;
  $('#edge-editor-layer').innerHTML = '';
  if (discardNew && editorState?.isNew) {
    state.config.routes = state.config.routes.filter((route) => route.id !== editorState.routeId);
    if (state.selectedRouteId === editorState.routeId) state.selectedRouteId = null;
    delete state.statuses[editorState.routeId];
    renderAll();
  }
}

function refreshRouteEditorFields() {
  const editorState = state.routeEditor;
  if (!editorState) return;
  const route = state.config.routes.find((item) => item.id === editorState.routeId);
  if (!route) return;
  const socks = $('#edge-protocol').value === 'socks5';
  $('#edge-target-port').classList.toggle('is-hidden', socks);
  $('#edge-socks-target').classList.toggle('is-hidden', !socks);
  $('#edge-target-host-field').classList.toggle('is-hidden', socks);
  const exposed = routeRequiresExternalConsent(route.source.nodeId, $('#edge-source-bind').value.trim());
  $('#edge-exposure-warning').classList.toggle('is-hidden', !exposed);
  if (!exposed) $('#edge-route-allow-external').checked = false;
}

function renderRouteEditor() {
  const editorState = state.routeEditor;
  if (!editorState) return;
  const route = state.config.routes.find((item) => item.id === editorState.routeId);
  if (!route) return closeRouteEditor(false);
  $('#edge-editor-layer').innerHTML = routeEditorTemplate(route, editorState.isNew);
  positionRouteEditor();
  $('#edge-editor-close').addEventListener('click', () => closeRouteEditor(true));
  $('#edge-protocol').addEventListener('change', refreshRouteEditorFields);
  $('#edge-source-bind').addEventListener('input', refreshRouteEditorFields);
  $('#edge-route-form').addEventListener('pointerdown', (event) => event.stopPropagation());
  $('#edge-route-form').addEventListener('submit', saveRouteEditor);
  refreshRouteEditorFields();
  if (editorState.isNew) $('#edge-source-port').focus();
}

function createRouteEdge(sourceNodeId, targetNodeId) {
  closeRouteEditor(true);
  const route = {
    id: makeId('route'),
    name: `${nodeName(sourceNodeId)} to ${nodeName(targetNodeId)}`,
    protocol: 'tcp',
    source: { nodeId: sourceNodeId, bindHost: '127.0.0.1', port: '' },
    target: { nodeId: targetNodeId, host: '127.0.0.1', port: '' },
    reconnect: true,
    allowExternal: false,
  };
  state.config.routes.push(route);
  state.selectedRouteId = route.id;
  state.selectedNodeId = null;
  state.routeEditor = { routeId: route.id, isNew: true };
  renderAll();
  renderRouteEditor();
}

function openRouteEditor(routeId) {
  if (state.routeEditor?.routeId === routeId) return;
  closeRouteEditor(true);
  const route = state.config.routes.find((item) => item.id === routeId);
  if (!route) return;
  state.selectedRouteId = route.id;
  state.selectedNodeId = null;
  state.routeEditor = { routeId: route.id, isNew: false };
  renderAll();
  renderRouteEditor();
}

async function saveRouteEditor(event) {
  event.preventDefault();
  const editorState = state.routeEditor;
  if (!editorState) return;
  const route = state.config.routes.find((item) => item.id === editorState.routeId);
  if (!route) return;
  const protocol = $('#edge-protocol').value;
  const sourcePort = Number($('#edge-source-port').value);
  const targetPort = protocol === 'socks5' ? 0 : Number($('#edge-target-port').value);
  const bindHost = $('#edge-source-bind').value.trim();
  const targetHost = protocol === 'socks5' ? '127.0.0.1' : $('#edge-target-host').value.trim();
  const exposed = routeRequiresExternalConsent(route.source.nodeId, bindHost);
  const draft = {
    ...route,
    name: $('#edge-route-name').value.trim() || `${nodeName(route.source.nodeId)} :${sourcePort} to ${nodeName(route.target.nodeId)}${protocol === 'socks5' ? ' SOCKS5' : ` :${targetPort}`}`,
    protocol,
    source: { ...route.source, bindHost, port: sourcePort },
    target: { ...route.target, host: targetHost, port: targetPort },
    reconnect: $('#edge-route-reconnect').checked,
    allowExternal: exposed && $('#edge-route-allow-external').checked,
  };
  if (!bindHost) return toast('Enter a bind address.', 'error');
  if (!Number.isInteger(sourcePort) || sourcePort < 1 || sourcePort > 65535) return toast('The listen port must be between 1 and 65535.', 'error');
  if (protocol === 'tcp' && (!targetHost || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535)) return toast('Enter a target address and a target port between 1 and 65535.', 'error');
  const duplicate = state.config.routes.find((item) => item.id !== draft.id
    && item.source.nodeId === draft.source.nodeId
    && Number(item.source.port) === draft.source.port
    && (draft.source.nodeId !== 'local' || bindsOverlap(item.source.bindHost, draft.source.bindHost)));
  if (duplicate) return toast(`The route '${duplicate.name}' already uses this listener.`, 'error');
  if (
    protocol === 'tcp'
    && draft.source.nodeId === draft.target.nodeId
    && draft.source.port === draft.target.port
    && (
      draft.source.nodeId !== 'local'
      || isWildcardBind(draft.source.bindHost)
      || bindsOverlap(draft.source.bindHost, draft.target.host)
    )
  ) return toast('The source and destination overlap and would create an infinite loop.', 'error');
  if (exposed && !draft.allowExternal) return toast('Accept the exposure warning before saving this listener.', 'error');
  if (protocol === 'socks5' && draft.allowExternal) {
    const accepted = window.confirm('This SOCKS5 proxy has no built-in authentication. Other network users could abuse it if exposed. Continue?');
    if (!accepted) return;
  }

  const index = state.config.routes.findIndex((item) => item.id === draft.id);
  state.config.routes[index] = draft;
  state.routeEditor = null;
  $('#edge-editor-layer').innerHTML = '';
  renderAll();
  try {
    await persistConfig();
    toast(editorState.isNew ? 'Port route created.' : 'Route settings updated.', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function deleteRoute(routeId) {
  const route = state.config.routes.find((item) => item.id === routeId);
  if (!route || !window.confirm(`Delete the route '${route.name}'?`)) return;
  if (state.routeEditor?.routeId === routeId) closeRouteEditor(false);
  try { await api.stopRoute(routeId); } catch {}
  state.config.routes = state.config.routes.filter((item) => item.id !== routeId);
  state.selectedRouteId = null;
  renderAll();
  try {
    await persistConfig();
    toast('Route deleted.', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function settingsTemplate() {
  const settings = state.config.settings;
  const uiScale = Number(settings.uiScale || 100);
  const theme = settings.theme === 'light' ? 'light' : 'dark';
  return `
    <div class="modal-header"><div><h2 id="modal-title">Application settings</h2><p>Configure Windows startup, tray behavior, and the local node name.</p></div><button class="icon-button small" data-close-modal type="button">x</button></div>
    <div class="modal-body">
      <form class="form-grid">
        <div class="form-field full"><label for="local-name">Local computer node name</label><input id="local-name" value="${escapeHtml(state.config.localNode.name)}"></div>
        <div class="form-field full"><label for="ui-scale">Interface size</label><select id="ui-scale">
          <option value="80" ${uiScale === 80 ? 'selected' : ''}>80% - Small</option>
          <option value="90" ${uiScale === 90 ? 'selected' : ''}>90% - Compact</option>
          <option value="100" ${uiScale === 100 ? 'selected' : ''}>100% - Default</option>
          <option value="110" ${uiScale === 110 ? 'selected' : ''}>110% - Large</option>
          <option value="125" ${uiScale === 125 ? 'selected' : ''}>125% - Extra large</option>
        </select><span class="form-help">Applied to the entire PortPatch interface and saved for the next launch.</span></div>
        <div class="form-field full"><label for="ui-theme">Theme</label><select id="ui-theme">
          <option value="dark" ${theme === 'dark' ? 'selected' : ''}>Dark</option>
          <option value="light" ${theme === 'light' ? 'selected' : ''}>Light</option>
        </select><span class="form-help">Previewed immediately and saved for the next launch.</span></div>
        <div class="form-divider"></div>
        <div class="checkbox-field full"><input id="close-to-tray" type="checkbox" ${settings.closeToTray ? 'checked' : ''}><label for="close-to-tray">Hide in the system tray instead of quitting when the window closes</label></div>
        <div class="section-label">WINDOWS STARTUP</div>
        <div class="checkbox-field full"><input id="start-with-system" type="checkbox" ${settings.startWithSystem ? 'checked' : ''} ${state.platform === 'linux' ? 'disabled' : ''}><label for="start-with-system">Launch PortPatch when I sign in to Windows</label></div>
        ${state.platform === 'linux' ? '<div class="notice">Linux autostart integration is planned for a later release.</div>' : ''}
        <div class="checkbox-field full"><input id="launch-hidden" type="checkbox" ${settings.launchHidden ? 'checked' : ''} ${settings.startWithSystem ? '' : 'disabled'}><label for="launch-hidden">Open in the tray when launched at sign-in</label></div>
        <span class="form-help full">Port routes remain stopped until you select Start route or Start all.</span>
        ${state.encryption?.warning ? `<div class="notice">${escapeHtml(state.encryption.warning)}</div>` : ''}
      </form>
    </div>
    <div class="modal-footer"><button class="button button-ghost" data-close-modal type="button">Cancel</button><button id="save-settings" class="button button-primary" type="button">Save</button></div>`;
}

function openSettingsModal() {
  const originalScale = Number(state.config.settings.uiScale || 100);
  const originalTheme = state.config.settings.theme === 'light' ? 'light' : 'dark';
  openModal(settingsTemplate(), false, () => {
    api.setUiScale(originalScale);
    applyTheme(originalTheme);
  });
  const updateWindowsStartupFields = () => {
    const enabled = $('#start-with-system').checked && state.platform !== 'linux';
    $('#launch-hidden').disabled = !enabled;
    if (!enabled) $('#launch-hidden').checked = false;
  };
  $('#start-with-system').addEventListener('change', updateWindowsStartupFields);
  $('#ui-scale').addEventListener('change', () => {
    api.setUiScale(Number($('#ui-scale').value));
  });
  $('#ui-theme').addEventListener('change', () => applyTheme($('#ui-theme').value));
  updateWindowsStartupFields();
  $('#save-settings').addEventListener('click', async () => {
    const name = $('#local-name').value.trim();
    if (!name) return toast('Enter a name for the local computer node.', 'error');
    state.config.localNode.name = name;
    state.config.settings = {
      closeToTray: $('#close-to-tray').checked,
      startWithSystem: $('#start-with-system').checked,
      launchHidden: $('#launch-hidden').checked,
      uiScale: Number($('#ui-scale').value),
      uiScaleVersion: 2,
      theme: $('#ui-theme').value,
    };
    closeModal({ skipCleanup: true });
    renderAll();
    try {
      await persistConfig();
      toast('Settings saved.', 'success');
    } catch (error) {
      api.setUiScale(state.config.settings.uiScale || originalScale);
      applyTheme(state.config.settings.theme || originalTheme);
      toast(error.message, 'error');
    }
  });
}

function helpTemplate() {
  return `
    <div class="modal-header">
      <div><h2 id="modal-title">Using the routing map</h2><p>The map works like a compact diagram editor.</p></div>
      <button class="icon-button small" data-close-modal type="button" aria-label="Close">x</button>
    </div>
    <div class="modal-body">
      <div class="help-grid">
        <div class="help-item"><kbd>Drag a node</kbd><div><strong>Move a node</strong><span>Arrange servers anywhere on the routing map.</span></div></div>
        <div class="help-item"><kbd>Ctrl + drag</kbd><div><strong>Create a route</strong><span>Drag from the listening node to the destination node.</span></div></div>
        <div class="help-item"><kbd>Drag empty space</kbd><div><strong>Pan the map</strong><span>Move the viewport without changing node positions.</span></div></div>
        <div class="help-item"><kbd>Mouse wheel</kbd><div><strong>Zoom</strong><span>Zoom around the current pointer position.</span></div></div>
        <div class="help-item"><kbd>Click an edge</kbd><div><strong>Edit a route</strong><span>Change ports and advanced forwarding settings inline.</span></div></div>
        <div class="help-item"><kbd>Close window</kbd><div><strong>Keep routes active</strong><span>PortPatch continues running from the system tray.</span></div></div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="button button-primary" data-close-modal type="button">Got it</button>
    </div>`;
}

function openHelpModal() {
  openModal(helpTemplate());
}

function renderLogs() {
  const entries = state.logs.filter((_entry, index) => index >= state.logViewClearedAt);
  $('#log-count').textContent = state.logs.length;
  $('#log-list').innerHTML = entries.length ? entries.map((entry) => {
    const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
    const details = entry.details && Object.keys(entry.details).length ? `<span class="log-details">${escapeHtml(JSON.stringify(entry.details))}</span>` : '';
    return `<div class="log-entry ${escapeHtml(entry.level)}"><span class="log-time">${escapeHtml(time)}</span><span class="log-level">${escapeHtml(entry.level)}</span><span class="log-message">${escapeHtml(entry.message)}${details}</span></div>`;
  }).join('') : '<div class="side-empty">No logs to display.</div>';
}

function renderRuntime() {
  renderSidebar();
  renderEdges();
  updateGraphNodesRuntime();
  renderInspector();
}

function renderAll() {
  renderSecurityBadge();
  renderSidebar();
  renderGraph();
  renderInspector();
  renderLogs();
}

function bindStaticEvents() {
  $('#add-server-button').addEventListener('click', () => openServerModal());
  $('#sidebar-add-server').addEventListener('click', () => openServerModal());
  $('#empty-add-server').addEventListener('click', () => openServerModal());
  $('#settings-button').addEventListener('click', openSettingsModal);
  $('#help-button').addEventListener('click', openHelpModal);
  $('#start-all-button').addEventListener('click', async () => {
    try { await api.startAll(); } catch (error) { toast(error.message, 'error'); }
  });
  $('#stop-all-button').addEventListener('click', async () => {
    try { await api.stopAll(); } catch (error) { toast(error.message, 'error'); }
  });
  $('#logs-button').addEventListener('click', () => {
    const drawer = $('#log-drawer');
    drawer.classList.toggle('open');
    drawer.setAttribute('aria-hidden', drawer.classList.contains('open') ? 'false' : 'true');
  });
  $('#close-logs').addEventListener('click', () => $('#log-drawer').classList.remove('open'));
  $('#clear-log-view').addEventListener('click', () => {
    state.logViewClearedAt = state.logs.length;
    renderLogs();
  });
  $('#canvas-viewport').addEventListener('wheel', handleCanvasWheel, { passive: false });
  $('#canvas-viewport').addEventListener('pointerdown', beginCanvasPan);
  $('#zoom-out').addEventListener('click', () => zoomCanvasBy(0.85));
  $('#zoom-reset').addEventListener('click', () => applyZoom(1));
  $('#zoom-in').addEventListener('click', () => zoomCanvasBy(1 / 0.85));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Control') $('#graph-canvas').classList.add('connecting-mode');
  });
  document.addEventListener('keyup', (event) => {
    if (event.key === 'Control') $('#graph-canvas').classList.remove('connecting-mode');
  });
  window.addEventListener('blur', () => $('#graph-canvas').classList.remove('connecting-mode'));
  $('#modal-backdrop').addEventListener('pointerdown', (event) => {
    if (event.target === $('#modal-backdrop')) closeModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('#modal-backdrop').classList.contains('is-hidden')) closeModal();
    else if (state.routeEditor) closeRouteEditor(true);
  });
}

async function initialize() {
  bindStaticEvents();
  let hydrated = false;
  const pendingStatuses = [];
  const pendingLogs = [];
  api.onRouteStatus((status) => {
    if (!hydrated) {
      pendingStatuses.push(status);
      return;
    }
    state.statuses[status.routeId] = status;
    renderRuntime();
  });
  api.onLog((entry) => {
    if (!hydrated) {
      pendingLogs.push(entry);
      return;
    }
    state.logs.push(entry);
    if (state.logs.length > 500) {
      state.logs.shift();
      state.logViewClearedAt = Math.max(0, state.logViewClearedAt - 1);
    }
    renderLogs();
  });
  try {
    const initial = await api.getState();
    Object.assign(state, initial);
    api.setUiScale(initial.config.settings.uiScale || 100);
    applyTheme(initial.config.settings.theme);
    document.documentElement.classList.add(`platform-${state.platform}`);
    state.logs = initial.logs || [];
    for (const status of pendingStatuses) state.statuses[status.routeId] = status;
    const knownLogIds = new Set(state.logs.map((entry) => entry.id));
    for (const entry of pendingLogs) {
      if (!knownLogIds.has(entry.id)) state.logs.push(entry);
    }
    if (state.logs.length > 500) state.logs = state.logs.slice(-500);
    hydrated = true;
    renderAll();
    $('#app').classList.add('ready');
  } catch (error) {
    $('.loading-screen span').textContent = `Could not start: ${error.message}`;
    toast(error.message, 'error');
  }
}

initialize();
