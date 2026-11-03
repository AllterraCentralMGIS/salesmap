/* SalesMap — web app (single-file, vanilla JS, Supabase backend) */
/* global tt, supabase, XLSX, toGeoJSON, turf */
'use strict';

const CFG = window.SALESMAP_CONFIG;
// Read invite/reset link details before the Supabase client consumes the URL.
// Three link shapes are handled:
//  - ?token_hash=…&type=invite|recovery (email templates point here): the code is only
//    used when the person taps Continue, so an email link scanner that opens the page
//    can't use up the one-time link
//  - ?code=… (PKCE): exchanged for a session on load
//  - #access_token=…&type=… (Supabase's default links): read by the client itself
const AUTH_LINK = (() => {
  const q = new URLSearchParams(location.search.slice(1));
  const h = new URLSearchParams(location.hash.slice(1));
  return {
    type: h.get('type') || q.get('type'),
    error: h.get('error_description') || q.get('error_description'),
    errorCode: h.get('error_code') || q.get('error_code'),
    tokenHash: q.get('token_hash'),
    code: q.get('code'),
  };
})();
function clearAuthParams() {
  history.replaceState(null, '', location.pathname);
}
const sb = supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);

const state = {
  user: null,
  profile: null,
  profilesById: {},
  customers: [],
  zones: [],
  selectedId: null,
  selectedMarker: null,
  me: null, meMarker: null, nearMe: false, myCode: null,
  zoneLayers: [],
  map: null,
  filters: { q: '', zoneId: '', salesperson: '', recency: '', visitor: '', viewport: false },
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
  // Suppress the generic "Load failed" fetch noise from TomTom internal retries —
  // the map's own error handler will surface anything real
  if (msg === 'Load failed' || msg === 'TypeError: Load failed') return;
  showToast(`Error: ${msg}`, 5000);
});

// ============== THEME ==============
function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme(pref) {
  const t = resolveTheme(pref);
  document.documentElement.setAttribute('data-theme', t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#041422' : '#003054');
}
// Note: TomTom v6 SDK doesn't reliably accept a dark style URL across regions.
// For dark mode we keep the default light map tiles and only darken the UI.
// That matches Google Maps/Strava etc. and avoids the "style load failed" error.
// Dark is the default; 'auto' and 'light' are opt-in from Settings.
const DEFAULT_THEME = 'dark';
applyTheme(localStorage.getItem('theme') || DEFAULT_THEME);
// Live-update if user changes their OS theme while on 'auto'
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if ((localStorage.getItem('theme') || DEFAULT_THEME) === 'auto') {
    applyTheme('auto');
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  bindAuthUI();
  if (AUTH_LINK.tokenHash && (AUTH_LINK.type === 'invite' || AUTH_LINK.type === 'recovery')) {
    showLinkStep(AUTH_LINK.type);
    return bindAuthEvents();
  }
  if (AUTH_LINK.code) {
    const { error } = await sb.auth.exchangeCodeForSession(AUTH_LINK.code);
    clearAuthParams();
    if (error) { showAuthScreen(); showLinkError(); return bindAuthEvents(); }
    showSetPassword('link');
    return bindAuthEvents();
  }
  const { data: { session } } = await sb.auth.getSession();
  if (session && (AUTH_LINK.type === 'invite' || AUTH_LINK.type === 'recovery')) {
    showSetPassword('link');
  } else if (session) {
    await onSignedIn(session.user);
  } else {
    showAuthScreen();
    if (AUTH_LINK.error) showLinkError();
  }
  bindAuthEvents();
});
function bindAuthEvents() {
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') location.reload();
    if (event === 'PASSWORD_RECOVERY') showSetPassword('link');
  });
}
// The one-time code is used only when the person taps Continue (scanners don't tap)
function showLinkStep(type) {
  showAuthScreen();
  document.getElementById('authForm').classList.add('hidden');
  document.getElementById('authFootnote').classList.add('hidden');
  document.querySelector('.auth-sub').textContent = type === 'invite'
    ? 'Welcome. Tap Continue to choose your password.'
    : 'Tap Continue to choose a new password.';
  const step = document.getElementById('linkStep');
  step.classList.remove('hidden');
  const btn = document.getElementById('linkContinue');
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'Checking…';
    const { error } = await sb.auth.verifyOtp({ token_hash: AUTH_LINK.tokenHash, type: AUTH_LINK.type });
    clearAuthParams();
    step.classList.add('hidden');
    if (error) {
      document.getElementById('authForm').classList.remove('hidden');
      document.getElementById('authFootnote').classList.remove('hidden');
      document.querySelector('.auth-sub').textContent = "Sign in to access your team's customer map.";
      showLinkError();
      return;
    }
    showSetPassword('link');
  }, { once: true });
}
function showLinkError() {
  const msg = document.getElementById('authMsg');
  msg.textContent = 'This link has expired or was already used. Enter your email above and tap "Email me a reset link" to get a fresh one.';
  msg.className = 'auth-msg error';
}

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

  document.getElementById('pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = document.getElementById('pwNew').value;
    const msg = document.getElementById('authMsg');
    if (pw.length < 8) {
      msg.textContent = 'Use at least 8 characters.';
      msg.className = 'auth-msg error';
      return;
    }
    if (pw !== document.getElementById('pwConfirm').value) {
      msg.textContent = 'The two passwords don\'t match.';
      msg.className = 'auth-msg error';
      return;
    }
    msg.textContent = 'Saving…';
    msg.className = 'auth-msg';
    const { data, error } = await sb.auth.updateUser({ password: pw });
    if (error) {
      msg.textContent = error.message;
      msg.className = 'auth-msg error';
      return;
    }
    const mode = pwMode;
    hideSetPassword();
    if (mode === 'change') {
      hideAuthScreen();
      showToast('Password changed.', 2500);
    } else {
      await onSignedIn(data.user);
      showToast('Password saved. Use it with your email next time.', 3500);
    }
  });

  document.getElementById('pwCancel').addEventListener('click', () => {
    hideSetPassword();
    hideAuthScreen();
  });
}

// mode 'link': arrived from an invite or reset email; 'change': from Settings while signed in
let pwMode = null;
function showSetPassword(mode) {
  pwMode = mode;
  document.getElementById('authForm').classList.add('hidden');
  document.getElementById('authFootnote').classList.add('hidden');
  document.getElementById('pwForm').classList.remove('hidden');
  document.getElementById('pwCancel').classList.toggle('hidden', mode !== 'change');
  document.querySelector('.auth-sub').textContent = mode === 'change'
    ? 'Choose a new password (8+ characters).'
    : 'Choose a password (8+ characters). You\'ll use it with your email to sign in.';
  document.getElementById('authMsg').textContent = '';
  showAuthScreen();
  document.getElementById('pwNew').focus();
}
function hideSetPassword() {
  pwMode = null;
  document.getElementById('pwForm').reset();
  document.getElementById('pwForm').classList.add('hidden');
  document.getElementById('authForm').classList.remove('hidden');
  document.getElementById('authFootnote').classList.remove('hidden');
  document.querySelector('.auth-sub').textContent = 'Sign in to access your team\'s customer map.';
  document.getElementById('authMsg').textContent = '';
}

