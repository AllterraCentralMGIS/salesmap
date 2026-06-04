/* SalesMap — web app (single-file, vanilla JS, Supabase backend) */
/* global tt, supabase, XLSX, toGeoJSON, turf */
'use strict';

const CFG = window.SALESMAP_CONFIG;
const sb = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

const state = {
  user: null,
  profile: null,
  profilesById: {},
  customers: [],
  zones: [],
  selectedId: null,
  markers: new Map(),
  zoneLayers: [],
  map: null,
  filters: { q: '', zoneId: '', salesperson: '', recency: '', visitor: '' },
  tomtomKey: null,
};

// ============== BOOTSTRAP ==============
window.addEventListener('error', (e) => {
  console.error('Renderer error:', e.error || e.message);
  showToast(`Error: ${e.message}`, 5000);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('Unhandled rejection:', e.reason);
  const msg = e.reason && e.reason.message ? e.reason.message : String(e.reason);
  showToast(`Error: ${msg}`, 5000);
});

document.addEventListener('DOMContentLoaded', async () => {
  bindAuthUI();
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    await onSignedIn(session.user);
  } else {
    showAuthScreen();
  }
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') location.reload();
  });
});

// ============== AUTH ==============
function showAuthScreen() {
  document.getElementById('authScreen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}
function hideAuthScreen() {
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}

function bindAuthUI() {
  document.getElementById('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const msg = document.getElementById('authMsg');
    msg.textContent = 'Signing in…';
    msg.className = 'auth-msg';
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      msg.textContent = error.message;
      msg.className = 'auth-msg error';
      return;
    }
    msg.textContent = '';
    await onSignedIn(data.user);
  });

  document.getElementById('authForgot').addEventListener('click', async (e) => {
    e.preventDefault();
    const email = document.getElementById('authEmail').value.trim();
    const msg = document.getElementById('authMsg');
    if (!email) {
      msg.textContent = 'Enter your email above first.';
      msg.className = 'auth-msg error';
      return;
    }
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + location.pathname,
    });
    msg.textContent = error ? error.message : 'Check your email for a reset link.';
    msg.className = error ? 'auth-msg error' : 'auth-msg success';
  });
}

