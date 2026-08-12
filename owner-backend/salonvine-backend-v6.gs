/* ============================================================
   SalonVine — Live Data backend v4.1 (Google Apps Script)

   v4 adds the mail/SMS relay for the multi-tenant app site
   (salonvine-app.netlify.app), plus plan/status lookups so the
   app can enforce seat limits and (later) suspend/reactivate
   salons. EVERY v1/v2/v3 handler keeps working unchanged.

   ------------------------------------------------------------
   ENDPOINT REFERENCE (all of them, v1 -> v4)
   ------------------------------------------------------------
   doGet:
     ?site=<slug>            PUBLIC, no token. Safe site config
                             only ({slug,name,tagline,theme,
                             accent,photos,services,hours,
                             instagram}) and only for salons with
                             status 'live-free' / 'live'. Never
                             includes email/phone/plan/status.
     ?token=<SV_TOKEN>       Full data read: {signups, months,
                             salons, siteLeads}.

   doPost (body = text/plain JSON, avoids CORS preflight):
     Light token (SV_SIGNUP_TOKEN) or full token (SV_TOKEN):
       {type:'signup'}       v1. Lead row in Signups + owner
                             notify email. 10-min email de-dupe.
                             Returns {ok,id,deduped?}.
       {type:'signupSite'}   v2/v3. Everything 'signup' does PLUS
                             creates a live Salons row (unique
                             slug, theme/accent/tagline, and v3
                             extras services/hours/instagram in
                             the config blob). 24h retry guard by
                             email. Returns {ok,id,slug,url}.
       {type:'sitePhoto'}    v2. {slug,n,data:base64 dataURL} ->
                             Drive "SalonVine Sites/<slug>/",
                             shared link appended to photos.
                             Cap 8/salon. Returns {ok,url,count}.
       {type:'siteLead'}     v2. {slug,name,phone,email,message}
                             -> SiteLeads row + email to salon
                             owner and SalonVine owners. 5-min
                             de-dupe. Returns {ok}.
       {type:'findSite'}     v3. {email} -> newest LIVE site for
                             that signup email. Only reveals
                             {slug,url,salonName}.
     Full token (SV_TOKEN) ONLY:
       {type:'signupStatus'} v1. {id,status:new/contacted/
                             converted/lost}. Returns {ok}.
       {type:'salon'}        v1. Header-driven upsert of a Salons
                             row by salonId. Returns {ok}.
       {type:'salonConfig'}  v3. {slug,patch:{...}} shallow-merge
                             into the salon's config JSON blob
                             (services/hours/instagram sanitized,
                             signupId protected, null deletes).
                             Returns {ok,slug,config}.
       {type:'sendMail'}     v4. Mail/SMS relay for the app site.
                             {to,subject,text} sends an email as
                             the executing account; {sms:{phone},
                             text} sends the text to the 4 US
                             carrier email-to-text gateways
                             (vtext.com, tmomail.net, txt.att.net,
                             messaging.sprintpcs.com) with a blank
                             subject. Both may be combined in one
                             call. Every send is logged to the
                             MailLog tab. Returns {ok,sent} or
                             {error}.
       {type:'salonPlan'}    v4. {slug} -> {ok,slug,plan,status}
                             from the Salons sheet. Used by the
                             app site to enforce per-plan seat
                             limits (studio 3 / pro 10 / elite
                             unlimited).
       {type:'salonStatus'}  v4. {slug,status} -> updates the
                             salon row's status cell (future
                             suspend/reactivate) and appends to
                             the StatusLog tab (ts,slug,old,new).
                             Returns {ok,slug,old,new}.

   ------------------------------------------------------------
   *** ROTATION NOTE — SV_SIGNUP_TOKEN (do this with v4) ***
   ------------------------------------------------------------
   The old SV_SIGNUP_TOKEN was exposed in the public page source
   of the marketing site, so anyone could read it and spam the
   light-token endpoints. It MUST be rotated when v4 ships, and
   the marketing site must stop shipping it to the browser (the
   new app site keeps it server-side only, in the signup-proxy
   Netlify function). Steps:
     1. Apps Script editor -> Project Settings -> Script
        Properties -> edit SV_SIGNUP_TOKEN -> paste a NEW long
        random value -> Save. (Old token dies instantly; no
        redeploy of the web app is needed for property changes.)
     2. Netlify site "salonvine-app" -> Site configuration ->
        Environment variables -> update SV_SIGNUP_TOKEN to the
        same new value -> redeploy functions.
     3. Confirm no client-side file (marketing site or app site)
        contains the new value — it may only ever live in Script
        Properties and Netlify env vars.

   ------------------------------------------------------------
   Install/upgrade: open the "SalonVine — Live Data" Sheet ->
   Extensions -> Apps Script -> replace the file with this one ->
   run setup() once (migration-safe: appends missing headers /
   missing tabs incl. the new MailLog + StatusLog, never wipes)
   -> Deploy -> Manage deployments -> edit the EXISTING web-app
   deployment -> New version. The /exec URL stays the same.

   Script Properties:
     SV_TOKEN        — full read/write token
     SV_SIGNUP_TOKEN — light token, server-side only (see
                       ROTATION NOTE above)
   ============================================================ */