async function onSignedIn(user) {
  state.user = user;
  // Load own profile (it's auto-created by DB trigger)
  const { data: prof } = await sb.from('profiles').select('*').eq('id', user.id).single();
  state.profile = prof;
  hideAuthScreen();
  bindAppUI();
  document.getElementById('counts').textContent = 'Loading customers…';
  state.tomtomKey = localStorage.getItem('tomtom_api_key') || CFG.DEFAULT_TOMTOM_KEY || '';
  if (!state.tomtomKey) {
    openSettings(true);
  }
  await refreshAll();
  // First view is the rep's own customers; "All salespeople" is one tap away
  const myCode = state.profile && state.profile.salesperson_code;
  state.myCode = myCode || null;
  if (myCode && state.customers.some((c) => c.salesperson_code === myCode)) {
    state.filters.salesperson = myCode;
    document.getElementById('filterSalesperson').value = myCode;
    renderList();
  }
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
  const searchDebounced = debounce(() => { renderList(); renderMarkers(); }, 150);
  document.getElementById('search').addEventListener('input', (e) => {
    state.filters.q = e.target.value.trim().toLowerCase();
    searchDebounced();
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
  document.getElementById('filterViewport').addEventListener('change', (e) => {
    state.filters.viewport = e.target.checked;
    renderList();
  });
  document.getElementById('btnNewCustomer').addEventListener('click', () => openCustomerForm(null));
  document.getElementById('btnSettings').addEventListener('click', () => openSettings(false));
  document.getElementById('btnSignOut').addEventListener('click', async () => { await sb.auth.signOut(); });
  document.getElementById('detailClose').addEventListener('click', closeDetail);
  const selected = () => state.customers.find((x) => x.id === state.selectedId);
  document.getElementById('btnLogVisit').addEventListener('click', () => { if (state.selectedId != null) openVisitForm(state.selectedId); });
  document.getElementById('btnEditCustomer').addEventListener('click', () => { const c = selected(); if (c) openCustomerForm(c); });
  document.getElementById('btnDeleteCustomer').addEventListener('click', () => { const c = selected(); if (c) deleteCustomer(c); });
  const sidebar = document.getElementById('sidebar');
  const sbClose = document.getElementById('btnSidebarClose');
  if (sbClose) sbClose.addEventListener('click', () => setSheet(sidebar, 'peek'));
  sheetDrag(document.getElementById('sheetHandle'), sidebar);
  sheetDrag(document.getElementById('detailHandle'), document.getElementById('detail'));
  document.getElementById('search').addEventListener('focus', () => {
    if (isPhone() && sidebar.dataset.sheet === 'peek') setSheet(sidebar, 'half');
  });
  document.getElementById('chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-chip]');
    if (chip) onChip(chip.dataset.chip);
  });
  renderChips();
  const recenter = document.getElementById('recenterBtn');
  if (recenter) recenter.addEventListener('click', () => fitMapToCustomers());
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
  // "Locate me" button — shows your live position with a moving dot
  state.map.addControl(new tt.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true,
  }));
  state.map.on('load', () => {
    renderZonePolygons();
    buildMarkers();
    fitMapToCustomers({ core: true }); // first view: the rep's own customers, outliers left out
  });
  // Refresh the sidebar list when panning/zooming if viewport-filter is on
  const viewportList = debounce(() => { if (state.filters.viewport) renderList(); }, 120);
  state.map.on('moveend', viewportList);
  state.map.on('error', (e) => {
    console.error('Map error:', e && e.error);
    if (e && e.error && e.error.status === 403) {
      showToast('TomTom rejected the API key (403). Check it in Settings.', 6000);
    }
  });
}
function showMapPlaceholder(msg) {
  document.getElementById('map').innerHTML =
    `<div class="empty-state tall">${escapeHtml(msg)}</div>`;
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
    const under = state.map.getLayer('clusters') ? 'clusters' : undefined;
    state.map.addLayer({
      id: sourceId, type: 'fill', source: sourceId,
      paint: { 'fill-color': z.color || '#888', 'fill-opacity': 0.12 },
    }, under);
    state.map.addLayer({
      id: sourceId + '-outline', type: 'line', source: sourceId,
      paint: { 'line-color': z.color || '#888', 'line-width': 1.5, 'line-opacity': 0.7 },
    }, under);
    state.zoneLayers.push(sourceId);
  }
}

// Customers are a clustered GeoJSON layer drawn by the map, not DOM markers: cheap
// at 1,650 points, and dense areas merge into counted circles. Only the selected
// customer gets a DOM pin, so it can carry the gold ring and pulse.
const PIN_COLORS = { never: '#d93025', stale: '#f08c00', mid: '#e6c400', fresh: '#1f9d55' };
function customerFeatures(list) {
  const features = [];
  for (const c of list) {
    if (!isReasonableCoord(c.lat, c.lng)) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
      properties: { id: c.id, bucket: recencyBucket(c.last_visit_date) },
    });
  }
  return { type: 'FeatureCollection', features };
}
// The cluster labels need a font the TomTom style actually serves
function mapTextFont() {
  const layers = (state.map.getStyle() || {}).layers || [];
  const l = layers.find((x) => x.type === 'symbol' && x.layout && x.layout['text-font']);
  const f = l ? l.layout['text-font'] : null;
  return Array.isArray(f) && f.length ? f : ['Noto-Regular'];
}
function buildMarkers() {
  if (!state.map) return;
  const data = customerFeatures(applyFilters(state.customers));
  const src = state.map.getSource('customers');
  if (src) { src.setData(data); setSelectedPin(null, state.selectedId); return; }
  try {
    // Pins at metro zoom and closer so every customer's recency colour shows;
    // clusters only when zoomed out to roughly a whole state or wider.
    state.map.addSource('customers', {
      type: 'geojson', data, cluster: true, clusterRadius: 38, clusterMaxZoom: 6,
      clusterProperties: { overdue: ['+', ['case', ['match', ['get', 'bucket'], ['never', 'stale'], true, false], 1, 0]] },
    });
  } catch (e) {
    // Style not ready yet: try again once it is
    state.map.once('styledata', buildMarkers);
    return;
  }
  state.map.addLayer({
    id: 'clusters', type: 'circle', source: 'customers', filter: ['has', 'point_count'],
    paint: {
      // Colour = share of the cluster not visited in 90+ days (never counts as overdue)
      'circle-color': ['step', ['/', ['get', 'overdue'], ['get', 'point_count']],
        PIN_COLORS.fresh, 0.3, PIN_COLORS.mid, 0.6, PIN_COLORS.stale, 0.9, PIN_COLORS.never],
      'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
      'circle-radius': ['step', ['get', 'point_count'], 15, 25, 19, 100, 23, 400, 28],
    },
  });
  state.map.addLayer({
    id: 'cluster-count', type: 'symbol', source: 'customers', filter: ['has', 'point_count'],
    layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': mapTextFont(), 'text-size': 13, 'text-allow-overlap': true },
    paint: {
      'text-color': ['step', ['/', ['get', 'overdue'], ['get', 'point_count']], '#ffffff', 0.3, '#3a2c00', 0.6, '#ffffff'],
    },
  });
  state.map.addLayer({
    id: 'points', type: 'circle', source: 'customers', filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': ['match', ['get', 'bucket'], 'stale', PIN_COLORS.stale, 'mid', PIN_COLORS.mid, 'fresh', PIN_COLORS.fresh, PIN_COLORS.never],
      // Small at regional zoom so dense metros stay readable, bigger as you close in
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3.5, 8, 4.5, 10, 6, 13, 8],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6, 0.75, 9, 1.5, 12, 2],
    },
    // Recently visited draw on top so they aren't buried under red
    layout: { 'circle-sort-key': ['match', ['get', 'bucket'], 'fresh', 3, 'mid', 2, 'stale', 1, 0] },
  });
  // Small pins: hit-test a 22 px box around the tap instead of the dot itself
  state.map.on('click', (e) => {
    const r = 11, p = e.point;
    const hits = state.map.queryRenderedFeatures([[p.x - r, p.y - r], [p.x + r, p.y + r]], { layers: ['points'] });
    if (!hits.length) return;
    const nearest = hits.reduce((a, b) => {
      const da = state.map.project(a.geometry.coordinates), db = state.map.project(b.geometry.coordinates);
      return Math.hypot(db.x - p.x, db.y - p.y) < Math.hypot(da.x - p.x, da.y - p.y) ? b : a;
    });
    selectCustomer(nearest.properties.id, false);
  });
  state.map.on('click', 'clusters', (e) => {
    const f = e.features && e.features[0];
    if (!f) return;
    state.map.getSource('customers').getClusterExpansionZoom(f.properties.cluster_id, (err, zoom) => {
      if (err) return;
      state.map.easeTo({ center: f.geometry.coordinates, zoom: zoom + 0.4 });
    });
  });
  for (const id of ['points', 'clusters']) {
    state.map.on('mouseenter', id, () => { state.map.getCanvas().style.cursor = 'pointer'; });
    state.map.on('mouseleave', id, () => { state.map.getCanvas().style.cursor = ''; });
  }
  setSelectedPin(null, state.selectedId);
}
function renderMarkers() {
  if (!state.map) return;
  const src = state.map.getSource('customers');
  if (src) src.setData(customerFeatures(applyFilters(state.customers)));
}
function setSelectedPin(prevId, id) {
  if (!state.map) return;
  if (state.selectedMarker) { state.selectedMarker.remove(); state.selectedMarker = null; }
  const c = id != null ? state.customers.find((x) => x.id === id) : null;
  if (!c || !isReasonableCoord(c.lat, c.lng)) return;
  const el = document.createElement('div');
  el.className = `sm-pin selected ${recencyBucket(c.last_visit_date)}`;
  el.addEventListener('click', (e) => e.stopPropagation());
  state.selectedMarker = new tt.Marker({ element: el }).setLngLat([c.lng, c.lat]).addTo(state.map);
}