async function onSignedIn(user) {
  state.user = user;
  // Load own profile (it's auto-created by DB trigger)
  const { data: prof } = await sb.from('profiles').select('*').eq('id', user.id).single();
  state.profile = prof;
  hideAuthScreen();
  bindAppUI();
  state.tomtomKey = localStorage.getItem('tomtom_api_key') || CFG.DEFAULT_TOMTOM_KEY || '';
  if (!state.tomtomKey) {
    openSettings(true);
  }
  await refreshAll();
  if (state.tomtomKey) await initMap().catch((err) => {
    showMapPlaceholder(`Map failed to load: ${err.message}. Check your API key in Settings.`);
  });
  else showMapPlaceholder('Add your TomTom API key in Settings to load the map.');

  // Realtime — refresh on any change
  sb.channel('public-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'customers' }, () => refreshAll())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'visits' }, () => refreshAll())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'zones' }, () => refreshAll())
    .subscribe();
}

// ============== UI BINDINGS ==============
function bindAppUI() {
  document.getElementById('search').addEventListener('input', (e) => {
    state.filters.q = e.target.value.toLowerCase();
    renderList(); renderMarkers();
  });
  document.getElementById('filterZone').addEventListener('change', (e) => {
    state.filters.zoneId = e.target.value; renderList(); renderMarkers();
  });
  document.getElementById('filterSalesperson').addEventListener('change', (e) => {
    state.filters.salesperson = e.target.value; renderList(); renderMarkers();
  });
  document.getElementById('filterRecency').addEventListener('change', (e) => {
    state.filters.recency = e.target.value; renderList(); renderMarkers();
  });
  document.getElementById('filterVisitor').addEventListener('change', (e) => {
    state.filters.visitor = e.target.value; renderList(); renderMarkers();
  });
  document.getElementById('btnNewCustomer').addEventListener('click', () => openCustomerForm(null));
  document.getElementById('btnSettings').addEventListener('click', () => openSettings(false));
  document.getElementById('btnSignOut').addEventListener('click', async () => { await sb.auth.signOut(); });
  document.getElementById('detailClose').addEventListener('click', closeDetail);
  document.getElementById('phoneListBtn').addEventListener('click', () => {
    document.getElementById('app').classList.toggle('sidebar-open');
  });
}

// ============== MAP ==============
async function initMap() {
  if (typeof tt === 'undefined') throw new Error('TomTom SDK did not load');
  state.map = tt.map({
    key: state.tomtomKey,
    container: 'map',
    center: CFG.MAP_CENTER,
    zoom: CFG.MAP_ZOOM,
  });
  state.map.addControl(new tt.NavigationControl());
  state.map.on('load', () => {
    renderZonePolygons();
    renderMarkers();
    fitMapToCustomers();
  });
  state.map.on('error', (e) => {
    console.error('Map error:', e && e.error);
    if (e && e.error && e.error.status === 403) {
      showToast('TomTom rejected the API key (403). Check it in Settings.', 6000);
    }
  });
}
function showMapPlaceholder(msg) {
  document.getElementById('map').innerHTML =
    `<div class="empty-state" style="padding-top:80px;">${escapeHtml(msg)}</div>`;
}

function recencyBucket(lastVisitDate) {
  if (!lastVisitDate) return 'never';
  const days = (Date.now() - new Date(lastVisitDate).getTime()) / 86400000;
  if (days >= 90) return 'stale';
  if (days >= 30) return 'mid';
  return 'fresh';
}

function renderZonePolygons() {
  if (!state.map) return;
  for (const id of state.zoneLayers) {
    if (state.map.getLayer(id)) state.map.removeLayer(id);
    if (state.map.getLayer(id + '-outline')) state.map.removeLayer(id + '-outline');
    if (state.map.getSource(id)) state.map.removeSource(id);
  }
  state.zoneLayers = [];
  for (const z of state.zones) {
    const sourceId = `zone-${z.id}`;
    state.map.addSource(sourceId, { type: 'geojson', data: z.geojson });
    state.map.addLayer({
      id: sourceId, type: 'fill', source: sourceId,
      paint: { 'fill-color': z.color || '#888', 'fill-opacity': 0.12 },
    });
    state.map.addLayer({
      id: sourceId + '-outline', type: 'line', source: sourceId,
      paint: { 'line-color': z.color || '#888', 'line-width': 1.5, 'line-opacity': 0.7 },
    });
    state.zoneLayers.push(sourceId);
  }
}

function renderMarkers() {
  if (!state.map) return;
  for (const m of state.markers.values()) m.remove();
  state.markers.clear();
  const filtered = applyFilters(state.customers);
  for (const c of filtered) {
    if (c.lat == null || c.lng == null) continue;
    const el = document.createElement('div');
    el.className = `sm-pin ${recencyBucket(c.last_visit_date)}`;
    if (c.id === state.selectedId) el.classList.add('selected');
    el.addEventListener('click', (e) => { e.stopPropagation(); selectCustomer(c.id, false); });
    const marker = new tt.Marker({ element: el }).setLngLat([c.lng, c.lat]).addTo(state.map);
    state.markers.set(c.id, marker);
  }
}

function fitMapToCustomers() {
  if (!state.map) return;
  const pts = state.customers.filter((c) => c.lat != null && c.lng != null);
  if (pts.length === 0) return;
  const bounds = new tt.LngLatBounds();
  for (const c of pts) bounds.extend([c.lng, c.lat]);
  state.map.fitBounds(bounds, { padding: 80, maxZoom: 11 });
}

// ============== DATA LAYER (Supabase) ==============
async function refreshAll() {
  const [{ data: customers }, { data: zones }, { data: profiles }, { data: visitsAgg }] = await Promise.all([
    sb.from('customers').select('*').order('company', { ascending: true }),
    sb.from('zones').select('*').order('name', { ascending: true }),
    sb.from('profiles').select('id, display_name, salesperson_code'),
    sb.from('visits').select('customer_id, visit_date'),
  ]);
  // Compute per-customer last_visit_date and visit_count
  const lastByCust = new Map();
  const countByCust = new Map();
  for (const v of (visitsAgg || [])) {
    countByCust.set(v.customer_id, (countByCust.get(v.customer_id) || 0) + 1);
    const cur = lastByCust.get(v.customer_id);
    if (!cur || v.visit_date > cur) lastByCust.set(v.customer_id, v.visit_date);
  }
  state.zones = (zones || []).map((z) => ({ ...z, geojson: z.geojson }));
  const zoneById = new Map(state.zones.map((z) => [z.id, z]));
  state.customers = (customers || []).map((c) => ({
    ...c,
    zone_name: c.zone_id != null ? (zoneById.get(c.zone_id) || {}).name : null,
    zone_color: c.zone_id != null ? (zoneById.get(c.zone_id) || {}).color : null,
    last_visit_date: lastByCust.get(c.id) || null,
    visit_count: countByCust.get(c.id) || 0,
  }));
  state.profilesById = Object.fromEntries((profiles || []).map((p) => [p.id, p]));
  populateZoneFilter();
  populateSalespersonFilter();
  populateVisitorFilter();
  renderList();
  if (state.map) { renderZonePolygons(); renderMarkers(); }
}

function findZoneForPoint(lat, lng) {
  const pt = turf.point([lng, lat]);
  for (const z of state.zones) {
    try {
      const f = z.geojson;
      if (f.type === 'FeatureCollection') {
        for (const ff of f.features) {
          if (ff.geometry && turf.booleanPointInPolygon(pt, ff)) return z.id;
        }
      } else if (f.type === 'Feature') {
        if (turf.booleanPointInPolygon(pt, f)) return z.id;
      } else if (f.type === 'Polygon' || f.type === 'MultiPolygon') {
        if (turf.booleanPointInPolygon(pt, turf.feature(f))) return z.id;
      }
    } catch (e) {}
  }
  return null;
}

// ============== FILTERS ==============
function populateZoneFilter() {
  const sel = document.getElementById('filterZone');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All zones</option>';
  for (const z of state.zones) {
    const opt = document.createElement('option');
    opt.value = String(z.id); opt.textContent = z.name;
    sel.appendChild(opt);
  }
  sel.value = cur || state.filters.zoneId;
}
function populateSalespersonFilter() {
  const sel = document.getElementById('filterSalesperson');
  const cur = sel.value;
  const codes = [...new Set(state.customers.map((c) => c.salesperson_code).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">All salespeople</option>';
  for (const code of codes) {
    const opt = document.createElement('option');
    opt.value = code; opt.textContent = code;
    sel.appendChild(opt);
  }
  sel.value = cur || state.filters.salesperson;
}
function populateVisitorFilter() {
  const sel = document.getElementById('filterVisitor');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All visitors</option>';
  for (const p of Object.values(state.profilesById)) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.display_name + (p.salesperson_code ? ` (${p.salesperson_code})` : '');
    sel.appendChild(opt);
  }
  sel.value = cur || state.filters.visitor;
}

function applyFilters(items) {
  const { q, zoneId, salesperson, recency, visitor } = state.filters;
  return items.filter((c) => {
    if (q) {
      const hay = `${c.company || ''} ${c.contact_name || ''} ${c.city || ''} ${c.address || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (zoneId && String(c.zone_id) !== zoneId) return false;
    if (salesperson && c.salesperson_code !== salesperson) return false;
    if (recency) {
      const days = c.last_visit_date ? (Date.now() - new Date(c.last_visit_date).getTime()) / 86400000 : null;
      if (recency === 'never' && c.last_visit_date) return false;
      if (recency === '90' && (days == null || days < 90)) return false;
      if (recency === '60' && (days == null || days < 60)) return false;
      if (recency === '30' && (days == null || days < 30)) return false;
      if (recency === 'recent' && (days == null || days >= 30)) return false;
    }
    // visitor filter would require fetching all visits; approximate by hiding customers without any visit by that visitor.
    // To keep this simple and fast, ignore unless visitor is set; in that case we'll do a per-customer client check.
    if (visitor) {
      const v = c._visitorIds; // lazily populated below
      if (!v || !v.has(visitor)) return false;
    }
    return true;
  });
}

// ============== LIST ==============
function filtersActive() {
  const f = state.filters;
  return !!(f.q || f.zoneId || f.salesperson || f.recency || f.visitor);
}

async function deleteFiltered() {
  const filtered = applyFilters(state.customers);
  if (filtered.length === 0) return;
  if (!confirm(`Delete ${filtered.length} customer${filtered.length === 1 ? '' : 's'} matching the current filters?\n\nThis also deletes their visit history. Cannot be undone.`)) return;
  const ids = filtered.map((c) => c.id);
  const { error } = await sb.from('customers').delete().in('id', ids);
  if (error) { showToast(`Delete failed: ${error.message}`, 5000); return; }
  if (state.selectedId && ids.includes(state.selectedId)) closeDetail();
  showToast(`Deleted ${ids.length} customers.`, 3000);
  await refreshAll();
}

function renderList() {
  const ul = document.getElementById('customerList');
  ul.innerHTML = '';
  const filtered = applyFilters(state.customers);
  const countsEl = document.getElementById('counts');
  const showBulk = filtersActive() && filtered.length > 0 && filtered.length < state.customers.length;
  countsEl.innerHTML = `
    <span>${filtered.length} of ${state.customers.length} customers</span>
    ${showBulk ? `<button class="counts-delete" id="btnDeleteFiltered">Delete ${filtered.length}</button>` : ''}
  `;
  const btn = document.getElementById('btnDeleteFiltered');
  if (btn) btn.addEventListener('click', deleteFiltered);

  if (filtered.length === 0) {
    const li = document.createElement('li');
    li.innerHTML = '<div class="empty-state">No customers match.</div>';
    ul.appendChild(li);
    return;
  }
  for (const c of filtered) {
    const li = document.createElement('li');
    if (c.id === state.selectedId) li.classList.add('active');
    li.innerHTML = `
      <div class="pin sm-pin ${recencyBucket(c.last_visit_date)}"></div>
      <div class="info">
        <div class="name">${escapeHtml(c.company || '(no name)')}</div>
        <div class="sub">${escapeHtml(c.contact_name || '')} · ${escapeHtml(c.city || '')}</div>
        <div class="meta">${c.zone_name ? escapeHtml(c.zone_name) : 'No zone'} · ${c.last_visit_date ? `Last visit ${c.last_visit_date}` : 'Never visited'}</div>
      </div>`;
    li.addEventListener('click', () => {
      selectCustomer(c.id, true);
      // On phone, close the sidebar overlay when picking
      document.getElementById('app').classList.remove('sidebar-open');
    });
    ul.appendChild(li);
  }
}

// ============== SELECT / DETAIL ==============
async function selectCustomer(id, panTo) {
  state.selectedId = id;
  renderList(); renderMarkers();
  const c = state.customers.find((x) => x.id === id);
  if (!c) return;
  if (panTo && state.map && c.lat != null && c.lng != null) {
    state.map.flyTo({ center: [c.lng, c.lat], zoom: Math.max(state.map.getZoom(), 11) });
  }
  await renderDetail(c);
  document.getElementById('app').classList.add('with-detail');
  document.getElementById('detail').classList.remove('hidden');
}

function closeDetail() {
  state.selectedId = null;
  document.getElementById('app').classList.remove('with-detail');
  document.getElementById('detail').classList.add('hidden');
  renderList(); renderMarkers();
}

async function renderDetail(c) {
  const { data: visits } = await sb
    .from('visits').select('*')
    .eq('customer_id', c.id)
    .order('visit_date', { ascending: false });
  const body = document.getElementById('detailBody');
  body.innerHTML = `
    <h2 class="detail-title">${escapeHtml(c.company || '(no name)')}</h2>
    <div class="detail-sub">${escapeHtml(c.contact_name || '')}</div>
    ${c.zone_name ? `<div class="detail-zone-pill" style="background:${c.zone_color || '#e5e7eb'}33; color:${c.zone_color || '#374151'}">${escapeHtml(c.zone_name)}</div>` : ''}

    <div class="detail-section">
      <h3>Contact</h3>
      <div class="field-grid">
        <div class="label">Job title</div><div>${escapeHtml(c.job_title || '')}</div>
        <div class="label">Address</div><div>${escapeHtml(c.address || '')}<br/>${escapeHtml([c.city, c.state, c.post_code].filter(Boolean).join(', '))}</div>
        <div class="label">Phone</div><div>${c.phone ? `<a href="tel:${escapeHtml(c.phone)}">${escapeHtml(c.phone)}</a>` : ''}</div>
        <div class="label">Mobile</div><div>${c.mobile ? `<a href="tel:${escapeHtml(c.mobile)}">${escapeHtml(c.mobile)}</a>` : ''}</div>
        <div class="label">Email</div><div>${c.email ? `<a href="mailto:${escapeHtml(c.email)}">${escapeHtml(c.email)}</a>` : ''}</div>
        <div class="label">Salesperson</div><div>${escapeHtml(c.salesperson_code || '')}</div>
        <div class="label">Territory</div><div>${escapeHtml(c.territory_code || '')}</div>
        <div class="label">Customer #</div><div>${escapeHtml(c.customer_no || '')}</div>
        <div class="label">Geocode</div><div>${escapeHtml(c.geocode_quality || '')}</div>
      </div>
      <div class="detail-actions">
        <button class="btn btn-primary" id="btnLogVisit">+ Log visit</button>
        <button class="btn" id="btnEditCustomer">Edit</button>
        <button class="btn btn-danger" id="btnDeleteCustomer">Delete</button>
      </div>
    </div>

    <div class="detail-section">
      <h3>Visit history (${(visits || []).length})</h3>
      <div id="visitList">
        ${(visits || []).length === 0 ? '<div class="empty-state" style="padding:8px 0;">No visits yet.</div>' : ''}
        ${(visits || []).map(renderVisit).join('')}
      </div>
    </div>
  `;
  document.getElementById('btnLogVisit').addEventListener('click', () => openVisitForm(c.id));
  document.getElementById('btnEditCustomer').addEventListener('click', () => openCustomerForm(c));
  document.getElementById('btnDeleteCustomer').addEventListener('click', () => deleteCustomer(c));
  for (const v of (visits || [])) {
    const btn = document.getElementById(`del-visit-${v.id}`);
    if (btn) btn.addEventListener('click', () => deleteVisit(c.id, v.id));
  }
}

function renderVisit(v) {
  const by = state.profilesById[v.visitor_id];
  const byLabel = by ? by.display_name : '(unknown)';
  return `
    <div class="visit">
      <button class="visit-delete" id="del-visit-${v.id}" title="Delete visit">remove</button>
      <div class="visit-head">
        <div class="visit-date">${escapeHtml(v.visit_date)}</div>
        ${v.outcome ? `<div class="visit-outcome">${escapeHtml(v.outcome)}</div>` : ''}
      </div>
      <div class="visit-by">by ${escapeHtml(byLabel)}</div>
      ${v.notes ? `<div class="visit-notes">${escapeHtml(v.notes)}</div>` : ''}
    </div>`;
}

async function deleteCustomer(c) {
  if (!confirm(`Delete ${c.company}? This also deletes all visit history.`)) return;
  const { error } = await sb.from('customers').delete().eq('id', c.id);
  if (error) { showToast(`Delete failed: ${error.message}`, 5000); return; }
  closeDetail(); await refreshAll();
  showToast('Customer deleted', 2000);
}

async function deleteVisit(customerId, visitId) {
  const { error } = await sb.from('visits').delete().eq('id', visitId);
  if (error) { showToast(`Delete failed: ${error.message}`, 5000); return; }
  await refreshAll();
  const c = state.customers.find((x) => x.id === customerId);
  if (c) await renderDetail(c);
}

// ============== VISIT FORM ==============
function openVisitForm(customerId) {
  const today = new Date().toISOString().slice(0, 10);
  openModal('Log visit', `
    <div class="form-row"><label>Date</label><input type="date" id="vDate" value="${today}" /></div>
    <div class="form-row">
      <label>Outcome</label>
      <select id="vOutcome">
        <option value="">(none)</option>
        <option>Met with decision-maker</option>
        <option>Met with gatekeeper</option>
        <option>Decision-maker not in</option>
        <option>Dropped off card / literature</option>
        <option>Scheduled follow-up appointment</option>
        <option>Quote requested</option>
        <option>Demo scheduled</option>
        <option>Closed sale</option>
        <option>Not interested</option>
        <option>Business closed / moved</option>
      </select>
    </div>
    <div class="form-row"><label>Notes</label><textarea id="vNotes" placeholder="What was discussed?"></textarea></div>
  `, async () => {
    const { error } = await sb.from('visits').insert({
      customer_id: customerId,
      visitor_id: state.user.id,
      visit_date: document.getElementById('vDate').value,
      outcome: document.getElementById('vOutcome').value || null,
      notes: document.getElementById('vNotes').value || null,
    });
    if (error) { showToast(`Save failed: ${error.message}`, 5000); return; }
    closeModal();
    await refreshAll();
    const c = state.customers.find((x) => x.id === customerId);
    if (c) await renderDetail(c);
    showToast('Visit logged', 1500);
  });
}

// ============== CUSTOMER FORM ==============
function openCustomerForm(existing) {
  const c = existing || {};
  openModal(existing ? 'Edit customer' : 'New customer', `
    <div class="form-row"><label>Company</label><input id="fCompany" value="${escapeAttr(c.company)}" /></div>
    <div class="form-grid">
      <div class="form-row"><label>Contact name</label><input id="fContact" value="${escapeAttr(c.contact_name)}" /></div>
      <div class="form-row"><label>Job title</label><input id="fJobTitle" value="${escapeAttr(c.job_title)}" /></div>
    </div>
    <div class="form-row"><label>Address</label><input id="fAddress" value="${escapeAttr(c.address)}" /></div>
    <div class="form-grid">
      <div class="form-row"><label>City</label><input id="fCity" value="${escapeAttr(c.city)}" /></div>
      <div class="form-row"><label>State</label><input id="fState" value="${escapeAttr(c.state)}" /></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label>Post code</label><input id="fPost" value="${escapeAttr(c.post_code)}" /></div>
      <div class="form-row"><label>Phone</label><input id="fPhone" value="${escapeAttr(c.phone)}" /></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label>Mobile</label><input id="fMobile" value="${escapeAttr(c.mobile)}" /></div>
      <div class="form-row"><label>Email</label><input id="fEmail" value="${escapeAttr(c.email)}" /></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label>Salesperson code</label><input id="fSalesperson" value="${escapeAttr(c.salesperson_code)}" /></div>
      <div class="form-row"><label>Territory code</label><input id="fTerritory" value="${escapeAttr(c.territory_code)}" /></div>
    </div>
    <div class="form-row" style="font-size:12px;color:#6b7280;">
      Address will be geocoded and a zone assigned automatically when you save.
    </div>
  `, async () => {
    const data = {
      company: getVal('fCompany'),
      contact_name: getVal('fContact'),
      job_title: getVal('fJobTitle'),
      address: getVal('fAddress'),
      city: getVal('fCity'),
      state: getVal('fState'),
      post_code: getVal('fPost'),
      phone: getVal('fPhone'),
      mobile: getVal('fMobile'),
      email: getVal('fEmail'),
      salesperson_code: getVal('fSalesperson'),
      territory_code: getVal('fTerritory'),
    };
    const addressChanged = !existing
      || data.address !== existing.address
      || data.city !== existing.city
      || data.state !== existing.state
      || data.post_code !== existing.post_code;

    if (addressChanged && data.address) {
      try {
        showToast('Geocoding address…', 0);
        const full = [data.address, data.city, data.state, data.post_code].filter(Boolean).join(', ');
        const geo = await geocodeAddress(full);
        if (geo) {
          data.lat = geo.lat;
          data.lng = geo.lng;
          data.geocode_quality = geo.quality;
          data.zone_id = findZoneForPoint(geo.lat, geo.lng);
        } else {
          data.geocode_quality = 'FAILED';
        }
      } catch (err) {
        showToast(`Geocode failed: ${err.message}`, 3000);
      }
    }
    let result;
    if (existing) {
      result = await sb.from('customers').update(data).eq('id', existing.id).select().single();
    } else {
      data.created_by = state.user.id;
      result = await sb.from('customers').insert(data).select().single();
    }
    if (result.error) { showToast(`Save failed: ${result.error.message}`, 5000); return; }
    closeModal();
    state.selectedId = result.data.id;
    await refreshAll();
    const fresh = state.customers.find((x) => x.id === state.selectedId);
    if (fresh) await renderDetail(fresh);
    showToast('Saved', 1500);
  });
}

// ============== GEOCODE ==============
async function geocodeAddress(address) {
  if (!state.tomtomKey) throw new Error('TomTom API key not set');
  if (!address || !address.trim()) return null;
  const url = new URL(`https://api.tomtom.com/search/2/geocode/${encodeURIComponent(address)}.json`);
  url.searchParams.set('key', state.tomtomKey);
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrySet', 'US');
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`TomTom ${res.status}`);
  const json = await res.json();
  const hit = json.results && json.results[0];
  if (!hit) return null;
  return {
    lat: hit.position.lat,
    lng: hit.position.lon,
    quality: hit.matchConfidence?.score >= 0.9 ? 'FULL' : 'PARTIAL',
  };
}

// ============== SETTINGS ==============
function openSettings(firstRun) {
  openModal(firstRun ? 'Welcome to SalesMap' : 'Settings', `
    ${firstRun ? '<p style="margin-top:0;color:#4b5563;">Paste your TomTom API key to enable the map and geocoding.</p>' : ''}
    <div class="form-row">
      <label>Display name</label>
      <input id="sName" value="${escapeAttr(state.profile?.display_name || '')}" />
    </div>
    <div class="form-row">
      <label>My salesperson code</label>
      <input id="sCode" value="${escapeAttr(state.profile?.salesperson_code || '')}" placeholder="e.g. NHOU.007" />
    </div>
    <div class="form-row">
      <label>TomTom API key</label>
      <input id="sKey" value="${escapeAttr(state.tomtomKey || '')}" placeholder="Your TomTom API key" />
    </div>
    <div style="font-size:12px;color:#6b7280;">Get a free key at developer.tomtom.com — Maps + Search products.</div>

    <div class="detail-section">
      <h3>Import data</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn" id="sImportCustomers">Import customers (Excel)</button>
        <button class="btn" id="sImportVisits">Import visit history (Excel)</button>
        <button class="btn" id="sImportZones">Load zones (KML)</button>
      </div>
    </div>

    ${firstRun ? '' : `
    <div class="detail-section" style="border-top:1px solid #e5e7eb;padding-top:14px;">
      <h3 style="color:#b91c1c;">Danger zone</h3>
      <div style="font-size:12px;color:#6b7280;margin-bottom:8px;">Removes all customers and visit history. Zones stay.</div>
      <button class="btn btn-danger" id="sClearAll">Clear all customers and visits</button>
    </div>`}
  `, async () => {
    const key = getVal('sKey') || '';
    const name = getVal('sName');
    const code = getVal('sCode');
    localStorage.setItem('tomtom_api_key', key);
    state.tomtomKey = key;
    await sb.from('profiles').update({ display_name: name || state.profile.display_name, salesperson_code: code }).eq('id', state.user.id);
    const { data: prof } = await sb.from('profiles').select('*').eq('id', state.user.id).single();
    state.profile = prof;
    closeModal();
    showToast('Saved. Reloading…', 1200);
    setTimeout(() => location.reload(), 800);
  });

  document.getElementById('sImportCustomers').addEventListener('click', () => { closeModal(); importCustomersFlow(); });
  document.getElementById('sImportVisits').addEventListener('click', () => { closeModal(); importVisitsFlow(); });
  document.getElementById('sImportZones').addEventListener('click', () => { closeModal(); importZonesFlow(); });

  const clearBtn = document.getElementById('sClearAll');
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    if (!confirm('Delete ALL customers and visit history? Cannot be undone.')) return;
    if (!confirm('Really sure?')) return;
    const { error: e1 } = await sb.from('visits').delete().neq('id', 0);
    const { error: e2 } = await sb.from('customers').delete().neq('id', 0);
    if (e1 || e2) { showToast(`Delete failed: ${(e1 || e2).message}`, 5000); return; }
    closeModal(); showToast('All customers and visits deleted', 3000); await refreshAll();
  });
}

// ============== IMPORTERS ==============
const CUSTOMER_TARGETS = [
  { value: '', label: '— Ignore —' },
  { value: 'customer_no', label: 'Customer #' },
  { value: 'company', label: 'Company' },
  { value: 'contact_name', label: 'Contact name' },
  { value: 'job_title', label: 'Job title / role' },
  { value: 'salesperson_code', label: 'Salesperson code' },
  { value: 'territory_code', label: 'Territory code' },
  { value: 'address', label: 'Address (street)' },
  { value: 'city', label: 'City' },
  { value: 'state', label: 'State' },
  { value: 'post_code', label: 'Post code / ZIP' },
  { value: 'phone', label: 'Phone' },
  { value: 'mobile', label: 'Mobile' },
  { value: 'email', label: 'Email' },
  { value: '__blocked', label: 'Blocked / inactive flag (skip row if truthy)' },
];
const VISIT_TARGETS = [
  { value: '', label: '— Ignore —' },
  { value: 'customer_no', label: 'Customer #' },
  { value: 'company', label: 'Company name' },
  { value: 'contact_name', label: 'Contact name' },
  { value: 'visit_date', label: 'Visit date  (required)' },
  { value: 'outcome', label: 'Outcome' },
  { value: 'notes', label: 'Notes' },
];

const CUSTOMER_ALIASES = {
  no:'customer_no', number:'customer_no', customer_no:'customer_no', customer_number:'customer_no',
  acct_no:'customer_no', account_no:'customer_no', account_number:'customer_no',
  blocked:'__blocked', inactive:'__blocked',
  company:'company', company_name:'company', business:'company', business_name:'company',
  account:'company', account_name:'company',
  contact_name:'contact_name', contact:'contact_name', name:'contact_name', full_name:'contact_name',
  primary_contact:'contact_name',
  salesperson_code:'salesperson_code', salesperson:'salesperson_code', sales_rep:'salesperson_code', rep:'salesperson_code',
  address:'address', address_line_1:'address', address1:'address', street:'address', street_address:'address',
  mailing_address:'address',
  city:'city', town:'city',
  state:'state', province:'state', region:'state',
  post_code:'post_code', postcode:'post_code', postal_code:'post_code', zip_code:'post_code', zip:'post_code',
  phone:'phone', phone_no:'phone', phone_number:'phone', telephone:'phone', office_phone:'phone', work_phone:'phone',
  mobile:'mobile', mobile_phone:'mobile', mobile_phone_no:'mobile', mobile_no:'mobile', cell:'mobile',
  cell_phone:'mobile', cellphone:'mobile',
  email:'email', email_address:'email', e_mail:'email',
  job_title:'job_title', title:'job_title', position:'job_title', role:'job_title',
  job_responsibility:'job_title', primary_job_responsibility:'job_title', responsibility:'job_title',
  territory_code:'territory_code', territory:'territory_code', region_code:'territory_code',
  geocode:'geocode_quality',
};
const VISIT_ALIASES = {
  no:'customer_no', number:'customer_no', customer_no:'customer_no', customer_number:'customer_no',
  acct_no:'customer_no', account_no:'customer_no', account_number:'customer_no',
  company:'company', company_name:'company', account:'company', account_name:'company', business:'company',
  business_name:'company',
  contact_name:'contact_name', contact:'contact_name', name:'contact_name', full_name:'contact_name',
  primary_contact:'contact_name',
  visit_date:'visit_date', date:'visit_date', visited:'visit_date', visit:'visit_date', when:'visit_date',
  contact_date:'visit_date', meeting_date:'visit_date',
  outcome:'outcome', result:'outcome', status:'outcome', disposition:'outcome', action:'outcome',
  notes:'notes', note:'notes', comments:'notes', comment:'notes', description:'notes', details:'notes',
};

function normalizeHeader(h) {
  if (!h) return '';
  return String(h)
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/[^\w\s]/g, '')
    .trim().toLowerCase().replace(/\s+/g, '_');
}

function isBlocked(val) {
  if (val == null) return false;
  const s = String(val).trim().toLowerCase();
  return ['yes','true','1','x','y','blocked','inactive'].includes(s);
}
function parseDateFlexible(v) {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(epoch.getTime() + v * 86400000);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return null;
  }
  const d = new Date(String(v).trim());
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}
function jitter(seed) {
  let h = 0; const s = String(seed || Math.random());
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i);
  return { dLat: (((h >> 8) & 0xff) / 255 - 0.5) * 0.0020, dLng: ((h & 0xff) / 255 - 0.5) * 0.0025 };
}

