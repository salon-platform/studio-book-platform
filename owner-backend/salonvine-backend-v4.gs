/* ============================================================
   SalonVine — Live Data backend v4 (Google Apps Script)

   v4 = v3 + full owner edit/delete for the owner portal.
   EVERY v1/v2/v3 handler keeps working unchanged.

   New in v4 (ALL full-token only, all audited to _AuditLog):
     - {type:'salonDelete', ref}
                   ref matches the salonId column OR the slug
                   column (wizard rows key on slug, the two older
                   rows — studio17 / demo-iron-oak — key on
                   salonId). Refuses on 0 or >1 matches. Deletes
                   the Salons sheet row. Returns
                   {ok, deleted:{salonId,slug,name}}.
     - {type:'salonEdit', ref, fields:{...}}
                   Same ref resolution. Updates only provided
                   whitelisted columns (name/tagline/theme/accent/
                   status/plan/url; theme validated against the 6
                   known themes) plus fields.hours / .instagram /
                   .services which merge into the config JSON blob
                   with the same sanitizers as salonConfig.
                   Returns {ok, salon:{...updated record...}}.
     - {type:'signupDelete', id}
                   Deletes the Signups row by id.
                   Returns {ok, deleted:{id,salon}}.
     - {type:'leadDelete', ts, slug}
                   Deletes the SiteLeads row where
                   String(ts)===String(row.ts) && slug matches
                   (SiteLeads has no id column; the ISO ts is
                   unique enough). Refuses on 0 or >1 matches.
     - {type:'revenueSet', ym, fields:{revenue?,studio?,pro?,
                   elite?,trials?,conversions?,churn?}}
                   Upserts the Revenue row keyed by ym
                   (YYYY-MM validated, numeric coercion).
     - {type:'revenueDelete', ym}
     - _AuditLog tab: every v4 handler appends
                   [ts, actor, type, ref, fields-json(<=500ch)].
                   Audit failure NEVER breaks the action.

   setup() stays migration-safe (now also adds the _AuditLog tab
   if missing). doGet is unchanged. Nothing was removed.

   ------------------------------------------------------------
   v3 added services / hours / Instagram to instant sites, the
   SiteLeads feed for the owner portal, and a full-token config
   patch handler. EVERY v1/v2 handler keeps working unchanged:
     - {type:'signup'}        signup token OR full token
     - {type:'signupStatus'}  full token only
     - {type:'salon'}         full token only
     - doGet?token=SV_TOKEN   full data read

   New in v3:
     - {type:'signupSite'}    now also accepts services:[{name,price}],
                              hours (short text) and instagram (handle) —
                              stored inside the Salons.config JSON blob.
     - doGet?site=<slug>      public payload now also includes
                              services / hours / instagram (still no
                              email, phone, plan or status).
     - doGet?token=SV_TOKEN   response gains siteLeads: [...] (the
                              SiteLeads tab) for the portal Bookings view.
     - {type:'salonConfig'}   FULL token only. {slug, patch:{...}} —
                              shallow-merges whitelisted-sanitized keys
                              into that salon's config JSON (owner-portal
                              editing, future site editor).

   From v2 (unchanged):
     - {type:'signupSite'}    signup token ok — signup row + owner
                              email + creates a live Salons row with
                              a unique slug. Returns {ok,id,slug,url}.
     - {type:'sitePhoto'}     signup token ok — saves a base64 JPEG
                              to Drive "SalonVine Sites/<slug>/",
                              shares anyone-with-link, appends the
                              lh3.googleusercontent URL to the
                              salon's photos JSON. Cap 8/salon.
     - {type:'siteLead'}      signup token ok — booking request from
                              a live salon site. Stored in SiteLeads
                              tab + emailed to the salon owner AND
                              the SalonVine owners.
     - doGet?site=<slug>      NO token — public site config only
                              ({slug,name,tagline,theme,accent,photos})
                              for status 'live-free'/'live' salons.

   Install/upgrade: open the "SalonVine — Live Data" Sheet ->
   Extensions -> Apps Script -> replace the file with this one ->
   run setup() once (migration-safe: appends missing headers /
   missing tabs, never wipes) -> Deploy -> Manage deployments ->
   edit the EXISTING web-app deployment -> New version. The /exec
   URL stays the same.

   Script Properties (unchanged):
     SV_TOKEN        — full read/write token
     SV_SIGNUP_TOKEN — light public token for the marketing site
   ============================================================ */

/* ---------- Owner notification list ---------- */
var OWNER_NOTIFY = ['zackbrockway17@gmail.com', 'halleroffroadllc@gmail.com'];

var PUBLIC_SITE_BASE = 'https://salonvine.com/s/';
var DRIVE_ROOT_FOLDER = 'SalonVine Sites';
var MAX_PHOTOS_PER_SALON = 8;
/* ~6MB of binary is ~8.4M base64 chars (incl. dataURL header slack) */
var MAX_PHOTO_POST_CHARS = 8600000;

var TABS = {
  SIGNUPS: 'Signups',
  REVENUE: 'Revenue',
  SALONS: 'Salons',
  SITELEADS: 'SiteLeads',
  AUDIT: '_AuditLog'          /* v4 */
};

var HEADERS = {
  Signups: ['id', 'ts', 'salon', 'name', 'email', 'phone', 'website', 'plan', 'status', 'salonId', 'actor'],
  Revenue: ['ym', 'revenue', 'studio', 'pro', 'elite', 'trials', 'conversions', 'churn'],
  /* v2: new columns are APPENDED after the v1 columns so existing
     live sheets migrate by adding columns on the right. */
  Salons:  ['salonId', 'name', 'url', 'plan', 'status', 'slug', 'theme', 'accent', 'tagline', 'photos', 'config', 'createdAt'],
  SiteLeads: ['ts', 'slug', 'name', 'phone', 'email', 'message'],
  /* v4: audit trail — setup() creates it via the same
     migration-safe loop (adds the tab if missing, never wipes). */
  '_AuditLog': ['ts', 'actor', 'type', 'ref', 'fields']
};