// Sanity guard — null, NaN, 0/0 sentinels, or coordinates outside planet Earth.
// We do NOT restrict by region — customers can be anywhere.
function isReasonableCoord(lat, lng) {
  if (lat == null || lng == null) return false;
  if (!isFinite(lat) || !isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  if (lat < -90 || lat > 90) return false;
  if (lng < -180 || lng > 180) return false;
  return true;
}

// Fit the map to the customers shown. With `core` set, outliers (customers more than
// ~150 mi from the median point) are left out so a handful of out-of-state accounts
// don't zoom the first view out to the whole country.
function fitMapToCustomers(opts) {
  if (!state.map) return;
  let pts = applyFilters(state.customers).filter((c) => isReasonableCoord(c.lat, c.lng));
  if (pts.length === 0) return;
  if (opts && opts.core && pts.length > 2) {
    const median = (arr) => { const a = [...arr].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
    const mLat = median(pts.map((c) => c.lat)), mLng = median(pts.map((c) => c.lng));
    const cosLat = Math.cos(mLat * Math.PI / 180);
    const core = pts.filter((c) => Math.hypot((c.lat - mLat) * 69, (c.lng - mLng) * 69 * cosLat) <= 150);
    if (core.length >= 2) pts = core;
  }
  const bounds = new tt.LngLatBounds();
  for (const c of pts) bounds.extend([c.lng, c.lat]);
  const phone = isPhone();
  state.map.fitBounds(bounds, {
    padding: phone ? { top: 60, left: 28, right: 64, bottom: coveredBottom() + 24 } : 80,
    maxZoom: phone ? 12 : 11,
  });
}
// Height of the map hidden behind the bottom sheets on the phone (0 on desktop).
// Uses the sheet's resting height for its current state, not a mid-transition height.
function coveredBottom() {
  if (!isPhone()) return 0;
  const vh = window.innerHeight;
  const restH = (el) => {
    if (!el || el.classList.contains('hidden')) return 0;
    const st = el.dataset.sheet || 'peek';
    if (st === 'full') return vh;
    if (el.id === 'detail') return st === 'half' ? vh * 0.62 : 150;
    return st === 'half' ? vh * 0.56 : 186;
  };
  return Math.min(vh * 0.7, Math.max(restH(document.getElementById('sidebar')), restH(document.getElementById('detail'))));
}
// Pan so a point sits in the middle of the map area that is still visible
function flyToVisible(lngLat, zoom) {
  const offsetY = -coveredBottom() / 2;
  state.map.flyTo({ center: lngLat, zoom, offset: [0, offsetY] });
}

// ============== DATA LAYER (Supabase) ==============
// PostgREST caps each response at 1000 rows by default. Fetch in pages until done.
async function fetchAll(builder) {
  const PAGE = 1000;
  let from = 0;
  let out = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await builder().range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out = out.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function refreshAll() {
  const [allCustomers, allZones, allProfiles, allVisits] = await Promise.all([
    fetchAll(() => sb.from('customers').select('*').order('company', { ascending: true })),
    fetchAll(() => sb.from('zones').select('*').order('name', { ascending: true })),
    fetchAll(() => sb.from('profiles').select('id, display_name, salesperson_code')),
    fetchAll(() => sb.from('visits').select('customer_id, visit_date, visitor_id')),
  ]);
  const customers = allCustomers;
  const zones = allZones;
  const profiles = allProfiles;
  const visitsAgg = allVisits;
  // Compute per-customer last_visit_date and visit_count
  const lastByCust = new Map();
  const countByCust = new Map();
  const visitorsByCust = new Map();
  for (const v of (visitsAgg || [])) {
    countByCust.set(v.customer_id, (countByCust.get(v.customer_id) || 0) + 1);
    if (v.visitor_id) {
      if (!visitorsByCust.has(v.customer_id)) visitorsByCust.set(v.customer_id, new Set());
      visitorsByCust.get(v.customer_id).add(v.visitor_id);
    }
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
    _visitorIds: visitorsByCust.get(c.id) || null,
  }));
  state.profilesById = Object.fromEntries((profiles || []).map((p) => [p.id, p]));
  populateZoneFilter();
  populateSalespersonFilter();
  populateVisitorFilter();
  renderList();
  if (state.map) { renderZonePolygons(); buildMarkers(); }
}

// Import-only libraries load on first use instead of at startup.
const LIBS = {
  xlsx: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  togeojson: 'https://cdn.jsdelivr.net/npm/@tmcw/togeojson@7.1.0/dist/togeojson.umd.min.js',
  turf: 'https://cdn.jsdelivr.net/npm/@turf/turf@7.2.0/turf.min.js',
};
const libLoads = {};
function ensureLib(name) {
  const present = { xlsx: () => typeof XLSX !== 'undefined', togeojson: () => typeof toGeoJSON !== 'undefined', turf: () => typeof turf !== 'undefined' }[name];
  if (present()) return Promise.resolve();
  if (!libLoads[name]) {
    libLoads[name] = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = LIBS[name];
      el.onload = resolve;
      el.onerror = () => { delete libLoads[name]; reject(new Error(`Could not load ${name}. Check the connection and try again.`)); };
      document.head.appendChild(el);
    });
  }
  return libLoads[name];
}