async function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept;
    input.addEventListener('change', () => resolve(input.files[0] || null));
    input.click();
  });
}

function readWorkbook(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
        resolve(wb);
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error('Read failed'));
    reader.readAsArrayBuffer(file);
  });
}

function buildPreview(file, aliases, targets) {
  return readWorkbook(file).then((wb) => {
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (rows.length === 0) return { headers: [], rowCount: 0, autoMap: {}, samples: {}, targets, rows: [] };
    const headers = Object.keys(rows[0]);
    const autoMap = {}; const samples = {};
    for (const h of headers) {
      autoMap[h] = aliases[normalizeHeader(h)] || '';
      for (let i = 0; i < Math.min(5, rows.length); i++) {
        const v = rows[i][h];
        if (v !== undefined && v !== null && (typeof v !== 'string' || v.trim() !== '')) {
          samples[h] = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 60);
          break;
        }
      }
      if (samples[h] === undefined) samples[h] = '';
    }
    return { headers, rowCount: rows.length, autoMap, samples, targets, rows };
  });
}

function buildMappingDialogBody(preview, requireDate) {
  const { headers, rowCount, autoMap, samples, targets } = preview;
  const unmatched = headers.filter((h) => !autoMap[h]).length;
  const summary = unmatched === 0
    ? `<span style="color:#15803d;">All ${headers.length} columns auto-matched ✓</span> · ${rowCount} rows`
    : `<span style="color:#b45309;">${unmatched} of ${headers.length} columns need mapping</span> · ${rowCount} rows`;
  const rowsHtml = headers.map((h) => {
    const sel = autoMap[h] || '';
    const sample = samples[h] || '';
    return `
      <div class="mapping-row">
        <div class="mapping-cell-header">
          <div class="mapping-h">${escapeHtml(h)}</div>
          <div class="mapping-sample">${sample ? 'e.g. ' + escapeHtml(sample) : '(no sample)'}</div>
        </div>
        <div class="mapping-cell-select">
          <select data-mapping-header="${escapeAttr(h)}">
            ${targets.map((f) => `<option value="${f.value}"${f.value === sel ? ' selected' : ''}>${escapeHtml(f.label)}</option>`).join('')}
          </select>
        </div>
      </div>`;
  }).join('');
  return `
    <div style="font-size:13px;margin-bottom:10px;color:#374151;">${summary}</div>
    <div style="font-size:12px;color:#6b7280;margin-bottom:10px;">
      Match each Excel column to a SalesMap field. Set to <em>— Ignore —</em> to skip a column.${requireDate ? ' <b>Visit date is required.</b>' : ''}
    </div>
    <div class="mapping-table">
      <div class="mapping-row mapping-head">
        <div class="mapping-cell-header"><b>Excel column</b></div>
        <div class="mapping-cell-select"><b>SalesMap field</b></div>
      </div>
      ${rowsHtml}
    </div>`;
}