/* ---------- Owner notification list ---------- */
var OWNER_NOTIFY = ['zackbrockway17@gmail.com', 'halleroffroadllc@gmail.com'];

var PUBLIC_SITE_BASE = 'https://salonvine.com/s/';

/* v6.2: pretty subdomain URLs for new signups. Flip Script Property
   SV_SUBDOMAIN_URLS to TRUE only AFTER *.salonvine.com wildcard DNS
   is live on Netlify — until then new signups keep /s/<slug> URLs
   (which always keep working either way). Subdomain form drops the
   hyphens (cali-cuts -> calicuts.salonvine.com); the public config
   lookup matches hyphen-insensitively, so both forms resolve. */
function subdomainUrlsOn_() {
  return String(props_().getProperty('SV_SUBDOMAIN_URLS') || '').trim().toUpperCase() === 'TRUE';
}
function publicUrlFor_(slug) {
  var s = String(slug || '');
  if (subdomainUrlsOn_() && s) { return 'https://' + s.replace(/-/g, '') + '.salonvine.com'; }
  return PUBLIC_SITE_BASE + s;
}
var DRIVE_ROOT_FOLDER = 'SalonVine Sites';
var MAX_PHOTOS_PER_SALON = 8;
/* ~6MB of binary is ~8.4M base64 chars (incl. dataURL header slack) */
var MAX_PHOTO_POST_CHARS = 8600000;

/* v4 mail relay limits */
var MAX_MAIL_TEXT_CHARS = 10000;
var MAX_SMS_TEXT_CHARS = 300;
var MAX_MAIL_SUBJECT_CHARS = 200;
var SMS_GATEWAYS = ['vtext.com', 'tmomail.net', 'txt.att.net', 'messaging.sprintpcs.com'];

/* v4 salonStatus whitelist */
var VALID_SALON_STATUSES = ['live', 'live-free', 'pending', 'suspended', 'cancelled'];

/* ------------------------------------------------------------
   v4 edit/delete constants.

   *** v5 MERGE FIX (loud note) ***
   THEMES / SALON_EDIT_COLS / REV_FIELDS are referenced by
   handleSalonEdit_ / handleRevenueSet_ but were DROPPED when the
   v4 edit/delete handlers were merged into this file — the live
   merged base (salonvine-backend-v4-merged.gs) defines the
   handlers at the bottom but never re-declared these top-of-file
   constants, so salonEdit / revenueSet threw a ReferenceError at
   runtime. They are restored here (byte-identical to the values
   in my-v4-editdelete.gs) so those handlers actually work.
   ------------------------------------------------------------ */
var THEMES = ['classic-cream', 'midnight', 'rose-gold', 'sage-spa', 'bold-noir', 'ocean'];
var SALON_EDIT_COLS = ['name', 'tagline', 'theme', 'accent', 'status', 'plan', 'url'];
var REV_FIELDS = ['revenue', 'studio', 'pro', 'elite', 'trials', 'conversions', 'churn'];

/* ============================================================
   v5 — Archive + 30-day-Trash lifecycle
   ------------------------------------------------------------
   Membership is by MARKER COLUMNS, never by status strings:
     - a row is IN TRASH  iff its deletedAt  cell is non-empty
     - a row is ARCHIVED  iff its archivedAt cell is non-empty
                             (and it is not in trash)
     - a row is ACTIVE    otherwise. Legacy rows whose status is
                             archived/cancelled/junk/archived-test
                             but that carry NO markers stay ACTIVE
                             (normal Salon Sites rows), and are
                             never auto-purged.
   Trash auto-deletes after TRASH_TTL_DAYS via purgeExpiredTrash().
   ============================================================ */
var TRASH_TTL_DAYS = 30;
/* Statuses a restore is allowed to land on. NEVER auto-promote a
   free site to a paid 'live' unless prevStatus was exactly 'live'. */
var RESTORE_TARGETS = ['live-free', 'live', 'archived'];

var TABS = {
  SIGNUPS: 'Signups',
  REVENUE: 'Revenue',
  SALONS: 'Salons',
  SITELEADS: 'SiteLeads',
  MAILLOG: 'MailLog',
  STATUSLOG: 'StatusLog',
  AUDIT: '_AuditLog',         /* v4 edit/delete audit */
  PROMOS: 'Promos'            /* v6 promo codes */
};