function findZoneForPoint(lat, lng) {
  if (!state.zones.length || typeof turf === 'undefined') return null;
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
  const { q, zoneId, salesperson, recency, visitor, viewport } = state.filters;
  // Compute viewport bounds once (not per-customer)
  let vb = null;
  if (viewport && state.map) {
    const b = state.map.getBounds();
    vb = { n: b.getNorth(), s: b.getSouth(), e: b.getEast(), w: b.getWest() };
  }
  return items.filter((c) => {
    if (vb) {
      if (c.lat == null || c.lng == null) return false;
      if (c.lat > vb.n || c.lat < vb.s) return false;
      if (c.lng > vb.e || c.lng < vb.w) return false;
    }
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
    if (visitor) {
      if (!c._visitorIds || !c._visitorIds.has(visitor)) return false;
    }
    return true;
  });
}

// ============== LIST ==============
function filtersActive() {
  const f = state.filters;
  return !!(f.q || f.zoneId || f.salesperson || f.recency || f.visitor || f.viewport);
}

async function deleteFiltered() {
  const filtered = applyFilters(state.customers);
  if (filtered.length === 0) return;
  const n = filtered.length;
  const ok = await confirmDialog({
    title: `Delete ${n} customer${n === 1 ? '' : 's'}?`,
    message: `These are the customers matching the current filters. Their visit history goes with them, and it cannot be undone.`,
    confirmLabel: 'Delete', danger: true, typed: String(n),
  });
  if (!ok) return;
  const ids = filtered.map((c) => c.id);
  const { error } = await sb.from('customers').delete().in('id', ids);
  if (error) { showToast(`Delete failed: ${error.message}`, 5000); return; }
  if (state.selectedId && ids.includes(state.selectedId)) closeDetail();
  showToast(`Deleted ${ids.length} customers.`, 3000);
  await refreshAll();
}

function renderList() {
  const ul = document.getElementById('customerList');
  const filtered = applyFilters(state.customers);
  const countsEl = document.getElementById('counts');
  countsEl.innerHTML = `<span>${filtered.length} of ${state.customers.length} customers</span>` +
    (filtersActive() ? `<button class="link-btn" id="btnClearFilters">Clear filters</button>` : '');
  const clearBtn = document.getElementById('btnClearFilters');
  if (clearBtn) clearBtn.addEventListener('click', clearFilters);

  if (state.customers.length === 0) {
    ul.innerHTML = `<li class="static"><div class="empty-state">
      <p>No customers yet.</p>
      <div class="btn-row center"><button class="btn btn-primary" id="emptyImport">Import customers</button><button class="btn" id="emptyNew">Add a customer</button></div>
    </div></li>`;
    document.getElementById('emptyImport').addEventListener('click', importCustomersFlow);
    document.getElementById('emptyNew').addEventListener('click', () => openCustomerForm(null));
    return;
  }
  if (filtered.length === 0) {
    ul.innerHTML = `<li class="static"><div class="empty-state">
      <p>No customers match these filters.</p>
      <div class="btn-row center"><button class="btn" id="emptyClear">Clear filters</button></div>
    </div></li>`;
    document.getElementById('emptyClear').addEventListener('click', clearFilters);
    return;
  }
  let rows = filtered;
  if (state.nearMe && state.me) {
    rows = filtered.map((c) => ({ c, d: isReasonableCoord(c.lat, c.lng) ? distanceMiles(state.me, c) : Infinity }))
      .sort((a, b) => a.d - b.d).map((x) => x.c);
  }
  const frag = document.createDocumentFragment();
  for (const c of rows) {
    const li = document.createElement('li');
    li.dataset.id = c.id;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    if (c.id === state.selectedId) li.classList.add('active');
    li.innerHTML = `
      <div class="pin sm-pin ${recencyBucket(c.last_visit_date)}"></div>
      <div class="info">
        <div class="name">${escapeHtml(c.company || '(no name)')}</div>
        <div class="sub">${escapeHtml(c.contact_name || '')} · ${escapeHtml(c.city || '')}</div>
        <div class="meta">${metaLine(c)}</div>
      </div>`;
    frag.appendChild(li);
  }
  ul.replaceChildren(frag);
  renderChips();
}
function metaLine(c) {
  const parts = [];
  if (state.nearMe && state.me && isReasonableCoord(c.lat, c.lng)) parts.push(`<span class="distance">${distanceMiles(state.me, c).toFixed(1)} mi</span>`);
  if (c.zone_name) parts.push(escapeHtml(c.zone_name));
  parts.push(c.last_visit_date ? `Last visit ${escapeHtml(c.last_visit_date)}` : 'Never visited');
  return parts.join(' · ');
}
// One click/keyboard handler for the whole list (rows carry data-id)
function pickRow(li) {
  selectCustomer(Number(li.dataset.id), true);
}
document.getElementById('customerList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) pickRow(li);
});
document.getElementById('customerList').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  e.preventDefault();
  pickRow(li);
});
function clearFilters() {
  state.filters = { ...state.filters, q: '', zoneId: '', salesperson: '', recency: '', visitor: '', viewport: false };
  document.getElementById('search').value = '';
  for (const id of ['filterZone', 'filterSalesperson', 'filterRecency', 'filterVisitor']) document.getElementById(id).value = '';
  document.getElementById('filterViewport').checked = false;
  renderList(); renderMarkers();
}
function setSelectedRow(prevId, id) {
  const ul = document.getElementById('customerList');
  if (prevId != null) ul.querySelector(`li[data-id="${prevId}"]`)?.classList.remove('active');
  if (id != null) ul.querySelector(`li[data-id="${id}"]`)?.classList.add('active');
}

// ============== SELECT / DETAIL ==============
async function selectCustomer(id, panTo) {
  const prev = state.selectedId;
  state.selectedId = id;
  setSelectedRow(prev, id); setSelectedPin(prev, id);
  const c = state.customers.find((x) => x.id === id);
  if (!c) return;
  await renderDetail(c);
  document.getElementById('app').classList.add('with-detail');
  document.getElementById('detail').classList.remove('hidden');
  if (isPhone()) {
    setSheet(document.getElementById('sidebar'), 'peek');
    setSheet(document.getElementById('detail'), 'half');
    document.getElementById('detailBody').scrollTop = 0;
  }
  // On the phone a tapped pin can sit behind the card, so pan for map taps too
  if ((panTo || isPhone()) && state.map && isReasonableCoord(c.lat, c.lng)) {
    flyToVisible([c.lng, c.lat], Math.max(state.map.getZoom(), panTo ? 11 : state.map.getZoom()));
  }
}