function readMapping() {
  const m = {};
  document.querySelectorAll('select[data-mapping-header]').forEach((s) => {
    m[s.dataset.mappingHeader] = s.value || '';
  });
  return m;
}

async function importCustomersFlow() {
  const file = await pickFile('.xlsx,.xlsm,.xls');
  if (!file) return;
  showToast('Reading file…', 0);
  let preview;
  try { preview = await buildPreview(file, CUSTOMER_ALIASES, CUSTOMER_TARGETS); }
  catch (err) { showToast(`Read failed: ${err.message}`, 5000); return; }
  hideToast();
  if (!preview.rowCount) { showToast('Sheet appears empty.', 3000); return; }

  openModal('Map Excel columns', buildMappingDialogBody(preview, false), async () => {
    const mapping = readMapping();
    const hasIdent = Object.values(mapping).some((v) => ['company','contact_name','customer_no'].includes(v));
    if (!hasIdent) { showToast('Map at least Company, Contact name, or Customer # first.', 4000); return; }
    closeModal();
    await runCustomerImport(preview.rows, mapping);
  });
}

async function runCustomerImport(rows, mapping) {
  let imported = 0, geocoded = 0, reused = 0, failed = 0, skipped = 0;
  const geocodeCache = new Map();

  // Pre-fetch existing customers for change-detection
  const { data: existingAll } = await sb.from('customers').select('id, customer_no, company, contact_name, address, city, state, post_code, lat, lng');
  const byNo = new Map(); const byTriple = new Map();
  for (const e of (existingAll || [])) {
    if (e.customer_no) byNo.set(e.customer_no, e);
    byTriple.set(`${e.company || ''}|${e.contact_name || ''}|${e.address || ''}`, e);
  }

  for (let i = 0; i < rows.length; i++) {
    const data = {};
    for (const [h, f] of Object.entries(mapping)) {
      if (!f) continue;
      const v = rows[i][h];
      if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) continue;
      if (f === '__blocked') data.__blocked = v;
      else data[f] = String(v).trim();
    }
    if (isBlocked(data.__blocked)) { skipped++; continue; }
    delete data.__blocked;
    if (!data.company && !data.address && !data.city) continue;

    const existing = (data.customer_no && byNo.get(data.customer_no))
      || byTriple.get(`${data.company || ''}|${data.contact_name || ''}|${data.address || ''}`);
    const unchanged = existing && existing.lat != null && existing.lng != null
      && (existing.address || '') === (data.address || '')
      && (existing.city || '') === (data.city || '')
      && (existing.state || '') === (data.state || '')
      && (existing.post_code || '') === (data.post_code || '');

    if (unchanged) {
      // Update text fields only; preserve lat/lng/zone
      const upd = { ...data };
      delete upd.lat; delete upd.lng;
      await sb.from('customers').update(upd).eq('id', existing.id);
      reused++; imported++;
      showToast(`(${i + 1}/${rows.length}) unchanged: ${data.company || ''}`, 0);
      continue;
    }
    const full = [data.address, data.city, data.state, data.post_code].filter(Boolean).join(', ');
    showToast(`Geocoding ${i + 1}/${rows.length}: ${data.company || full}`, 0);
    try {
      let geo = geocodeCache.get(full);
      if (!geo) { geo = await geocodeAddress(full); if (geo) geocodeCache.set(full, geo); await new Promise(r => setTimeout(r, 180)); }
      if (geo) {
        if (!data.address) {
          const j = jitter(data.customer_no || `${data.company}|${data.contact_name}|${i}`);
          data.lat = geo.lat + j.dLat; data.lng = geo.lng + j.dLng; data.geocode_quality = 'ZIP';
        } else {
          data.lat = geo.lat; data.lng = geo.lng; data.geocode_quality = geo.quality;
        }
        data.zone_id = findZoneForPoint(data.lat, data.lng);
        geocoded++;
      } else {
        data.geocode_quality = 'FAILED'; failed++;
      }
    } catch (err) {
      data.geocode_quality = 'FAILED'; failed++;
    }

    if (existing) {
      await sb.from('customers').update(data).eq('id', existing.id);
    } else {
      data.created_by = state.user.id;
      const { data: ins } = await sb.from('customers').insert(data).select('id').single();
      if (ins && data.customer_no) byNo.set(data.customer_no, { ...data, id: ins.id });
    }
    imported++;
  }
  showToast(`Imported ${imported} (${geocoded} geocoded, ${reused} unchanged, ${failed} failed, ${skipped} blocked)`, 7000);
  await refreshAll();
}