/* v4: the 6 known site themes (mirror of the wizard/renderer) */
var THEMES = ['classic-cream', 'midnight', 'rose-gold', 'sage-spa', 'bold-noir', 'ocean'];

/* v4: whitelisted Salons columns the portal may edit directly */
var SALON_EDIT_COLS = ['name', 'tagline', 'theme', 'accent', 'status', 'plan', 'url'];

/* v4: whitelisted Revenue fields */
var REV_FIELDS = ['revenue', 'studio', 'pro', 'elite', 'trials', 'conversions', 'churn'];

/* ============================================================
   Setup — run once. Migration-safe:
     - creates any missing tab
     - writes full headers on an empty tab
     - APPENDS any missing header columns on an existing tab
     - never clears or overwrites data
   ============================================================ */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(HEADERS).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); }
    var want = HEADERS[name];
    var lastCol = Math.max(sh.getLastColumn(), 1);
    var firstRow = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    var hasHeaders = firstRow.some(function (c) { return c !== ''; });
    if (!hasHeaders) {
      sh.getRange(1, 1, 1, want.length).setValues([want]);
      sh.setFrozenRows(1);
      return;
    }
    /* append any headers that don't exist yet */
    var missing = want.filter(function (h) { return firstRow.indexOf(h) === -1; });
    if (missing.length) {
      var start = firstRow.filter(function (c) { return c !== ''; }).length + 1;
      sh.getRange(1, start, 1, missing.length).setValues([missing]);
    }
    if (sh.getFrozenRows() < 1) { sh.setFrozenRows(1); }
  });
}

/* ============================================================
   Token helpers
   ============================================================ */
function props_() { return PropertiesService.getScriptProperties(); }
function fullToken_() { return props_().getProperty('SV_TOKEN') || ''; }
function signupToken_() { return props_().getProperty('SV_SIGNUP_TOKEN') || ''; }

function isFullToken_(t) { return !!t && !!fullToken_() && t === fullToken_(); }
function isSignupToken_(t) { return !!t && !!signupToken_() && t === signupToken_(); }
function isPublicWriteToken_(t) { return isSignupToken_(t) || isFullToken_(t); }

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
   Sheet helpers
   ============================================================ */
function sheet_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) { throw new Error('Missing tab: ' + name + ' — run setup()'); }
  return sh;
}

/* Map header name -> 1-based column, from the ACTUAL sheet header
   row (never assume column order — sheets may pre-date v2). */
function headerCols_(sh) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  var map = {};
  head.forEach(function (h, i) { if (h !== '') { map[h] = i + 1; } });
  return map;
}

/* Append a row by header name (missing headers are skipped). */
function appendByHeaders_(sh, obj) {
  var cols = headerCols_(sh);
  var width = Math.max(sh.getLastColumn(), 1);
  var row = new Array(width).fill('');
  Object.keys(obj).forEach(function (k) {
    if (cols[k]) { row[cols[k] - 1] = obj[k]; }
  });
  sh.appendRow(row);
}

/* Read a tab into an array of objects keyed by its header row. */
function readTab_(name) {
  var sh = sheet_(name);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) { return []; }
  var head = values[0].map(String);
  return values.slice(1)
    .filter(function (row) { return row.some(function (c) { return String(c) !== ''; }); })
    .map(function (row) {
      var obj = {};
      head.forEach(function (h, i) {
        var v = row[i];
        obj[h] = (v instanceof Date) ? v.toISOString() : v;
      });
      return obj;
    });
}

/* Find the sheet row number (1-based) of the salon with a slug. */
function findSalonRow_(slug) {
  var sh = sheet_(TABS.SALONS);
  var cols = headerCols_(sh);
  if (!cols.slug) { return null; }
  var values = sh.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][cols.slug - 1]).trim() === slug) {
      return { sheet: sh, rowNum: r + 1, cols: cols, row: values[r] };
    }
  }
  return null;
}

function salonCell_(found, header) {
  var c = found.cols[header];
  return c ? String(found.row[c - 1]) : '';
}

/* ============================================================
   Slug helpers
   ============================================================ */