function closeDetail() {
  const prev = state.selectedId;
  state.selectedId = null;
  document.getElementById('app').classList.remove('with-detail');
  document.getElementById('detail').classList.add('hidden');
  setSelectedRow(prev, null); setSelectedPin(prev, null);
}

async function renderDetail(c) {
  const { data: visits } = await sb
    .from('visits').select('*')
    .eq('customer_id', c.id)
    .order('visit_date', { ascending: false });
  const body = document.getElementById('detailBody');
  // Only filled-in fields get a row; geocode quality is internal and stays off the panel
  const row = (label, html) => html ? `<div class="label">${label}</div><div>${html}</div>` : '';
  const tel = (v) => v ? `<a href="tel:${escapeAttr(v)}">${escapeHtml(v)}</a>` : '';
  const addr = [escapeHtml(c.address || ''), escapeHtml([c.city, c.state, c.post_code].filter(Boolean).join(', '))].filter(Boolean).join('<br/>');
  const fields = [
    row('Job title', escapeHtml(c.job_title || '')),
    row('Address', addr),
    row('Phone', tel(c.phone)),
    row('Mobile', tel(c.mobile)),
    row('Email', c.email ? `<a href="mailto:${escapeAttr(c.email)}">${escapeHtml(c.email)}</a>` : ''),
    row('Salesperson', escapeHtml(c.salesperson_code || '')),
    row('Territory', escapeHtml(c.territory_code || '')),
    row('Customer #', escapeHtml(c.customer_no || '')),
  ].join('');
  const n = (visits || []).length;
  const phone = c.phone || c.mobile;
  const nav = navigateUrl(c);
  const action = (href, icon, label) => `<a href="${href ? escapeAttr(href) : '#'}" ${href ? 'target="_blank" rel="noopener"' : 'aria-disabled="true"'}><svg class="icon" aria-hidden="true"><use href="#i-${icon}"/></svg>${label}</a>`;
  const dist = state.me && isReasonableCoord(c.lat, c.lng) ? `<span class="distance">${distanceMiles(state.me, c).toFixed(1)} mi away</span>` : '';
  body.innerHTML = `
    <h2 class="detail-title">${escapeHtml(c.company || '(no name)')}</h2>
    <div class="detail-sub">${escapeHtml(c.contact_name || '')}${dist ? (c.contact_name ? ' · ' : '') + dist : ''}</div>
    ${c.zone_name ? `<div class="detail-zone-pill" style="${c.zone_color ? `--zone:${escapeAttr(c.zone_color)}` : ''}">${escapeHtml(c.zone_name)}</div>` : ''}
    <div class="quick-actions">
      ${action(phone ? `tel:${phone}` : null, 'phone', 'Call')}
      ${action(nav, 'navigate', 'Navigate')}
      ${action(c.email ? `mailto:${c.email}` : null, 'mail', 'Email')}
    </div>

    <div class="detail-section">
      <h3>Contact</h3>
      ${fields ? `<div class="field-grid">${fields}</div>` : '<div class="empty-state inline">No contact details yet. Use Edit to add some.</div>'}
    </div>

    <div class="detail-section">
      <h3>Visit history (${n})</h3>
      <div id="visitList">
        ${n === 0 ? '<div class="empty-state inline">No visits logged yet. Log the first one below.</div>' : ''}
        ${(visits || []).map(renderVisit).join('')}
      </div>
    </div>
  `;
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
      <button class="visit-delete icon-btn" id="del-visit-${v.id}" title="Delete visit" aria-label="Delete visit"><svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg></button>
      <div class="visit-head">
        <div class="visit-date">${escapeHtml(v.visit_date)}</div>
        ${v.outcome ? `<div class="visit-outcome">${escapeHtml(v.outcome)}</div>` : ''}
      </div>
      <div class="visit-by">by ${escapeHtml(byLabel)}</div>
      ${v.notes ? `<div class="visit-notes">${escapeHtml(v.notes)}</div>` : ''}
    </div>`;
}

async function deleteCustomer(c) {
  const ok = await confirmDialog({ title: `Delete ${c.company || 'this customer'}?`, message: 'The visit history goes with it. This cannot be undone.', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  const { error } = await sb.from('customers').delete().eq('id', c.id);
  if (error) { showToast(`Delete failed: ${error.message}`, 5000); return; }
  closeDetail(); await refreshAll();
  showToast('Customer deleted', 2000);
}

async function deleteVisit(customerId, visitId) {
  const ok = await confirmDialog({ title: 'Remove this visit?', message: 'It leaves the history for good.', confirmLabel: 'Remove', danger: true });
  if (!ok) return;
  const { error } = await sb.from('visits').delete().eq('id', visitId);
  if (error) { showToast(`Delete failed: ${error.message}`, 5000); return; }
  await refreshAll();
  const c = state.customers.find((x) => x.id === customerId);
  if (c) await renderDetail(c);
}

// ============== VISIT FORM ==============
function openVisitForm(customerId) {
  const today = ymdLocal(new Date());
  openModal('Log visit', `
    <div class="form-row"><label for="vDate">Date</label><input type="date" id="vDate" value="${today}" /></div>
    <div class="form-row">
      <span class="form-label">Outcome</span>
      <div id="vOutcome">
        ${outcomeChips()}
      </div>
    </div>
    <div class="form-row"><label for="vNotes">Notes</label><textarea id="vNotes" placeholder="What was discussed?"></textarea></div>
  `, async () => {
    const { error } = await sb.from('visits').insert({
      customer_id: customerId,
      visitor_id: state.user.id,
      visit_date: document.getElementById('vDate').value,
      outcome: (document.querySelector('input[name="vOutcome"]:checked') || {}).value || null,
      notes: document.getElementById('vNotes').value || null,
    });
    if (error) { showToast(`Save failed: ${error.message}`, 5000); return; }
    closeModal();
    await refreshAll();
    const c = state.customers.find((x) => x.id === customerId);
    if (c) await renderDetail(c);
    showToast(`Visit logged for ${c ? c.company : 'customer'}`, 3000);
  });
}

// ============== CUSTOMER FORM ==============
function openCustomerForm(existing) {
  const c = existing || {};
  openModal(existing ? 'Edit customer' : 'New customer', `
    <div class="form-row"><label for="fCompany">Company</label><input id="fCompany" value="${escapeAttr(c.company)}" /></div>
    <div class="form-grid">
      <div class="form-row"><label for="fContact">Contact name</label><input id="fContact" value="${escapeAttr(c.contact_name)}" /></div>
      <div class="form-row"><label for="fJobTitle">Job title</label><input id="fJobTitle" value="${escapeAttr(c.job_title)}" /></div>
    </div>
    <div class="form-row"><label for="fAddress">Address</label><input id="fAddress" value="${escapeAttr(c.address)}" /></div>
    <div class="form-grid">
      <div class="form-row"><label for="fCity">City</label><input id="fCity" value="${escapeAttr(c.city)}" /></div>
      <div class="form-row"><label for="fState">State</label><input id="fState" value="${escapeAttr(c.state)}" /></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label for="fPost">Post code</label><input id="fPost" value="${escapeAttr(c.post_code)}" /></div>
      <div class="form-row"><label for="fPhone">Phone</label><input id="fPhone" value="${escapeAttr(c.phone)}" /></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label for="fMobile">Mobile</label><input id="fMobile" value="${escapeAttr(c.mobile)}" /></div>
      <div class="form-row"><label for="fEmail">Email</label><input id="fEmail" value="${escapeAttr(c.email)}" /></div>
    </div>
    <div class="form-grid">
      <div class="form-row"><label for="fSalesperson">Salesperson code</label><input id="fSalesperson" value="${escapeAttr(c.salesperson_code)}" /></div>
      <div class="form-row"><label for="fTerritory">Territory code</label><input id="fTerritory" value="${escapeAttr(c.territory_code)}" /></div>
    </div>
    <div class="form-row hint">
      Address will be geocoded and a zone assigned automatically when you save.
    </div>
  `, async () => {
    if (!getVal('fCompany')) { showToast('Company is required.', 3000); document.getElementById('fCompany').focus(); return; }
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
          if (state.zones.length) await ensureLib('turf');
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
  const filteredNow = applyFilters(state.customers);
  const bulkCount = filtersActive() && filteredNow.length < state.customers.length ? filteredNow.length : 0;
  openModal(firstRun ? 'Welcome to SalesMap' : 'Settings', `
    ${firstRun ? '<p class="hint-top">Paste your TomTom API key to enable the map and geocoding.</p>' : ''}
    <div class="form-row">
      <label for="sName">Display name</label>
      <input id="sName" value="${escapeAttr(state.profile?.display_name || '')}" />
    </div>
    <div class="form-row">
      <label for="sCode">My salesperson code</label>
      <input id="sCode" value="${escapeAttr(state.profile?.salesperson_code || '')}" placeholder="e.g. NHOU.007" />
    </div>
    <div class="form-row">
      <label for="sKey">TomTom API key</label>
      <input id="sKey" type="password" autocomplete="off" value="${escapeAttr(state.tomtomKey || '')}" placeholder="Your TomTom API key" />
    </div>
    <div class="hint">Get a free key at developer.tomtom.com — Maps + Search products.</div>

    <div class="form-row mt-4">
      <label for="sTheme">Theme</label>
      <select id="sTheme">
        <option value="dark">Dark</option>
        <option value="light">Light</option>
        <option value="auto">Match system</option>
      </select>
    </div>

    <div class="detail-section">
      <h3>Import data</h3>
      <div class="btn-row">
        <button class="btn" id="sImportCustomers">Import customers (Excel)</button>
        <button class="btn" id="sImportVisits">Import visit history (Excel)</button>
        <button class="btn" id="sImportZones">Load zones (KML)</button>
      </div>
    </div>

    <div class="detail-section">
      <h3>Account</h3>
      <button class="btn" id="sChangePassword">Change password</button>
    </div>

    ${firstRun ? '' : `
    <div class="detail-section section-divider">
      <h3 class="danger-title">Danger zone</h3>
      ${bulkCount > 0 ? `
      <div class="hint mb-2">Deletes the ${bulkCount} customer${bulkCount === 1 ? '' : 's'} matching the current list filters, with their visit history.</div>
      <button class="btn btn-danger mb-4" id="sDeleteFiltered">Delete the ${bulkCount} filtered customer${bulkCount === 1 ? '' : 's'}</button>` : ''}
      <div class="hint mb-2">Removes all customers and visit history. Zones stay.</div>
      <button class="btn btn-danger" id="sClearAll">Clear all customers and visits</button>
    </div>`}
  `, async () => {
    const key = getVal('sKey') || '';
    const name = getVal('sName');
    const code = getVal('sCode');
    const theme = document.getElementById('sTheme').value || DEFAULT_THEME;
    const keyChanged = key !== (state.tomtomKey || '');
    localStorage.setItem('tomtom_api_key', key);
    localStorage.setItem('theme', theme);
    applyTheme(theme);
    state.tomtomKey = key;
    await sb.from('profiles').update({ display_name: name || state.profile.display_name, salesperson_code: code }).eq('id', state.user.id);
    const { data: prof } = await sb.from('profiles').select('*').eq('id', state.user.id).single();
    state.profile = prof;
    state.myCode = (prof && prof.salesperson_code) || null;
    closeModal();
    renderList();
    if (keyChanged) {
      showToast('Saved. Reloading the map…', 1200);
      setTimeout(() => location.reload(), 800);
    } else {
      showToast('Saved', 1500);
    }
  });

  // Pre-select current theme
  const themeSel = document.getElementById('sTheme');
  if (themeSel) themeSel.value = localStorage.getItem('theme') || DEFAULT_THEME;

  document.getElementById('sImportCustomers').addEventListener('click', () => { closeModal(); importCustomersFlow(); });
  document.getElementById('sImportVisits').addEventListener('click', () => { closeModal(); importVisitsFlow(); });
  document.getElementById('sImportZones').addEventListener('click', () => { closeModal(); importZonesFlow(); });
  document.getElementById('sChangePassword').addEventListener('click', () => { closeModal(); showSetPassword('change'); });

  const bulkBtn = document.getElementById('sDeleteFiltered');
  if (bulkBtn) bulkBtn.addEventListener('click', async () => { closeModal(); await deleteFiltered(); });

  const clearBtn = document.getElementById('sClearAll');
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    closeModal();
    const ok = await confirmDialog({ title: 'Delete all customers and visits?', message: 'Everything except zones is removed from the shared map, for every rep. This cannot be undone.', confirmLabel: 'Delete everything', danger: true, typed: 'DELETE' });
    if (!ok) return;
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
// YYYY-MM-DD in the browser's local time zone (toISOString would give the UTC date,
// which is tomorrow after 6 pm Central)
function ymdLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function parseDateFlexible(v) {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date && !isNaN(v.getTime())) return ymdLocal(v);
  if (typeof v === 'number') {
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(epoch.getTime() + v * 86400000);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return null;
  }
  const d = new Date(String(v).trim());
  if (!isNaN(d.getTime())) return ymdLocal(d);
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
    // Safari won't fire change on an input that isn't in the document
    input.style.display = 'none';
    document.body.appendChild(input);
    const finish = (file) => { input.remove(); resolve(file); };
    input.addEventListener('change', () => finish(input.files[0] || null));
    input.addEventListener('cancel', () => finish(null));
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
    ? `<span class="text-success">All ${headers.length} columns auto-matched ✓</span> · ${rowCount} rows`
    : `<span class="text-warning">${unmatched} of ${headers.length} columns need mapping</span> · ${rowCount} rows`;
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
    <div class="mb-3">${summary}</div>
    <div class="hint mb-3">
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
  await ensureLib('xlsx');
  if (state.zones.length) await ensureLib('turf');
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
  let imported = 0, geocoded = 0, reused = 0, failed = 0, skipped = 0, saveFailed = 0;
  const geocodeCache = new Map();

  // Pre-fetch existing customers for change-detection (paginated past the 1000-row cap)
  const existingAll = await fetchAll(() => sb.from('customers').select('id, customer_no, company, contact_name, address, city, state, post_code, lat, lng'));
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
      const { error: updErr } = await sb.from('customers').update(upd).eq('id', existing.id);
      if (updErr) { saveFailed++; continue; }
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
      const { error: updErr } = await sb.from('customers').update(data).eq('id', existing.id);
      if (updErr) { saveFailed++; continue; }
    } else {
      data.created_by = state.user.id;
      const { data: ins, error: insErr } = await sb.from('customers').insert(data).select('id').single();
      if (insErr) { saveFailed++; continue; }
      if (ins && data.customer_no) byNo.set(data.customer_no, { ...data, id: ins.id });
    }
    imported++;
  }
  showToast(`Imported ${imported} (${geocoded} geocoded, ${reused} unchanged, ${failed} failed, ${skipped} blocked${saveFailed ? `, ${saveFailed} NOT SAVED` : ''})`, saveFailed ? 0 : 7000);
  await refreshAll();
  fitMapToCustomers();
}

async function importVisitsFlow() {
  await ensureLib('xlsx');
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
  // Pre-fetch customers for matching (paginated past the 1000-row cap)
  const customers = await fetchAll(() => sb.from('customers').select('id, customer_no, company, contact_name'));
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
  await Promise.all([ensureLib('togeojson'), ensureLib('turf')]);
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
let modalPrevFocus = null;
function openModal(title, bodyHtml, onSave, opts = {}) {
  const root = document.getElementById('modalRoot');
  modalPrevFocus = document.activeElement;
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <div class="modal-header">
          <h2 id="modalTitle">${escapeHtml(title)}</h2>
          <button class="close icon-btn" id="modalClose" title="Close" aria-label="Close"><svg class="icon" aria-hidden="true"><use href="#i-x"/></svg></button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-footer">
          <button class="btn" id="modalCancel">Cancel</button>
          <button class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" id="modalSave">${escapeHtml(opts.saveLabel || 'Save')}</button>
        </div>
      </div>
    </div>`;
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('modalCancel').addEventListener('click', closeModal);
  const saveBtn = document.getElementById('modalSave');
  saveBtn.addEventListener('click', async (e) => {
    if (saveBtn.disabled) return;
    const label = saveBtn.textContent;
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try { await onSave(e); }
    finally { if (saveBtn.isConnected) { saveBtn.disabled = false; saveBtn.textContent = label; } }
  });
  root.querySelector('.modal-overlay').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) closeModal(); });
  const first = root.querySelector('.modal-body input:not([type=hidden]), .modal-body select, .modal-body textarea, .modal-body button')
    || document.getElementById('modalClose');
  first.focus();
}
function closeModal() {
  document.getElementById('modalRoot').innerHTML = '';
  if (modalPrevFocus && typeof modalPrevFocus.focus === 'function') modalPrevFocus.focus();
  modalPrevFocus = null;
}
function modalFocusables() {
  const modal = document.querySelector('#modalRoot .modal');
  if (!modal) return [];
  return [...modal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled])')]
    .filter((el) => el.offsetParent !== null);
}
// Esc closes the open modal, else the detail panel. Tab stays inside an open modal.
document.addEventListener('keydown', (e) => {
  const modalOpen = !!document.querySelector('#modalRoot .modal');
  if (e.key === 'Escape') {
    if (modalOpen) { e.preventDefault(); closeModal(); }
    else if (!document.getElementById('detail').classList.contains('hidden')) { e.preventDefault(); closeDetail(); }
    return;
  }
  if (e.key === 'Tab' && modalOpen) {
    const items = modalFocusables();
    if (items.length === 0) return;
    const firstEl = items[0], lastEl = items[items.length - 1];
    if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
  }
});

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
// ============== PHONE SHEETS, CHIPS, NEAR ME ==============
function isPhone() { return window.matchMedia('(max-width: 900px)').matches; }
function setSheet(el, st) { el.dataset.sheet = st; el.style.height = ''; }
const SHEET_ORDER = ['peek', 'half', 'full'];
// Phone sheets follow the finger. A drag can start anywhere on the sheet: on the
// handle and the top block it always moves the sheet; inside the scrolling list
// or card it moves the sheet only when that content is scrolled to the top (drag
// down) or the sheet can still grow (drag up). A flick snaps one step in its
// direction; a slow drag snaps to the nearest height. Flicking the card down
// from its lowest height closes it.
function sheetRestHeights(el) {
  const vh = window.innerHeight;
  const peek = el.id === 'detail' ? 150 : 172;
  return { peek, half: vh * (el.id === 'detail' ? 0.62 : 0.56), full: vh - 8 };
}
function sheetDrag(handle, el) {
  if (!handle) return;
  let g = null; // current gesture
  let swallowClick = false;
  const scrollerOf = (t) => t.closest('#customerList, #detailBody');
  const start = (y, target) => {
    if (!isPhone()) return;
    if (target.closest('input, select, textarea')) return; // let fields focus normally
    g = { y0: y, h0: el.getBoundingClientRect().height, scroller: scrollerOf(target), mode: 'pending', samples: [[y, performance.now()]] };
  };
  const move = (y, e) => {
    if (!g) return;
    const dy = g.y0 - y; // + = finger moved up
    if (g.mode === 'pending') {
      if (Math.abs(dy) < 8) return;
      if (g.scroller) {
        const atTop = g.scroller.scrollTop <= 0;
        const canGrow = el.dataset.sheet !== 'full';
        if (!((dy < 0 && atTop) || (dy > 0 && canGrow))) { g.mode = 'scroll'; return; }
      }
      g.mode = 'drag';
      el.classList.add('dragging');
    }
    if (g.mode !== 'drag') return;
    if (e && e.cancelable) e.preventDefault();
    const h = Math.max(60, Math.min(window.innerHeight - 8, g.h0 + dy));
    el.style.height = h + 'px';
    g.samples.push([y, performance.now()]);
    if (g.samples.length > 6) g.samples.shift();
  };
  const end = (y) => {
    if (!g) return;
    const gesture = g; g = null;
    if (gesture.mode !== 'drag') return;
    el.classList.remove('dragging');
    swallowClick = true; setTimeout(() => { swallowClick = false; }, 350);
    const [y1, t1] = gesture.samples[0];
    const v = (y1 - y) / Math.max(1, performance.now() - t1); // px/ms, + = upward
    const rest = sheetRestHeights(el);
    const order = ['peek', 'half', 'full'];
    const h = el.getBoundingClientRect().height;
    let target;
    if (Math.abs(v) > 0.35) {
      const nearestStart = order.reduce((a, b) => Math.abs(rest[b] - gesture.h0) < Math.abs(rest[a] - gesture.h0) ? b : a);
      const i = order.indexOf(nearestStart) + (v > 0 ? 1 : -1);
      if (i < 0) {
        if (el.id === 'detail') { el.style.height = ''; closeDetail(); return; }
        target = 'peek';
      } else target = order[Math.min(i, 2)];
    } else {
      if (el.id === 'detail' && h < rest.peek * 0.6) { el.style.height = ''; closeDetail(); return; }
      target = order.reduce((a, b) => Math.abs(rest[b] - h) < Math.abs(rest[a] - h) ? b : a);
    }
    setSheet(el, target);
  };
  // Touch: needs a non-passive move listener so a sheet drag can stop the page from scrolling
  el.addEventListener('touchstart', (e) => { if (e.touches.length === 1) start(e.touches[0].clientY, e.target); }, { passive: true });
  el.addEventListener('touchmove', (e) => { if (e.touches.length === 1) move(e.touches[0].clientY, e); }, { passive: false });
  el.addEventListener('touchend', (e) => end(e.changedTouches[0].clientY));
  el.addEventListener('touchcancel', () => { if (g && g.mode === 'drag') { el.classList.remove('dragging'); setSheet(el, el.dataset.sheet); } g = null; });
  // Mouse (desktop browser at phone width): drag from the handle only
  handle.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    start(e.clientY, handle); handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') move(e.clientY, null); });
  let mouseUp = false;
  handle.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'mouse') return;
    const wasDrag = g && g.mode === 'drag';
    end(e.clientY);
    if (!wasDrag) cycleSheet(el);
    mouseUp = true; setTimeout(() => { mouseUp = false; }, 0);
  });
  // A tap on the handle (touch) steps the sheet; a click right after a drag is swallowed
  handle.addEventListener('click', (e) => { if (mouseUp || e.detail === 0) return; if (!swallowClick) cycleSheet(el); });
  el.addEventListener('click', (e) => { if (swallowClick) { e.stopPropagation(); e.preventDefault(); } }, true);
  handle.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cycleSheet(el); } });
}
function cycleSheet(el) {
  const i = SHEET_ORDER.indexOf(el.dataset.sheet || 'peek');
  setSheet(el, SHEET_ORDER[(i + 1) % SHEET_ORDER.length]);
}