async function importVisitsFlow() {
  const file = await pickFile('.xlsx,.xlsm,.xls');
  if (!file) return;
  showToast('Reading file…', 0);
  let preview;
  try { preview = await buildPreview(file, VISIT_ALIASES, VISIT_TARGETS); }
  catch (err) { showToast(`Read failed: ${err.message}`, 5000); return; }
  hideToast();
  if (!preview.rowCount) { showToast('Sheet appears empty.', 3000); return; }

  openModal('Map visit columns', buildMappingDialogBody(preview, true), async () => {
    const mapping = readMapping();
    const values = Object.values(mapping);
    if (!values.includes('visit_date')) { showToast('Map a Visit date column.', 4000); return; }
    const hasMatch = values.some((v) => ['customer_no','company','contact_name'].includes(v));
    if (!hasMatch) { showToast('Map at least Customer #, Company, or Contact name.', 4500); return; }
    closeModal();
    await runVisitImport(preview.rows, mapping);
  });
}

async function runVisitImport(rows, mapping) {
  // Pre-fetch customers for matching
  const { data: customers } = await sb.from('customers').select('id, customer_no, company, contact_name');
  const byNo = new Map(); const byCC = new Map(); const byCompany = new Map();
  for (const c of (customers || [])) {
    if (c.customer_no) byNo.set(String(c.customer_no), c.id);
    if (c.company && c.contact_name) byCC.set(`${c.company.toLowerCase()}|${c.contact_name.toLowerCase()}`, c.id);
    if (c.company) {
      const key = c.company.toLowerCase();
      const arr = byCompany.get(key) || [];
      arr.push(c.id); byCompany.set(key, arr);
    }
  }
  let imported = 0, duplicates = 0, unmatched = 0, badDate = 0;
  const unmatchedSamples = [];

  for (let i = 0; i < rows.length; i++) {
    const data = {};
    for (const [h, f] of Object.entries(mapping)) {
      if (!f) continue;
      const v = rows[i][h];
      if (v === undefined || v === null) continue;
      if (typeof v === 'string' && v.trim() === '') continue;
      data[f] = v;
    }
    const date = parseDateFlexible(data.visit_date);
    if (!date) { badDate++; continue; }
    const cNo = data.customer_no != null ? String(data.customer_no).trim() : '';
    const co = data.company != null ? String(data.company).trim() : '';
    const cn = data.contact_name != null ? String(data.contact_name).trim() : '';
    let cid = null;
    if (cNo && byNo.has(cNo)) cid = byNo.get(cNo);
    else if (co && cn) cid = byCC.get(`${co.toLowerCase()}|${cn.toLowerCase()}`) || null;
    else if (co) {
      const arr = byCompany.get(co.toLowerCase());
      if (arr && arr.length === 1) cid = arr[0];
    }
    if (!cid) {
      unmatched++;
      if (unmatchedSamples.length < 5) unmatchedSamples.push(`${cNo || co}${cn ? ' / ' + cn : ''}`);
      continue;
    }
    const outcome = data.outcome ? String(data.outcome).trim() : null;
    const notes = data.notes ? String(data.notes).trim() : null;
    // Check duplicate
    const { data: dupe } = await sb
      .from('visits').select('id').eq('customer_id', cid).eq('visit_date', date)
      .is('outcome', outcome === null ? null : undefined)
      .eq('outcome', outcome || '');
    // The Supabase query above is awkward for NULL — do a fallback:
    let isDup = false;
    if (dupe && dupe.length) isDup = true;
    if (!isDup) {
      const { data: dupe2 } = await sb
        .from('visits').select('id, outcome')
        .eq('customer_id', cid).eq('visit_date', date);
      if (dupe2) for (const d of dupe2) {
        if ((d.outcome || '') === (outcome || '')) { isDup = true; break; }
      }
    }
    if (isDup) { duplicates++; continue; }
    await sb.from('visits').insert({
      customer_id: cid, visitor_id: state.user.id, visit_date: date, outcome, notes,
    });
    imported++;
    if (i % 25 === 0) showToast(`Imported ${imported}/${rows.length}…`, 0);
  }
  const more = unmatchedSamples.length ? ` Unmatched: ${unmatchedSamples.join('; ')}` : '';
  showToast(`Imported ${imported} visits (${duplicates} duplicates, ${unmatched} unmatched, ${badDate} bad dates).${more}`, 8000);
  await refreshAll();
}