function slugify_(s) {
  var out = String(s || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out.slice(0, 60).replace(/-+$/g, '') || 'salon';
}

/* ============================================================
   v3 sanitizers — services / hours / instagram all live inside
   the Salons.config JSON blob, so old sheets need no migration.
   ============================================================ */
function sanitizeServices_(raw) {
  if (!Array.isArray(raw)) { return []; }
  var out = [];
  for (var i = 0; i < raw.length && out.length < 30; i++) {
    var it = raw[i] || {};
    var name = String(it.name || '').trim().slice(0, 60);
    if (!name) { continue; }
    var price = String(it.price || '').trim().slice(0, 20);
    out.push({ name: name, price: price });
  }
  return out;
}

function sanitizeInstagram_(raw) {
  var s = String(raw || '').trim();
  /* accept "@handle", "handle", or a full instagram.com URL */
  var m = s.match(/instagram\.com\/([A-Za-z0-9._]+)/i);
  if (m) { s = m[1]; }
  s = s.replace(/^@+/, '').replace(/[^A-Za-z0-9._]/g, '').slice(0, 30);
  return s;
}

function sanitizeHours_(raw) {
  return String(raw || '').trim().slice(0, 120);
}

function uniqueSlug_(base) {
  var existing = {};
  readTab_(TABS.SALONS).forEach(function (s) {
    var v = String(s.slug || '').trim();
    if (v) { existing[v] = true; }
  });
  if (!existing[base]) { return base; }
  for (var n = 2; n < 1000; n++) {
    var candidate = base + '-' + n;
    if (!existing[candidate]) { return candidate; }
  }
  return base + '-' + new Date().getTime();
}

/* ============================================================
   doGet
     ?site=<slug>       — PUBLIC, no token. Only safe fields, only
                          for status 'live-free' / 'live'.
     ?token=<SV_TOKEN>  — full data read (v1 behaviour; salons now
                          naturally include the new columns).
   ============================================================ */
function doGet(e) {
  var p = (e && e.parameter) || {};

  /* ---- public site config (no token) ---- */
  if (p.site) {
    return publicSiteConfig_(String(p.site));
  }

  if (!isFullToken_(p.token)) {
    return jsonOut_({ error: 'Unauthorized' });
  }

  var signups = readTab_(TABS.SIGNUPS);
  var salons = readTab_(TABS.SALONS);
  var months = readTab_(TABS.REVENUE).map(function (r) {
    return {
      ym: String(r.ym),
      revenue: Number(r.revenue) || 0,
      subs: {
        studio: Number(r.studio) || 0,
        pro: Number(r.pro) || 0,
        elite: Number(r.elite) || 0
      },
      trials: Number(r.trials) || 0,
      conversions: Number(r.conversions) || 0,
      churn: Number(r.churn) || 0
    };
  });

  /* v3: SiteLeads feed for the portal's Bookings view */
  var siteLeads = readTab_(TABS.SITELEADS);

  return jsonOut_({ signups: signups, months: months, salons: salons, siteLeads: siteLeads });
}

function publicSiteConfig_(slugRaw) {
  var slug = slugify_(slugRaw) === slugRaw ? slugRaw : String(slugRaw).trim().toLowerCase();
  var found;
  try {
    found = findSalonRow_(slug);
  } catch (err) {
    return jsonOut_({ error: 'not found' });
  }
  if (!found) { return jsonOut_({ error: 'not found' }); }

  var status = salonCell_(found, 'status');
  if (status !== 'live-free' && status !== 'live') {
    return jsonOut_({ error: 'not found' });
  }

  var photos = [];
  try { photos = JSON.parse(salonCell_(found, 'photos') || '[]'); } catch (e2) { photos = []; }
  if (!Array.isArray(photos)) { photos = []; }

  /* v3: services / hours / instagram come from the config blob.
     They are re-sanitized on the way out, and email / owner /
     phone / signupId are NEVER copied to the public payload. */
  var cfg = {};
  try { cfg = JSON.parse(salonCell_(found, 'config') || '{}'); } catch (e3) { cfg = {}; }

  /* ONLY public fields — no plan, no status, no email, no phone */
  return jsonOut_({
    ok: true,
    slug: slug,
    name: salonCell_(found, 'name'),
    tagline: salonCell_(found, 'tagline'),
    theme: salonCell_(found, 'theme'),
    accent: salonCell_(found, 'accent'),
    photos: photos,
    services: sanitizeServices_(cfg.services),
    hours: sanitizeHours_(cfg.hours),
    instagram: sanitizeInstagram_(cfg.instagram)
  });
}

/* ============================================================
   doPost — token-gated writes
     {type:'signup'}       signup token or full token   (v1)
     {type:'signupSite'}   signup token or full token   (v2)
     {type:'sitePhoto'}    signup token or full token   (v2)
     {type:'siteLead'}     signup token or full token   (v2)
     {type:'signupStatus'} full token only              (v1)
     {type:'salon'}        full token only              (v1)
   Body arrives as text/plain JSON (avoids CORS preflight).
   ============================================================ */
function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return jsonOut_({ error: 'Invalid JSON' });
  }

  var type = String(body.type || '');
  var token = String(body.token || '');

  /* Public (light-token) writes */
  if (type === 'signup' || type === 'signupSite' || type === 'sitePhoto' || type === 'siteLead' || type === 'findSite') {
    if (!isPublicWriteToken_(token)) {
      return jsonOut_({ error: 'Unauthorized' });
    }
    try {
      if (type === 'signup') { return handleSignup_(body); }
      if (type === 'signupSite') { return handleSignupSite_(body); }
      if (type === 'sitePhoto') { return handleSitePhoto_(body); }
      if (type === 'siteLead') { return handleSiteLead_(body); }
      if (type === 'findSite') { return handleFindSite_(body); }
    } catch (err2) {
      /* Return, don't throw — the client surfaces {error} and can
         fall back to a plain signup so the lead is never lost. */
      return jsonOut_({ error: 'Server error: ' + (err2 && err2.message ? err2.message : err2) });
    }
  }

  /* Everything else requires the full token. */
  if (!isFullToken_(token)) {
    return jsonOut_({ error: 'Unauthorized' });
  }
  if (type === 'signupStatus') { return handleSignupStatus_(body); }
  if (type === 'salon') { return handleSalonUpsert_(body); }
  if (type === 'salonConfig') { return handleSalonConfig_(body); }

  /* ---- v4 owner edit/delete handlers (full token only) ---- */
  if (type === 'salonDelete' || type === 'salonEdit' || type === 'signupDelete' ||
      type === 'leadDelete' || type === 'revenueSet' || type === 'revenueDelete') {
    try {
      if (type === 'salonDelete') { return handleSalonDelete_(body); }
      if (type === 'salonEdit') { return handleSalonEdit_(body); }
      if (type === 'signupDelete') { return handleSignupDelete_(body); }
      if (type === 'leadDelete') { return handleLeadDelete_(body); }
      if (type === 'revenueSet') { return handleRevenueSet_(body); }
      if (type === 'revenueDelete') { return handleRevenueDelete_(body); }
    } catch (err3) {
      return jsonOut_({ error: 'Server error: ' + (err3 && err3.message ? err3.message : err3) });
    }
  }

  return jsonOut_({ error: 'Unknown type: ' + type });
}

/* ============================================================
   v4 — audit trail
   Every edit/delete handler appends a row to _AuditLog:
   [ts, actor (body.actor || ''), type, ref/id/ym, fields JSON].
   Audit failure NEVER breaks the action (best-effort try/catch);
   the tab is auto-created here too in case setup() wasn't re-run.
   ============================================================ */