var HEADERS = {
  Signups: ['id', 'ts', 'salon', 'name', 'email', 'phone', 'website', 'plan', 'status', 'salonId', 'actor'],
  Revenue: ['ym', 'revenue', 'studio', 'pro', 'elite', 'trials', 'conversions', 'churn'],
  /* v2: new columns are APPENDED after the v1 columns so existing
     live sheets migrate by adding columns on the right.
     v5: deletedAt / prevStatus / archivedAt are APPENDED at the end
     for the Archive+Trash lifecycle. setup() appends any missing
     header (migration-safe) and ALL code reads Salons by header
     NAME (headerCols_), never by fixed index, so appending here is
     safe and requires no data move. */
  /* v6: promo / comp APPENDED at the end — migration-safe. `promo`
     holds the redeemed code (if any); `comp` is 'TRUE' for a
     comped (free-forever) salon so future billing never charges it. */
  Salons:  ['salonId', 'name', 'url', 'plan', 'status', 'slug', 'theme', 'accent', 'tagline', 'photos', 'config', 'createdAt', 'deletedAt', 'prevStatus', 'archivedAt', 'promo', 'comp'],
  SiteLeads: ['ts', 'slug', 'name', 'phone', 'email', 'message'],
  /* v4 */
  MailLog: ['ts', 'to', 'kind', 'subject', 'ok'],
  StatusLog: ['ts', 'slug', 'old', 'new'],
  '_AuditLog': ['ts', 'actor', 'type', 'ref', 'fields'],
  /* v6: reusable promo codes. kind='comp' => free-forever (no billing).
     maxRedemptions blank/0 = unlimited. active must be TRUE to work. */
  Promos: ['code', 'kind', 'label', 'active', 'maxRedemptions', 'redeemed', 'note', 'createdAt']
};

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
  seedPromos_();
}

/* ============================================================
   v6 — Promo codes (reusable managed list)
   ------------------------------------------------------------
   Tab: Promos [code, kind, label, active, maxRedemptions,
                redeemed, note, createdAt]
     kind = 'comp'  -> free-forever (salon.comp = TRUE, never billed)
     active must be exactly TRUE (case-insensitive) to work
     maxRedemptions blank/0 -> unlimited
   Codes are matched case-INSENSITIVELY. Redemptions increment on a
   successful comped site creation (handleSignupSite_).
   ============================================================ */

/* Seed the first founding-client code once. Idempotent: only adds
   FRIENDSFREE if the Promos tab has no row for it yet. */
function seedPromos_() {
  var sh = sheetOrCreate_(TABS.PROMOS || 'Promos');
  if (promoRowNum_(sh, 'FRIENDSFREE') === -1) {
    appendByHeaders_(sh, {
      code: 'FRIENDSFREE',
      kind: 'comp',
      label: 'Friends & founding clients — free forever',
      active: 'TRUE',
      maxRedemptions: '',
      redeemed: 0,
      note: 'Comps a salon to free-forever (no billing). First used for Salon 17 (Dylan\'s wife).',
      createdAt: new Date().toISOString()
    });
  }
}

function normPromoCode_(c) { return String(c || '').trim().toUpperCase(); }
function isTrue_(v) { return String(v || '').trim().toUpperCase() === 'TRUE'; }

/* Row number (1-based, incl header) of a code in the Promos tab, or -1. */
function promoRowNum_(sh, code) {
  var want = normPromoCode_(code);
  if (!want) { return -1; }
  var values = sh.getDataRange().getValues();
  if (values.length < 2) { return -1; }
  var head = values[0].map(String);
  var cCol = head.indexOf('code');
  if (cCol === -1) { return -1; }
  for (var r = 1; r < values.length; r++) {
    if (normPromoCode_(values[r][cCol]) === want) { return r + 1; }
  }
  return -1;
}

/* Validate a code WITHOUT redeeming. Returns
   {valid:false, reason} or {valid:true, promo:{code,kind,label}}. */
function promoStatus_(code) {
  var want = normPromoCode_(code);
  if (!want) { return { valid: false, reason: 'empty' }; }
  var sh = sheetOrCreate_(TABS.PROMOS || 'Promos');
  var rows = readTab_(TABS.PROMOS || 'Promos');
  for (var i = 0; i < rows.length; i++) {
    if (normPromoCode_(rows[i].code) !== want) { continue; }
    var p = rows[i];
    if (!isTrue_(p.active)) { return { valid: false, reason: 'inactive' }; }
    var max = Number(p.maxRedemptions) || 0;
    var used = Number(p.redeemed) || 0;
    if (max > 0 && used >= max) { return { valid: false, reason: 'used_up' }; }
    return {
      valid: true,
      promo: { code: want, kind: String(p.kind || 'comp'), label: String(p.label || '') }
    };
  }
  return { valid: false, reason: 'not_found' };
}

/* Increment a code's redeemed count by 1 (best-effort). */
function promoRedeemInc_(code) {
  var sh = sheetOrCreate_(TABS.PROMOS || 'Promos');
  var rn = promoRowNum_(sh, code);
  if (rn === -1) { return; }
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  var rCol = head.indexOf('redeemed');
  if (rCol === -1) { return; }
  var cell = sh.getRange(rn, rCol + 1);
  cell.setValue((Number(cell.getValue()) || 0) + 1);
}

/* {type:'promoCheck', code} — public token. Live validation for the
   signup page so the customer sees "code applied" before submitting.
   Never redeems; redemption happens only when the site is created. */