async function importZonesFlow() {
  const file = await pickFile('.kml');
  if (!file) return;
  showToast('Loading KML…', 0);
  const text = await file.text();
  const dom = new DOMParser().parseFromString(text, 'text/xml');
  const fc = toGeoJSON.kml(dom);
  const DEFAULT_COLORS = ['#e11d48','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#14b8a6','#f97316','#06b6d4','#a855f7','#84cc16','#ef4444'];
  const zones = []; let idx = 0;
  for (const f of (fc.features || [])) {
    if (!f.geometry) continue;
    const t = f.geometry.type;
    if (t !== 'Polygon' && t !== 'MultiPolygon') continue;
    const name = (f.properties && (f.properties.name || f.properties.Name)) || `Zone ${zones.length + 1}`;
    const color = (f.properties && (f.properties.fill || f.properties.stroke)) || DEFAULT_COLORS[idx++ % DEFAULT_COLORS.length];
    zones.push({ name, color, geojson: f });
  }
  if (zones.length === 0) { showToast('No polygons found in KML.', 4000); return; }
  // Replace all zones (admin only — server will reject for non-admins)
  const { error: delErr } = await sb.from('zones').delete().neq('id', 0);
  if (delErr) { showToast(`Zone delete failed: ${delErr.message}. Are you an admin?`, 6000); return; }
  for (const z of zones) {
    const { error } = await sb.from('zones').insert(z);
    if (error) { showToast(`Insert failed: ${error.message}`, 6000); return; }
  }
  // Reassign customer zones
  await refreshAll();
  let reassigned = 0;
  for (const c of state.customers) {
    if (c.lat == null || c.lng == null) continue;
    const z = findZoneForPoint(c.lat, c.lng);
    if (z !== c.zone_id) {
      await sb.from('customers').update({ zone_id: z }).eq('id', c.id);
      reassigned++;
    }
  }
  showToast(`Loaded ${zones.length} zones, reassigned ${reassigned} customers.`, 5000);
  await refreshAll();
}

// ============== MODAL / TOAST ==============
function openModal(title, bodyHtml, onSave) {
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal">
        <div class="modal-header">
          <h2>${escapeHtml(title)}</h2>
          <button class="close" id="modalClose" style="background:none;border:none;font-size:22px;cursor:pointer;color:#6b7280;">×</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-footer">
          <button class="btn" id="modalCancel">Cancel</button>
          <button class="btn btn-primary" id="modalSave">Save</button>
        </div>
      </div>
    </div>`;
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modalCancel').addEventListener('click', closeModal);
  document.getElementById('modalSave').addEventListener('click', onSave);
}
function closeModal() { document.getElementById('modalRoot').innerHTML = ''; }

let toastTimer = null;
function showToast(msg, durationMs) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  if (durationMs > 0) toastTimer = setTimeout(() => t.classList.add('hidden'), durationMs);
}
function hideToast() { document.getElementById('toast').classList.add('hidden'); }

// ============== HELPERS ==============
function getVal(id) { return document.getElementById(id).value.trim() || null; }
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s || ''); }