function audit_(body, type, ref, fields) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(TABS.AUDIT);
    if (!sh) {
      sh = ss.insertSheet(TABS.AUDIT);
      sh.appendRow(HEADERS['_AuditLog']);
      sh.setFrozenRows(1);
    }
    sh.appendRow([
      new Date().toISOString(),
      String((body && body.actor) || ''),
      String(type || ''),
      String(ref == null ? '' : ref),
      JSON.stringify(fields || {}).slice(0, 500)
    ]);
  } catch (err) {
    console.error('audit_ failed (action still succeeded): ' + err);
  }
}

/* ============================================================
   v4 — ref resolution for Salons rows.

   Data reality in the live sheet:
     - wizard rows:  salonId 'sal_<ts>_<n>', identifier in `slug`
     - two old rows: identifier in `salonId` (studio17,
       demo-iron-oak), slug EMPTY
     - one junk row: salonId 'test-vine-studio'
   So a ref matches when it equals EITHER column (trimmed). We
   refuse to act unless exactly ONE row matches.

   matchSalonRows_ is a PURE function (rows in, matches out) so it
   is unit-testable in Node without any Apps Script services.
   ============================================================ */
function matchSalonRows_(rows, ref) {
  var r = String(ref == null ? '' : ref).trim();
  if (!r) { return []; }
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var sid = String(rows[i].salonId == null ? '' : rows[i].salonId).trim();
    var slg = String(rows[i].slug == null ? '' : rows[i].slug).trim();
    if (sid === r || slg === r) { out.push(rows[i]); }
  }
  return out;
}

/* Reads the Salons sheet and resolves a ref to its matches.
   Returns {sheet, cols, matches:[{rowNum,salonId,slug,name}]}. */
function resolveSalonRef_(ref) {
  var sh = sheet_(TABS.SALONS);
  var cols = headerCols_(sh);
  var values = sh.getDataRange().getValues();
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    rows.push({
      rowNum: r + 1,
      salonId: cols.salonId ? values[r][cols.salonId - 1] : '',
      slug: cols.slug ? values[r][cols.slug - 1] : '',
      name: cols.name ? values[r][cols.name - 1] : ''
    });
  }
  return { sheet: sh, cols: cols, matches: matchSalonRows_(rows, ref) };
}

/* Shared 0-or-many refusal → returns an error TextOutput or null. */
function refuseUnlessSingle_(matches, ref) {
  if (matches.length === 0) {
    return jsonOut_({ error: 'No salon matches ref: ' + ref });
  }
  if (matches.length > 1) {
    return jsonOut_({ error: 'Ambiguous ref "' + ref + '" — matches ' + matches.length + ' rows; nothing was changed' });
  }
  return null;
}

/* ------------------------------------------------------------
   {type:'salonDelete', ref} — v4, FULL token only.
   ------------------------------------------------------------ */