const CHIPS = [
  { id: 'near', label: 'Near me', icon: 'locate' },
  { id: 'mine', label: 'My customers' },
  { id: 'never', label: 'Never visited' },
  { id: 'stale', label: '90+ days' },
  { id: 'more', label: 'Filters', icon: 'settings' },
];
function chipOn(id) {
  const f = state.filters;
  if (id === 'mine') return !!state.myCode && f.salesperson === state.myCode;
  if (id === 'never') return f.recency === 'never';
  if (id === 'stale') return f.recency === '90';
  if (id === 'near') return state.nearMe;
  if (id === 'more') return !document.getElementById('filtersAdvanced').classList.contains('hidden');
  return false;
}
function renderChips() {
  const el = document.getElementById('chips');
  if (!el) return;
  el.innerHTML = CHIPS.filter((c) => c.id !== 'mine' || state.myCode).map((c) => {
    const on = chipOn(c.id);
    const busy = c.id === 'near' && state._locating;
    return `<button type="button" class="chip${on ? ' on' : ''}${busy ? ' busy' : ''}" data-chip="${c.id}" aria-pressed="${on}">` +
      (c.icon ? `<svg class="icon" aria-hidden="true"><use href="#i-${c.icon}"/></svg>` : '') +
      (busy ? 'Locating…' : c.label) + '</button>';
  }).join('');
}
function onChip(id) {
  const f = state.filters;
  if (id === 'mine') {
    f.salesperson = chipOn('mine') ? '' : state.myCode;
    document.getElementById('filterSalesperson').value = f.salesperson;
  } else if (id === 'never' || id === 'stale') {
    const val = id === 'never' ? 'never' : '90';
    f.recency = f.recency === val ? '' : val;
    document.getElementById('filterRecency').value = f.recency;
  } else if (id === 'near') {
    toggleNearMe(); return;
  } else if (id === 'more') {
    document.getElementById('filtersAdvanced').classList.toggle('hidden');
    renderChips(); return;
  }
  renderList(); renderMarkers();
}