function handlePromoCheck_(body) {
  var st = promoStatus_(String(body.code || ''));
  if (!st.valid) { return jsonOut_({ ok: true, valid: false, reason: st.reason }); }
  return jsonOut_({ ok: true, valid: true, promo: st.promo });
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

/* v4: like sheet_() but self-heals — creates the tab with its
   headers if it's missing, so sendMail/salonStatus keep working
   even if setup() wasn't re-run after upgrading to v4. */
function sheetOrCreate_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (sh) { return sh; }
  sh = ss.insertSheet(name);
  var want = HEADERS[name] || [];
  if (want.length) {
    sh.getRange(1, 1, 1, want.length).setValues([want]);
    sh.setFrozenRows(1);
  }
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

/* v6.1: hyphen-insensitive slug lookup for subdomain URLs.
   'calicuts' matches stored slug 'cali-cuts' — but ONLY when exactly
   one stored slug compacts to the requested form. Ambiguity -> null. */
function findSalonRowCompact_(slugRaw) {
  var want = String(slugRaw || '').toLowerCase().replace(/-/g, '');
  if (!want) { return null; }
  var sh = sheet_(TABS.SALONS);
  var cols = headerCols_(sh);
  if (!cols.slug) { return null; }
  var values = sh.getDataRange().getValues();
  var hit = null, hits = 0;
  for (var r = 1; r < values.length; r++) {
    var stored = String(values[r][cols.slug - 1]).trim().toLowerCase();
    if (stored && stored.replace(/-/g, '') === want) {
      hits++;
      hit = { sheet: sh, rowNum: r + 1, cols: cols, row: values[r] };
    }
  }
  return hits === 1 ? hit : null;
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
  /* v6.2: uniqueness now ALSO covers the hyphen-stripped (subdomain)
     form, so no two salons ever compact to the same pretty URL —
     'cali-cuts' taken means 'calicu-ts'/'calicuts' are taken too. */
  var existing = {}, compact = {};
  readTab_(TABS.SALONS).forEach(function (s) {
    var v = String(s.slug || '').trim();
    if (v) { existing[v] = true; compact[v.replace(/-/g, '')] = true; }
  });
  function taken(c) { return existing[c] || compact[String(c).replace(/-/g, '')]; }
  if (!taken(base)) { return base; }
  for (var n = 2; n < 1000; n++) {
    var candidate = base + '-' + n;
    if (!taken(candidate)) { return candidate; }
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
  /* v5: readTab_ is header-driven, so the new deletedAt / prevStatus
     / archivedAt columns ride along automatically in every salon
     object the portal receives — no change needed here. */
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
    /* v6.1: subdomain URLs drop the hyphen (calicuts.salonvine.com
       -> slug 'cali-cuts'), so if the exact slug misses, retry
       hyphen-insensitively. Only a UNIQUE match counts — an
       ambiguous compact form stays 'not found' rather than guessing. */
    if (!found) { found = findSalonRowCompact_(slug); }
  } catch (err) {
    return jsonOut_({ error: 'not found' });
  }
  if (!found) { return jsonOut_({ error: 'not found' }); }

  /* v5: this public gate is UNCHANGED — it already serves ONLY
     status 'live-free' / 'live', so archive (status 'archived')
     and trash (status 'trashed') rows are automatically excluded
     from the public site with no extra check needed. */
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

  /* ONLY public fields — no plan, no status, no email, no phone.
     v6.1: return the CANONICAL stored slug (not the raw input) so a
     subdomain visitor's bookings post against the real row. */
  return jsonOut_({
    ok: true,
    slug: String(salonCell_(found, 'slug') || slug),
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
     {type:'findSite'}     signup token or full token   (v3)
     {type:'signupStatus'} full token only              (v1)
     {type:'salon'}        full token only              (v1)
     {type:'salonConfig'}  full token only              (v3)
     {type:'sendMail'}     full token only              (v4)
     {type:'salonPlan'}    full token only              (v4)
     {type:'salonStatus'}  full token only              (v4)
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
  if (type === 'signup' || type === 'signupSite' || type === 'sitePhoto' || type === 'siteLead' || type === 'findSite' || type === 'promoCheck') {
    if (!isPublicWriteToken_(token)) {
      return jsonOut_({ error: 'Unauthorized' });
    }
    try {
      if (type === 'signup') { return handleSignup_(body); }
      if (type === 'signupSite') { return handleSignupSite_(body); }
      if (type === 'sitePhoto') { return handleSitePhoto_(body); }
      if (type === 'siteLead') { return handleSiteLead_(body); }
      if (type === 'findSite') { return handleFindSite_(body); }
      if (type === 'promoCheck') { return handlePromoCheck_(body); }
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
  try {
    if (type === 'signupStatus') { return handleSignupStatus_(body); }
    if (type === 'salon') { return handleSalonUpsert_(body); }
    if (type === 'salonConfig') { return handleSalonConfig_(body); }
    /* v4 */
    if (type === 'sendMail') { return handleSendMail_(body); }
    if (type === 'salonPlan') { return handleSalonPlan_(body); }
    if (type === 'salonStatus') { return handleSalonStatus_(body); }

    /* v5 — Archive + Trash lifecycle (full token; api.js injects actor) */
    if (type === 'salonArchive') { return handleSalonArchive_(body); }
    if (type === 'salonTrash') { return handleSalonTrash_(body); }
    if (type === 'salonRestore') { return handleSalonRestore_(body); }

    /* v4 — owner edit/delete (full token; api.js injects actor).
       {type:'salonDelete'} stays the HARD purge (deletes the row) —
       the portal now routes its two-step "Delete permanently now"
       button here, from the Trash section only. */
    if (type === 'salonDelete') { return handleSalonDelete_(body); }
    if (type === 'salonEdit') { return handleSalonEdit_(body); }
    if (type === 'signupDelete') { return handleSignupDelete_(body); }
    if (type === 'leadDelete') { return handleLeadDelete_(body); }
    if (type === 'revenueSet') { return handleRevenueSet_(body); }
    if (type === 'revenueDelete') { return handleRevenueDelete_(body); }
  } catch (err3) {
    return jsonOut_({ error: 'Server error: ' + (err3 && err3.message ? err3.message : err3) });
  }

  return jsonOut_({ error: 'Unknown type: ' + type });
}

/* ============================================================
   v4 — {type:'sendMail'} — FULL token only (gated in doPost).
   Mail/SMS relay so the Netlify app site needs no SMTP creds:
   everything sends as the executing Google account.

   Body (either or both):
     to, subject, text        -> one email
     sms:{phone}, text        -> the text is sent to all 4 US
                                 carrier email-to-text gateways
                                 (blank subject; the carrier that
                                 owns the number delivers it, the
                                 rest bounce silently)

   Every attempted send is appended to the MailLog tab
   (ts, to, kind:'email'|'sms', subject, ok:true/false).
   Returns {ok:true, sent:{email?, sms?}} or {error}.
   ============================================================ */
function handleSendMail_(body) {
  var text = String(body.text || '').trim();
  if (!text) { return jsonOut_({ error: 'Need text' }); }

  var to = String(body.to || '').trim();
  var sms = (body.sms && typeof body.sms === 'object') ? body.sms : null;
  var phone = sms ? normalizePhone_(String(sms.phone || '')) : '';

  if (!to && !sms) { return jsonOut_({ error: 'Need to (email) and/or sms:{phone}' }); }
  if (to && !isValidEmail_(to)) { return jsonOut_({ error: 'Invalid email: ' + to }); }
  if (sms && !phone) { return jsonOut_({ error: 'Invalid sms phone — need a 10-digit US number' }); }

  var sent = {};

  /* ---- email leg ---- */
  if (to) {
    var subject = String(body.subject || '').trim().slice(0, MAX_MAIL_SUBJECT_CHARS) || 'Salon Vine';
    var emailText = text.slice(0, MAX_MAIL_TEXT_CHARS);
    var emailOk = true;
    try {
      MailApp.sendEmail(to, subject, emailText);
    } catch (errMail) {
      emailOk = false;
      console.error('sendMail email failed for ' + to + ': ' + errMail);
    }
    logMail_(to, 'email', subject, emailOk);
    sent.email = emailOk;
    if (!emailOk && !sms) { return jsonOut_({ error: 'Email send failed' }); }
  }

  /* ---- sms leg (carrier gateways) ---- */
  if (sms) {
    var smsText = text.slice(0, MAX_SMS_TEXT_CHARS);
    var okCount = 0;
    SMS_GATEWAYS.forEach(function (gw) {
      var addr = phone + '@' + gw;
      var gwOk = true;
      try {
        /* blank subject — carriers show subject inline otherwise */
        MailApp.sendEmail(addr, '', smsText);
      } catch (errSms) {
        gwOk = false;
        console.error('sendMail sms failed for ' + addr + ': ' + errSms);
      }
      logMail_(addr, 'sms', '', gwOk);
      if (gwOk) { okCount++; }
    });
    sent.sms = okCount;
    if (okCount === 0 && !to) { return jsonOut_({ error: 'SMS send failed' }); }
  }

  return jsonOut_({ ok: true, sent: sent });
}

function isValidEmail_(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}

/* Strip formatting; accept 10-digit US numbers, or 11 digits
   with a leading 1. Returns the bare 10 digits or ''. */
function normalizePhone_(raw) {
  var digits = String(raw || '').replace(/\D+/g, '');
  if (digits.length === 11 && digits.charAt(0) === '1') { digits = digits.slice(1); }
  return digits.length === 10 ? digits : '';
}

function logMail_(to, kind, subject, ok) {
  try {
    appendByHeaders_(sheetOrCreate_(TABS.MAILLOG), {
      ts: new Date().toISOString(),
      to: to,
      kind: kind,
      subject: subject,
      ok: ok
    });
  } catch (err) {
    console.error('MailLog append failed: ' + err);
  }
}

/* ============================================================
   v4 — {type:'salonPlan'} — FULL token only (gated in doPost).
   {slug} -> {ok, slug, plan, status} straight from the Salons
   sheet. The app site uses this to enforce seat limits
   (studio 3 / pro 10 / elite unlimited) server-side.
   ============================================================ */
function handleSalonPlan_(body) {
  var slug = String(body.slug || '').trim().toLowerCase();
  if (!slug) { return jsonOut_({ error: 'Need slug' }); }

  var found = findSalonRow_(slug);
  if (!found) { return jsonOut_({ error: 'Unknown site: ' + slug }); }

  return jsonOut_({
    ok: true,
    slug: slug,
    plan: salonCell_(found, 'plan'),
    status: salonCell_(found, 'status')
  });
}

/* ============================================================
   v4 — {type:'salonStatus'} — FULL token only (gated in doPost).
   {slug, status} -> updates the salon row's status cell (for
   future suspend/reactivate) and appends the transition to the
   StatusLog tab (ts, slug, old, new).
   Valid statuses: live / live-free / pending / suspended /
   cancelled. Returns {ok, slug, old, new}.
   ============================================================ */
function handleSalonStatus_(body) {
  var slug = String(body.slug || '').trim().toLowerCase();
  var status = String(body.status || '').trim().toLowerCase();
  if (!slug) { return jsonOut_({ error: 'Need slug' }); }
  if (VALID_SALON_STATUSES.indexOf(status) === -1) {
    return jsonOut_({ error: 'Invalid status — use one of: ' + VALID_SALON_STATUSES.join('/') });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var found = findSalonRow_(slug);
    if (!found) { return jsonOut_({ error: 'Unknown site: ' + slug }); }
    if (!found.cols.status) { return jsonOut_({ error: 'Salons tab missing status header — run setup()' }); }

    var old = salonCell_(found, 'status');
    found.sheet.getRange(found.rowNum, found.cols.status).setValue(status);

    try {
      appendByHeaders_(sheetOrCreate_(TABS.STATUSLOG), {
        ts: new Date().toISOString(),
        slug: slug,
        old: old,
        'new': status
      });
    } catch (errLog) {
      console.error('StatusLog append failed: ' + errLog);
    }

    return jsonOut_({ ok: true, slug: slug, old: old, 'new': status });
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
    /* v5: UNCHANGED — only 'live-free' / 'live' are eligible, so
       archived ('archived') and trashed ('trashed') sites are
       auto-excluded from find-my-salon. */
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

/* v4.1: after any signupSite, tell the multi-tenant app to provision the
   owner account + send the portal invite. Never allowed to fail a signup. */
function provisionOwner_(salon, name, email, phone, slug, url) {
  try {
    UrlFetchApp.fetch('https://salonvine-app.netlify.app/.netlify/functions/provision-owner', {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify({
        token: fullToken_(),
        salon: salon, name: name, email: email, phone: phone,
        slug: slug, url: url
      })
    });
  } catch (e) { /* best-effort */ }
}

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
          provisionOwner_(String(body.salon || ''), String(body.name || ''), email, String(body.phone || ''), String(s.slug), String(s.url || (PUBLIC_SITE_BASE + s.slug)));
          return jsonOut_({ ok: true, id: '', slug: String(s.slug), url: String(s.url || (PUBLIC_SITE_BASE + s.slug)), existing: true });
        }
      }
    }

    /* v6: promo code (optional). A valid comp code makes this salon
       free-forever and records the code; an invalid/blank code is
       ignored (the site is still created — comp just doesn't apply). */
    var promoIn = normPromoCode_(body.promo);
    var promoApplied = '';
    var comped = false;
    if (promoIn) {
      var pst = promoStatus_(promoIn);
      if (pst.valid && pst.promo.kind === 'comp') {
        promoApplied = pst.promo.code;
        comped = true;
      }
    }

    /* 1) the lead row + owner email (dedupe-aware) */
    var su = signupCore_(body, now);

    /* 2) the live salon row */
    var slug = uniqueSlug_(slugify_(body.slug || body.salon));
    var url = publicUrlFor_(slug); /* v6.2: subdomain URL when enabled */
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
    if (comped) { config.comped = true; config.promo = promoApplied; }
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
      createdAt: now.toISOString(),
      promo: promoApplied,
      comp: comped ? 'TRUE' : ''
    });

    /* v6: count the redemption only after the row is safely written. */
    if (comped) { try { promoRedeemInc_(promoApplied); } catch (ePromo) {} }

    provisionOwner_(String(body.salon || ''), String(body.name || ''), email, String(body.phone || ''), slug, url);
    return jsonOut_({ ok: true, id: su.id, slug: slug, url: url, comped: comped, promo: promoApplied });
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

/* ============================================================
   v4 OWNER EDIT/DELETE handlers (merged from parent session)
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

  /* v5: lifecycle statuses are OWNED by the dedicated Archive /
     Delete / Restore buttons, never set through a free-form edit —
     reject them so an edit can't sneak a row into a lifecycle state
     without writing the archivedAt/deletedAt markers membership
     depends on. live-free / live / demo / cancelled stay editable. */
  if (fields.status !== undefined) {
    var stEdit = String(fields.status).trim().toLowerCase();
    if (stEdit === 'archived' || stEdit === 'trashed' || stEdit === 'deleted') {
      return jsonOut_({ error: 'Status "' + stEdit + '" is set via the Archive / Delete buttons, not edit' });
    }
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

/* ============================================================
   v5 — Archive + 30-day-Trash lifecycle
   ============================================================
   All membership is decided by MARKER COLUMNS, never by status
   strings. The pure helpers below (no Apps Script services) are
   unit-tested in Node from the shipped source.
   ============================================================ */

function nowISO_() { return new Date().toISOString(); }

/* Pure: which lifecycle bucket a salon row belongs to, from its
   markers ONLY. Returns 'trash' | 'archived' | 'active'.
   - deletedAt  non-empty          -> 'trash'
   - archivedAt non-empty (no del)  -> 'archived'
   - otherwise                      -> 'active'
   Legacy rows (status archived/cancelled/junk/archived-test with
   NO markers) return 'active' — they are never auto-categorized
   and never auto-purged. */
function salonBucket_(row) {
  var del = String((row && row.deletedAt) == null ? '' : row.deletedAt).trim();
  if (del) { return 'trash'; }
  var arc = String((row && row.archivedAt) == null ? '' : row.archivedAt).trim();
  if (arc) { return 'archived'; }
  return 'active';
}

/* Pure: clamp a prevStatus to a safe restore target. Maps to one
   of live-free / live / archived, else defaults to 'live-free'.
   NEVER auto-promotes to the paid 'live' unless prevStatus was
   EXACTLY 'live'. */
function clampRestoreStatus_(prev) {
  var p = String(prev == null ? '' : prev).trim();
  if (RESTORE_TARGETS.indexOf(p) !== -1) { return p; }
  return 'live-free';
}

/* Pure: parse an ISO string, epoch-millis string/number, or Date
   into epoch millis; NaN when unparseable/empty. */
function parseWhen_(v) {
  if (v == null || v === '') { return NaN; }
  if (v instanceof Date) { var dm = v.getTime(); return isNaN(dm) ? NaN : dm; }
  var s = String(v).trim();
  if (s === '') { return NaN; }
  if (/^\d{10,}$/.test(s)) { var n = Number(s); return isNaN(n) ? NaN : n; }
  var t = new Date(s).getTime();
  return isNaN(t) ? NaN : t;
}

/* Pure: whole days remaining before a trashed row auto-purges.
   30 - floor(daysSince(deletedAt)), floored at 0. An unparseable
   deletedAt yields the full TTL (fail safe — never purge early). */
function daysLeftInTrash_(deletedAt, nowMs) {
  var w = parseWhen_(deletedAt);
  if (isNaN(w)) { return TRASH_TTL_DAYS; }
  var since = Math.floor((nowMs - w) / (24 * 60 * 60 * 1000));
  var left = TRASH_TTL_DAYS - since;
  return left < 0 ? 0 : left;
}

/* Read a whole Salons row into an object keyed by header name. */
function salonReadRecord_(sh, cols, rowNum) {
  var width = Math.max(sh.getLastColumn(), 1);
  var rowVals = sh.getRange(rowNum, 1, 1, width).getValues()[0];
  var rec = {};
  Object.keys(cols).forEach(function (h) {
    var v = rowVals[cols[h] - 1];
    rec[h] = (v instanceof Date) ? v.toISOString() : v;
  });
  return rec;
}

/* Set several cells by header name (missing headers are skipped). */
function salonSetCells_(sh, cols, rowNum, patch) {
  Object.keys(patch).forEach(function (h) {
    if (cols[h]) { sh.getRange(rowNum, cols[h]).setValue(patch[h]); }
  });
}

function lifecycleColsPresent_(cols) {
  return !!(cols.status && cols.deletedAt && cols.archivedAt && cols.prevStatus);
}

/* ------------------------------------------------------------
   {type:'salonArchive', ref} — v5, FULL token only.
   Hide the site but keep it forever. Captures prevStatus (only if
   the row isn't already archived/trashed), sets status='archived'
   + archivedAt=now, and clears any deletedAt so it leaves trash.
   ------------------------------------------------------------ */
function handleSalonArchive_(body) {
  var ref = String(body.ref || '').trim();
  if (!ref) { return jsonOut_({ error: 'Need ref (salonId or slug)' }); }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var res = resolveSalonRef_(ref);
    var refuse = refuseUnlessSingle_(res.matches, ref);
    if (refuse) { return refuse; }
    var m = res.matches[0], sh = res.sheet, cols = res.cols;
    if (!lifecycleColsPresent_(cols)) {
      return jsonOut_({ error: 'Salons tab missing lifecycle headers (status/deletedAt/archivedAt/prevStatus) — run setup()' });
    }

    var cur = salonReadRecord_(sh, cols, m.rowNum);
    var curStatus = String(cur.status == null ? '' : cur.status).trim();
    var patch = { status: 'archived', archivedAt: nowISO_(), deletedAt: '' };
    /* only capture prevStatus when not already in a lifecycle state */
    if (curStatus !== 'archived' && curStatus !== 'trashed') { patch.prevStatus = curStatus; }
    salonSetCells_(sh, cols, m.rowNum, patch);

    var rec = salonReadRecord_(sh, cols, m.rowNum);
    audit_(body, 'salonArchive', ref, { prevStatus: rec.prevStatus, status: 'archived' });
    return jsonOut_({ ok: true, salon: rec });
  } finally { lock.releaseLock(); }
}

/* ------------------------------------------------------------
   {type:'salonTrash', ref} — v5, FULL token only.
   Soft, recoverable delete. Captures prevStatus (only if the row
   isn't already trashed), sets status='trashed' + deletedAt=now,
   and clears archivedAt so it leaves the archive. Auto-purges
   after TRASH_TTL_DAYS via purgeExpiredTrash().
   ------------------------------------------------------------ */
function handleSalonTrash_(body) {
  var ref = String(body.ref || '').trim();
  if (!ref) { return jsonOut_({ error: 'Need ref (salonId or slug)' }); }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var res = resolveSalonRef_(ref);
    var refuse = refuseUnlessSingle_(res.matches, ref);
    if (refuse) { return refuse; }
    var m = res.matches[0], sh = res.sheet, cols = res.cols;
    if (!lifecycleColsPresent_(cols)) {
      return jsonOut_({ error: 'Salons tab missing lifecycle headers (status/deletedAt/archivedAt/prevStatus) — run setup()' });
    }

    var cur = salonReadRecord_(sh, cols, m.rowNum);
    var curStatus = String(cur.status == null ? '' : cur.status).trim();
    var patch = { status: 'trashed', deletedAt: nowISO_(), archivedAt: '' };
    /* only capture prevStatus when not already trashed */
    if (curStatus !== 'trashed') { patch.prevStatus = curStatus; }
    salonSetCells_(sh, cols, m.rowNum, patch);

    var rec = salonReadRecord_(sh, cols, m.rowNum);
    audit_(body, 'salonTrash', ref, { prevStatus: rec.prevStatus, status: 'trashed' });
    return jsonOut_({ ok: true, salon: rec });
  } finally { lock.releaseLock(); }
}

/* ------------------------------------------------------------
   {type:'salonRestore', ref} — v5, FULL token only.
   Bring a row back out of archive or trash: status = clamp(
   prevStatus), and clear all three markers/prevStatus so the row
   is a normal active Salon Site again.
   ------------------------------------------------------------ */
function handleSalonRestore_(body) {
  var ref = String(body.ref || '').trim();
  if (!ref) { return jsonOut_({ error: 'Need ref (salonId or slug)' }); }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var res = resolveSalonRef_(ref);
    var refuse = refuseUnlessSingle_(res.matches, ref);
    if (refuse) { return refuse; }
    var m = res.matches[0], sh = res.sheet, cols = res.cols;
    if (!lifecycleColsPresent_(cols)) {
      return jsonOut_({ error: 'Salons tab missing lifecycle headers (status/deletedAt/archivedAt/prevStatus) — run setup()' });
    }

    var cur = salonReadRecord_(sh, cols, m.rowNum);
    var restored = clampRestoreStatus_(cur.prevStatus);
    salonSetCells_(sh, cols, m.rowNum, {
      status: restored, deletedAt: '', archivedAt: '', prevStatus: ''
    });

    var rec = salonReadRecord_(sh, cols, m.rowNum);
    audit_(body, 'salonRestore', ref, { from: cur.prevStatus, status: restored });
    return jsonOut_({ ok: true, salon: rec });
  } finally { lock.releaseLock(); }
}