function handleSalonDelete_(body) {
  var ref = String(body.ref || '').trim();
  if (!ref) { return jsonOut_({ error: 'Need ref (salonId or slug)' }); }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var res = resolveSalonRef_(ref);
    var refuse = refuseUnlessSingle_(res.matches, ref);
    if (refuse) { return refuse; }

    var m = res.matches[0];
    var deleted = {
      salonId: String(m.salonId || ''),
      slug: String(m.slug || ''),
      name: String(m.name || '')
    };
    res.sheet.deleteRow(m.rowNum);
    audit_(body, 'salonDelete', ref, deleted);
    return jsonOut_({ ok: true, deleted: deleted });
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------
   {type:'salonEdit', ref, fields:{...}} — v4, FULL token only.
   Whitelisted columns: name/tagline/theme/accent/status/plan/url
   (theme validated against THEMES). fields.hours / .instagram /
   .services merge into the config JSON blob using the SAME
   sanitizers as salonConfig / signupSite. Returns the updated
   record (all sheet columns by header).
   ------------------------------------------------------------ */
function handleSalonEdit_(body) {
  var ref = String(body.ref || '').trim();
  var fields = (body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)) ? body.fields : null;
  if (!ref || !fields) { return jsonOut_({ error: 'Need ref and a fields object' }); }

  if (fields.theme !== undefined && THEMES.indexOf(String(fields.theme)) === -1) {
    return jsonOut_({ error: 'Unknown theme: ' + fields.theme + ' (valid: ' + THEMES.join(', ') + ')' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var res = resolveSalonRef_(ref);
    var refuse = refuseUnlessSingle_(res.matches, ref);
    if (refuse) { return refuse; }

    var m = res.matches[0];
    var sh = res.sheet;
    var cols = res.cols;

    /* 1) direct whitelisted columns (only the provided ones) */
    SALON_EDIT_COLS.forEach(function (h) {
      if (fields[h] !== undefined && cols[h]) {
        sh.getRange(m.rowNum, cols[h]).setValue(String(fields[h]).slice(0, 300));
      }
    });

    /* 2) config-blob keys (hours / instagram / services) */
    var touchesConfig = (fields.hours !== undefined || fields.instagram !== undefined || fields.services !== undefined);
    if (touchesConfig) {
      if (!cols.config) { return jsonOut_({ error: 'Salons tab missing config header — run setup()' }); }
      var cfg = {};
      try { cfg = JSON.parse(String(sh.getRange(m.rowNum, cols.config).getValue() || '{}')); } catch (e1) { cfg = {}; }
      if (!cfg || typeof cfg !== 'object') { cfg = {}; }
      if (fields.hours !== undefined) { cfg.hours = sanitizeHours_(fields.hours); }
      if (fields.instagram !== undefined) { cfg.instagram = sanitizeInstagram_(fields.instagram); }
      if (fields.services !== undefined) { cfg.services = sanitizeServices_(fields.services); }
      sh.getRange(m.rowNum, cols.config).setValue(JSON.stringify(cfg));
    }

    /* 3) read the row back as the updated record */
    var width = Math.max(sh.getLastColumn(), 1);
    var rowVals = sh.getRange(m.rowNum, 1, 1, width).getValues()[0];
    var record = {};
    Object.keys(cols).forEach(function (h) {
      var v = rowVals[cols[h] - 1];
      record[h] = (v instanceof Date) ? v.toISOString() : v;
    });

    audit_(body, 'salonEdit', ref, fields);
    return jsonOut_({ ok: true, salon: record });
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------
   {type:'signupDelete', id} — v4, FULL token only.
   ------------------------------------------------------------ */
function handleSignupDelete_(body) {
  var id = String(body.id || '').trim();
  if (!id) { return jsonOut_({ error: 'Need id' }); }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = sheet_(TABS.SIGNUPS);
    var cols = headerCols_(sh);
    if (!cols.id) { return jsonOut_({ error: 'Signups tab missing id header — run setup()' }); }
    var values = sh.getDataRange().getValues();
    for (var r = 1; r < values.length; r++) {
      if (String(values[r][cols.id - 1]).trim() === id) {
        var deleted = {
          id: id,
          salon: cols.salon ? String(values[r][cols.salon - 1]) : ''
        };
        sh.deleteRow(r + 1);
        audit_(body, 'signupDelete', id, deleted);
        return jsonOut_({ ok: true, deleted: deleted });
      }
    }
    return jsonOut_({ error: 'Signup not found: ' + id });
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------
   {type:'leadDelete', ts, slug} — v4, FULL token only.
   SiteLeads has NO id column; the (ts, slug) pair is the key.
   Sheet ts cells may come back as Date objects — normalize to
   the ISO string before comparing. Refuses on 0 or >1 matches.
   ------------------------------------------------------------ */
function handleLeadDelete_(body) {
  var ts = String(body.ts || '').trim();
  var slug = String(body.slug || '').trim();
  if (!ts || !slug) { return jsonOut_({ error: 'Need ts and slug' }); }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = sheet_(TABS.SITELEADS);
    var cols = headerCols_(sh);
    if (!cols.ts || !cols.slug) { return jsonOut_({ error: 'SiteLeads tab missing ts/slug headers — run setup()' }); }
    var values = sh.getDataRange().getValues();
    var matches = [];
    for (var r = 1; r < values.length; r++) {
      var cell = values[r][cols.ts - 1];
      var rowTs = (cell instanceof Date) ? cell.toISOString() : String(cell).trim();
      var rowSlug = String(values[r][cols.slug - 1]).trim();
      if (rowTs === ts && rowSlug === slug) {
        matches.push({
          rowNum: r + 1,
          name: cols.name ? String(values[r][cols.name - 1]) : ''
        });
      }
    }
    if (matches.length === 0) {
      return jsonOut_({ error: 'No booking matches ts ' + ts + ' + slug ' + slug });
    }
    if (matches.length > 1) {
      return jsonOut_({ error: 'Ambiguous booking (' + matches.length + ' rows match ts ' + ts + ' + slug ' + slug + '); nothing was changed' });
    }
    var deleted = { ts: ts, slug: slug, name: matches[0].name };
    sh.deleteRow(matches[0].rowNum);
    audit_(body, 'leadDelete', ts + ' ' + slug, deleted);
    return jsonOut_({ ok: true, deleted: deleted });
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------
   v4 Revenue helpers + handlers.
   ------------------------------------------------------------ */
function validYm_(ym) {
  var m = String(ym || '').trim().match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  return m ? m[0] : '';
}

function revNum_(v) {
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

/* {type:'revenueSet', ym, fields:{...}} — upsert keyed by ym. */
function handleRevenueSet_(body) {
  var ym = validYm_(body.ym);
  if (!ym) { return jsonOut_({ error: 'Need ym in YYYY-MM format' }); }
  var fields = (body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)) ? body.fields : {};

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = sheet_(TABS.REVENUE);
    var cols = headerCols_(sh);
    if (!cols.ym) { return jsonOut_({ error: 'Revenue tab missing ym header — run setup()' }); }
    var values = sh.getDataRange().getValues();
    var rowNum = 0;
    for (var r = 1; r < values.length; r++) {
      if (String(values[r][cols.ym - 1]).trim() === ym) { rowNum = r + 1; break; }
    }

    if (rowNum) {
      /* update only the provided whitelisted fields */
      REV_FIELDS.forEach(function (h) {
        if (fields[h] !== undefined && cols[h]) {
          sh.getRange(rowNum, cols[h]).setValue(revNum_(fields[h]));
        }
      });
    } else {
      /* insert — unprovided fields default to 0 */
      var obj = { ym: ym };
      REV_FIELDS.forEach(function (h) { obj[h] = revNum_(fields[h]); });
      appendByHeaders_(sh, obj);
      rowNum = sh.getLastRow();
    }

    /* read the row back */
    var width = Math.max(sh.getLastColumn(), 1);
    var rowVals = sh.getRange(rowNum, 1, 1, width).getValues()[0];
    var record = { ym: ym };
    REV_FIELDS.forEach(function (h) {
      record[h] = cols[h] ? revNum_(rowVals[cols[h] - 1]) : 0;
    });

    audit_(body, 'revenueSet', ym, fields);
    return jsonOut_({ ok: true, month: record });
  } finally {
    lock.releaseLock();
  }
}

/* {type:'revenueDelete', ym} */
function handleRevenueDelete_(body) {
  var ym = validYm_(body.ym);
  if (!ym) { return jsonOut_({ error: 'Need ym in YYYY-MM format' }); }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = sheet_(TABS.REVENUE);
    var cols = headerCols_(sh);
    if (!cols.ym) { return jsonOut_({ error: 'Revenue tab missing ym header — run setup()' }); }
    var values = sh.getDataRange().getValues();
    for (var r = 1; r < values.length; r++) {
      if (String(values[r][cols.ym - 1]).trim() === ym) {
        sh.deleteRow(r + 1);
        audit_(body, 'revenueDelete', ym, {});
        return jsonOut_({ ok: true, deleted: { ym: ym } });
      }
    }
    return jsonOut_({ error: 'Revenue month not found: ' + ym });
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------
   {type:'salonConfig', slug, patch:{...}} — v3, FULL token only
   (gated in doPost above). Shallow-merges the patch into the
   salon's config JSON blob. services / hours / instagram are
   sanitized; other keys are stored as short strings so the
   owner portal / future editor can extend config without a
   backend release. signupId is protected.
   ------------------------------------------------------------ */
function handleSalonConfig_(body) {
  var slug = String(body.slug || '').trim().toLowerCase();
  var patch = (body.patch && typeof body.patch === 'object' && !Array.isArray(body.patch)) ? body.patch : null;
  if (!slug || !patch) { return jsonOut_({ error: 'Need slug and patch object' }); }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var found = findSalonRow_(slug);
    if (!found) { return jsonOut_({ error: 'Unknown site: ' + slug }); }
    if (!found.cols.config) { return jsonOut_({ error: 'Salons tab missing config header — run setup()' }); }

    var cfg = {};
    try { cfg = JSON.parse(salonCell_(found, 'config') || '{}'); } catch (e1) { cfg = {}; }
    if (!cfg || typeof cfg !== 'object') { cfg = {}; }

    Object.keys(patch).forEach(function (k) {
      if (k === 'signupId') { return; } /* provenance is immutable */
      if (k === 'services') { cfg.services = sanitizeServices_(patch.services); return; }
      if (k === 'hours') { cfg.hours = sanitizeHours_(patch.hours); return; }
      if (k === 'instagram') { cfg.instagram = sanitizeInstagram_(patch.instagram); return; }
      if (patch[k] === null) { delete cfg[k]; return; } /* null deletes a key */
      cfg[k] = String(patch[k]).slice(0, 500);
    });

    found.sheet.getRange(found.rowNum, found.cols.config).setValue(JSON.stringify(cfg));
    return jsonOut_({ ok: true, slug: slug, config: cfg });
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------
   {type:'findSite', email} — light-token lookup used by the
   marketing site's "Find your salon" (login) page. Returns the
   newest LIVE instant site whose signup email matches. Only
   reveals slug/url/name — nothing else.
   ------------------------------------------------------------ */
function handleFindSite_(body) {
  var email = String(body.email || '').trim().toLowerCase();
  if (!email) { return jsonOut_({ ok: true, found: false }); }

  var salons = readTab_(TABS.SALONS);
  var hit = null;
  for (var i = 0; i < salons.length; i++) {
    var sal = salons[i];
    var status = String(sal.status || '').toLowerCase();
    if (status !== 'live-free' && status !== 'live') { continue; }
    var cfg = {};
    try { cfg = JSON.parse(String(sal.config || '{}')); } catch (e) { cfg = {}; }
    if (String(cfg.email || '').trim().toLowerCase() === email) {
      hit = sal; /* keep last (newest) match */
    }
  }

  if (!hit) { return jsonOut_({ ok: true, found: false }); }
  var slug = String(hit.slug || hit.salonId || '');
  return jsonOut_({
    ok: true,
    found: true,
    slug: slug,
    url: String(hit.url || (PUBLIC_SITE_BASE + slug)),
    salonName: String(hit.name || '')
  });
}

/* ------------------------------------------------------------
   Signup core — shared by {type:'signup'} and {type:'signupSite'}.
   De-dupe guard: same email within 10 minutes is treated as a
   double-submit and acknowledged without a second row/email.
   Returns {id, deduped}.
   ------------------------------------------------------------ */
function signupCore_(body, now) {
  var sh = sheet_(TABS.SIGNUPS);
  var email = String(body.email || '').trim().toLowerCase();

  var TEN_MIN = 10 * 60 * 1000;
  var existing = readTab_(TABS.SIGNUPS);
  for (var i = existing.length - 1; i >= 0; i--) {
    var r = existing[i];
    if (String(r.email || '').trim().toLowerCase() === email && email !== '') {
      var ts = new Date(r.ts);
      if (!isNaN(ts.getTime()) && (now.getTime() - ts.getTime()) < TEN_MIN) {
        return { id: r.id, deduped: true };
      }
    }
  }

  var id = 'su_' + now.getTime() + '_' + Math.floor(Math.random() * 10000);
  appendByHeaders_(sh, {
    id: id,
    ts: now.toISOString(),
    salon: String(body.salon || ''),
    name: String(body.name || ''),
    email: String(body.email || ''),
    phone: String(body.phone || ''),
    website: String(body.website || ''),
    plan: String(body.plan || ''),
    status: 'new',
    salonId: String(body.salonId || ''),
    actor: String(body.actor || 'public-form')
  });

  notifyOwnersOfSignup_(body, id, now);
  return { id: id, deduped: false };
}

/* ------------------------------------------------------------
   {type:'signup'} — v1 INSERT from the marketing-site form.
   Extra wizard fields (theme/accent/tagline/slug) are accepted
   and simply appended into the owner email so nothing is lost
   when the client falls back to a plain signup.
   ------------------------------------------------------------ */
function handleSignup_(body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var res = signupCore_(body, new Date());
    return jsonOut_({ ok: true, id: res.id, deduped: res.deduped || undefined });
  } finally {
    lock.releaseLock();
  }
}

/* Owner notification email for every new signup. */
function notifyOwnersOfSignup_(body, id, when) {
  var subject = 'New SalonVine trial signup — ' + String(body.salon || '(no salon name)');
  var lines = [
    'A new signup just came in from salonvine.com:',
    '',
    'Salon:    ' + (body.salon || '—'),
    'Contact:  ' + (body.name || '—'),
    'Email:    ' + (body.email || '—'),
    'Phone:    ' + (body.phone || '—'),
    'Website:  ' + (body.website || '—'),
    'Plan:     ' + (body.plan || '—') + ' (free during early access)',
    'When:     ' + when.toString(),
    'ID:       ' + id
  ];
  if (body.theme || body.tagline || body.accent) {
    lines.push('');
    lines.push('Site preferences from the wizard:');
    if (body.theme) { lines.push('Theme:    ' + body.theme); }
    if (body.accent) { lines.push('Accent:   ' + body.accent); }
    if (body.tagline) { lines.push('Tagline:  ' + body.tagline); }
    if (body.slug) { lines.push('Slug:     ' + body.slug); }
  }
  lines.push('');
  lines.push('Open the owner portal to follow up: https://portal.salonvine.com');
  OWNER_NOTIFY.forEach(function (addr) {
    if (!addr || addr.indexOf('PLACEHOLDER') === 0) { return; }
    try {
      MailApp.sendEmail(addr, subject, lines.join('\n'));
    } catch (err) {
      console.error('Notify failed for ' + addr + ': ' + err);
    }
  });
}

/* ------------------------------------------------------------
   {type:'signupSite'} — v2 wizard submit. Does everything
   {type:'signup'} does PLUS creates the live Salons row.
   Body: {salon,name,email,phone,website,plan,slug,theme,accent,tagline}
   Returns {ok, id, slug, url}.

   Retry-safe: if the same email already created a salon in the
   last 24h (e.g. the visitor hit Retry after a partial failure),
   the existing slug/url is returned instead of a duplicate site.
   ------------------------------------------------------------ */
function handleSignupSite_(body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var now = new Date();
    var email = String(body.email || '').trim().toLowerCase();
    if (!String(body.salon || '').trim() || !email) {
      return jsonOut_({ error: 'Need salon and email' });
    }

    /* retry guard: same email already has a fresh salon? */
    var DAY = 24 * 60 * 60 * 1000;
    var salons = readTab_(TABS.SALONS);
    for (var i = salons.length - 1; i >= 0; i--) {
      var s = salons[i];
      var cfg = {};
      try { cfg = JSON.parse(String(s.config || '{}')); } catch (e1) { cfg = {}; }
      if (String(cfg.email || '').toLowerCase() === email && s.slug) {
        var created = new Date(s.createdAt);
        if (!isNaN(created.getTime()) && (now.getTime() - created.getTime()) < DAY) {
          signupCore_(body, now); /* still record/dedupe the lead */
          return jsonOut_({ ok: true, id: '', slug: String(s.slug), url: String(s.url || (PUBLIC_SITE_BASE + s.slug)), existing: true });
        }
      }
    }

    /* 1) the lead row + owner email (dedupe-aware) */
    var su = signupCore_(body, now);

    /* 2) the live salon row */
    var slug = uniqueSlug_(slugify_(body.slug || body.salon));
    var url = PUBLIC_SITE_BASE + slug;
    var salonId = 'sal_' + now.getTime() + '_' + Math.floor(Math.random() * 10000);
    var config = {
      email: String(body.email || ''),
      owner: String(body.name || ''),
      phone: String(body.phone || ''),
      signupId: su.id,
      /* v3: wizard extras — all optional, all sanitized */
      services: sanitizeServices_(body.services),
      hours: sanitizeHours_(body.hours),
      instagram: sanitizeInstagram_(body.instagram)
    };
    appendByHeaders_(sheet_(TABS.SALONS), {
      salonId: salonId,
      name: String(body.salon || ''),
      url: url,
      plan: String(body.plan || ''),
      status: 'live-free',
      slug: slug,
      theme: String(body.theme || 'classic-cream'),
      accent: String(body.accent || ''),
      tagline: String(body.tagline || ''),
      photos: '[]',
      config: JSON.stringify(config),
      createdAt: now.toISOString()
    });

    return jsonOut_({ ok: true, id: su.id, slug: slug, url: url });
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------
   {type:'sitePhoto'} — v2. Body {slug, n, data: base64 dataURL}.
   Saves to Drive "SalonVine Sites/<slug>/", shares
   anyone-with-link, appends the lh3 URL to the salon's photos.
   ------------------------------------------------------------ */
function handleSitePhoto_(body) {
  var slug = String(body.slug || '').trim().toLowerCase();
  var data = String(body.data || '');
  var n = Number(body.n) || 0;

  if (!slug || !data) { return jsonOut_({ error: 'Need slug and data' }); }
  if (data.length > MAX_PHOTO_POST_CHARS) { return jsonOut_({ error: 'Photo too large' }); }
  var m = data.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/);
  if (!m) { return jsonOut_({ error: 'Expected a base64 image dataURL' }); }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var found = findSalonRow_(slug);
    if (!found) { return jsonOut_({ error: 'Unknown site: ' + slug }); }

    var photos = [];
    try { photos = JSON.parse(salonCell_(found, 'photos') || '[]'); } catch (e1) { photos = []; }
    if (!Array.isArray(photos)) { photos = []; }
    if (photos.length >= MAX_PHOTOS_PER_SALON) {
      return jsonOut_({ error: 'Photo limit reached (' + MAX_PHOTOS_PER_SALON + ')' });
    }

    var contentType = m[1] === 'image/jpg' ? 'image/jpeg' : m[1];
    var bytes;
    try {
      bytes = Utilities.base64Decode(m[2]);
    } catch (e2) {
      return jsonOut_({ error: 'Bad base64 data' });
    }
    var ext = contentType === 'image/png' ? 'png' : (contentType === 'image/webp' ? 'webp' : 'jpg');
    var blob = Utilities.newBlob(bytes, contentType, slug + '-' + (n || photos.length + 1) + '.' + ext);

    var folder = getOrCreateFolder_(getOrCreateRootFolder_(), slug);
    var file = folder.createFile(blob);
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (e3) {
      console.error('setSharing failed for ' + slug + ': ' + e3);
    }

    var url = 'https://lh3.googleusercontent.com/d/' + file.getId() + '=w1600';
    photos.push(url);
    var col = found.cols.photos;
    if (col) { found.sheet.getRange(found.rowNum, col).setValue(JSON.stringify(photos)); }

    return jsonOut_({ ok: true, url: url, count: photos.length });
  } finally {
    lock.releaseLock();
  }
}

function getOrCreateRootFolder_() {
  var it = DriveApp.getFoldersByName(DRIVE_ROOT_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(DRIVE_ROOT_FOLDER);
}

function getOrCreateFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/* ------------------------------------------------------------
   {type:'siteLead'} — v2 booking request from a live salon site.
   Body {slug, name, phone, email, message}. Stored to SiteLeads
   + emailed to the salon's signup email AND the owners.
   De-dupe: same email+slug within 5 minutes.
   ------------------------------------------------------------ */
function handleSiteLead_(body) {
  var slug = String(body.slug || '').trim().toLowerCase();
  var name = String(body.name || '').trim();
  var phone = String(body.phone || '').trim();
  var email = String(body.email || '').trim();
  var message = String(body.message || '').trim();
  if (!slug) { return jsonOut_({ error: 'Need slug' }); }
  if (!name || (!phone && !email)) {
    return jsonOut_({ error: 'Need a name and a phone or email' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var now = new Date();

    /* de-dupe: same email + slug in the last 5 minutes */
    var FIVE_MIN = 5 * 60 * 1000;
    var emailLc = email.toLowerCase();
    if (emailLc) {
      var existing = readTab_(TABS.SITELEADS);
      for (var i = existing.length - 1; i >= 0; i--) {
        var r = existing[i];
        if (String(r.slug || '') === slug && String(r.email || '').toLowerCase() === emailLc) {
          var ts = new Date(r.ts);
          if (!isNaN(ts.getTime()) && (now.getTime() - ts.getTime()) < FIVE_MIN) {
            return jsonOut_({ ok: true, deduped: true });
          }
        }
      }
    }

    appendByHeaders_(sheet_(TABS.SITELEADS), {
      ts: now.toISOString(),
      slug: slug,
      name: name,
      phone: phone,
      email: email,
      message: message
    });

    /* find the salon + its owner email */
    var found = findSalonRow_(slug);
    var salonName = found ? (salonCell_(found, 'name') || slug) : slug;
    var ownerEmail = '';
    if (found) {
      try {
        var cfg = JSON.parse(salonCell_(found, 'config') || '{}');
        ownerEmail = String(cfg.email || '');
      } catch (e1) { ownerEmail = ''; }
    }

    var subject = 'New booking request — ' + salonName;
    var lines = [
      'Someone just requested an appointment on your Salon Vine site:',
      '',
      'Salon:    ' + salonName + ' (' + PUBLIC_SITE_BASE + slug + ')',
      'Name:     ' + (name || '—'),
      'Phone:    ' + (phone || '—'),
      'Email:    ' + (email || '—'),
      'Message:  ' + (message || '—'),
      'When:     ' + now.toString(),
      '',
      'Reply directly to the client to book them in.'
    ];
    var recipients = [];
    if (ownerEmail) { recipients.push(ownerEmail); }
    OWNER_NOTIFY.forEach(function (a) { if (recipients.indexOf(a) === -1) { recipients.push(a); } });
    recipients.forEach(function (addr) {
      if (!addr || addr.indexOf('PLACEHOLDER') === 0) { return; }
      try {
        MailApp.sendEmail(addr, subject, lines.join('\n'));
      } catch (err) {
        console.error('Lead notify failed for ' + addr + ': ' + err);
      }
    });

    return jsonOut_({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------
   {type:'signupStatus', id, status} — v1, unchanged.
   ------------------------------------------------------------ */
function handleSignupStatus_(body) {
  var VALID = ['new', 'contacted', 'converted', 'lost'];
  var id = String(body.id || '');
  var status = String(body.status || '');
  if (!id || VALID.indexOf(status) === -1) {
    return jsonOut_({ error: 'Need id and a valid status (' + VALID.join('/') + ')' });
  }
  var sh = sheet_(TABS.SIGNUPS);
  var values = sh.getDataRange().getValues();
  var head = values[0].map(String);
  var idCol = head.indexOf('id');
  var statusCol = head.indexOf('status');
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][idCol]) === id) {
      sh.getRange(r + 1, statusCol + 1).setValue(status);
      return jsonOut_({ ok: true, id: id, status: status });
    }
  }
  return jsonOut_({ error: 'Signup not found: ' + id });
}

/* ------------------------------------------------------------
   {type:'salon', salonId, ...} — v1 upsert, now header-driven so
   it works with the extended Salons columns too.
   ------------------------------------------------------------ */
function handleSalonUpsert_(body) {
  var salonId = String(body.salonId || '');
  if (!salonId) { return jsonOut_({ error: 'Need salonId' }); }
  var sh = sheet_(TABS.SALONS);
  var cols = headerCols_(sh);
  var values = sh.getDataRange().getValues();
  var idCol = cols.salonId;
  if (!idCol) { return jsonOut_({ error: 'Salons tab missing salonId header — run setup()' }); }
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][idCol - 1]) === salonId) {
      /* update: only overwrite provided fields */
      HEADERS.Salons.forEach(function (h) {
        if (body[h] !== undefined && cols[h]) {
          sh.getRange(r + 1, cols[h]).setValue(String(body[h]));
        }
      });
      return jsonOut_({ ok: true, salonId: salonId, updated: true });
    }
  }
  var obj = {};
  HEADERS.Salons.forEach(function (h) { obj[h] = String(body[h] || ''); });
  appendByHeaders_(sh, obj);
  return jsonOut_({ ok: true, salonId: salonId, created: true });
}