function distanceMiles(a, b) {
  const R = 3958.8, toR = (x) => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function toggleNearMe() {
  if (state.nearMe) { state.nearMe = false; renderList(); return; }
  if (!navigator.geolocation) { showToast('Location is not available on this device.', 3000); return; }
  state._locating = true; renderChips();
  navigator.geolocation.getCurrentPosition((pos) => {
    state.me = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    state.nearMe = true; state._locating = false;
    renderList(); showMeMarker();
    if (state.map) flyToVisible([state.me.lng, state.me.lat], Math.max(state.map.getZoom(), 10.5));
  }, (err) => {
    state._locating = false; renderChips();
    showToast(err && err.code === 1
      ? 'Location permission was denied. Allow it for this site to use Near me.'
      : 'Could not get your location. Try again outdoors.', 4000);
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}
function showMeMarker() {
  if (!state.map || !state.me) return;
  const ll = [state.me.lng, state.me.lat];
  if (state.meMarker) { state.meMarker.setLngLat(ll); return; }
  const el = document.createElement('div');
  el.className = 'me-pin'; el.title = 'You are here';
  state.meMarker = new tt.Marker({ element: el }).setLngLat(ll).addTo(state.map);
}
// Opens the phone's own maps app; Google Maps on a desktop
function navigateUrl(c) {
  const hasPt = isReasonableCoord(c.lat, c.lng);
  const addr = [c.address, c.city, c.state, c.post_code].filter(Boolean).join(', ');
  if (!hasPt && !addr) return null;
  const dest = hasPt ? `${c.lat},${c.lng}` : encodeURIComponent(addr);
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return `https://maps.apple.com/?daddr=${dest}`;
  if (/Android/.test(ua)) return hasPt ? `geo:${dest}?q=${dest}` : `geo:0,0?q=${dest}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}`;
}

const OUTCOME_GROUPS = [
  ['Contact', ['Routine check in', 'Met with decision-maker', 'Met with gatekeeper', 'Decision-maker not in', 'Dropped off card / literature']],
  ['Progress', ['Scheduled follow-up appointment', 'Quote requested', 'Demo scheduled', 'Training', 'Delivery', 'Closed sale']],
  ['Outcome', ['Not interested', 'Business closed / moved']],
];
function outcomeChips() {
  const chip = (value, label, checked) =>
    `<label><input type="radio" name="vOutcome" value="${escapeAttr(value)}"${checked ? ' checked' : ''} /><span class="chip">${escapeHtml(label)}</span></label>`;
  return `<div class="outcome-chips">${chip('', 'Not recorded', true)}</div>` +
    OUTCOME_GROUPS.map(([g, items]) => `<div class="outcome-group"><div class="outcome-group-label">${g}</div><div class="outcome-chips">${items.map((o) => chip(o, o, false)).join('')}</div></div>`).join('');
}

// Themed yes/no dialog. Resolves true on confirm, false on cancel, close or Esc.
function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, typed = null }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const typedRow = typed
      ? `<div class="form-row"><label for="confirmTyped">Type <strong>${escapeHtml(typed)}</strong> to confirm</label><input id="confirmTyped" autocomplete="off" autocapitalize="off" /></div>`
      : '';
    openModal(title, `<div class="confirm-body">${escapeHtml(message)}${typedRow}</div>`, async () => {
      if (typed && (getVal('confirmTyped') || '') !== typed) { showToast('That did not match.', 2500); return; }
      finish(true); closeModal();
    }, { saveLabel: confirmLabel, danger });
    const root = document.getElementById('modalRoot');
    const obs = new MutationObserver(() => { if (!root.querySelector('.modal')) { obs.disconnect(); finish(false); } });
    obs.observe(root, { childList: true });
  });
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function getVal(id) { return document.getElementById(id).value.trim() || null; }
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s || ''); }