/* ------------------------------------------------------------
   purgeExpiredTrash() — time-driven (installPurgeTrigger). Hard-
   deletes any Salons row whose deletedAt is older than
   TRASH_TTL_DAYS. Iterates DESCENDING so deleteRow never shifts a
   row we haven't visited yet. Each purge is audited as 'autoPurge'.
   ------------------------------------------------------------ */
function purgeExpiredTrash() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = sheet_(TABS.SALONS);
    var cols = headerCols_(sh);
    if (!cols.deletedAt) { return; } /* pre-migration sheet: nothing to purge */

    var values = sh.getDataRange().getValues();
    var nowMs = Date.now();
    var CUTOFF_MS = TRASH_TTL_DAYS * 24 * 60 * 60 * 1000;

    for (var r = values.length - 1; r >= 1; r--) {
      var w = parseWhen_(values[r][cols.deletedAt - 1]);
      if (isNaN(w)) { continue; }              /* not in trash / unparseable */
      if ((nowMs - w) <= CUTOFF_MS) { continue; } /* still within its 30 days */

      var slug = cols.slug ? String(values[r][cols.slug - 1]).trim() : '';
      var salonId = cols.salonId ? String(values[r][cols.salonId - 1]).trim() : '';
      var purged = {
        salonId: salonId,
        slug: slug,
        name: cols.name ? String(values[r][cols.name - 1]) : '',
        deletedAt: String(values[r][cols.deletedAt - 1])
      };
      sh.deleteRow(r + 1);
      audit_({ actor: 'system:purgeExpiredTrash' }, 'autoPurge', slug || salonId, purged);
    }
  } finally { lock.releaseLock(); }
}

/* ------------------------------------------------------------
   installPurgeTrigger() — run ONCE in the Apps Script editor after
   deploying v5. Removes any existing purgeExpiredTrash triggers,
   then installs a daily time-driven trigger at ~04:00.
   ------------------------------------------------------------ */
function installPurgeTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'purgeExpiredTrash') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('purgeExpiredTrash').timeBased().everyDays(1).atHour(4).create();
}
