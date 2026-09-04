// netlify/functions/domains-sweep.js
//
// Gives every salon its own web address, automatically.
//
// A salon signs up -> within a few minutes <theirname>.salonvine.com works.
// Nobody adds anything by hand, ever.
//
// How it works: this reads the salon list, compares it to the addresses
// registered on the Netlify project, and adds any that are missing.
// It ONLY adds. It never removes an address, so a bad read can't take a
// salon offline.
//
// It is safe to run over and over — if there's nothing to add, it does nothing.

const NETLIFY_API = 'https://api.netlify.com/api/v1';

// Names that must never be handed to a salon.
const RESERVED = new Set([
  'www', 'app', 'portal', 'mail', 'api', 'admin', 'salonvine',
  'send', 'rsend', 'ftp', 'dev', 'staging', 'test', 'blog', 'help', 'support',
]);

const ROOT = 'salonvine.com';
const MAX_PER_RUN = 10;   // gentle: don't add fifty addresses in one go

// A salon's slug is hyphenated ("lets-try-again-hair"). The address drops the
// hyphens ("letstryagainhair.salonvine.com"). The site matches them back up
// hyphen-insensitively, so both spellings find the same salon.
function slugToHost(slug) {
  const label = String(slug || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-/g, '');
  if (!label || label.length > 63) return null;
  if (RESERVED.has(label)) return null;
  return `${label}.${ROOT}`;
}

async function netlify(path, options = {}) {
  const res = await fetch(`${NETLIFY_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.NETLIFY_AUTH_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Netlify ${path} -> ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// The salon list is public information — it's what every salon page already
// reads — so this uses the publishable key, not a secret one. Nothing here
// needs privileged access to the database.
const SUPABASE_URL = 'https://zdlytaswwvemnlgnonnd.supabase.co';
const SUPABASE_PUBLISHABLE = 'sb_publishable_RWlZ237RfOdorUJycQs2JQ_pFHiGjMX';

async function listSalons() {
  const url = `${SUPABASE_URL}/rest/v1/salon?select=name,slug,status&order=name`;
  const res = await fetch(url, { headers: { apikey: SUPABASE_PUBLISHABLE } });
  if (!res.ok) throw new Error(`Supabase salons -> ${res.status}: ${await res.text()}`);
  return res.json();
}

export default async function handler() {
  const need = ['NETLIFY_AUTH_TOKEN', 'NETLIFY_SITE_ID'];
  for (const k of need) {
    if (!process.env[k]) {
      console.log(`domains-sweep: ${k} not set — doing nothing.`);
      return new Response(`missing ${k}`, { status: 200 });
    }
  }

  let salons, site;
  try {
    [salons, site] = await Promise.all([
      listSalons(),
      netlify(`/sites/${process.env.NETLIFY_SITE_ID}`),
    ]);
  } catch (e) {
    console.error('domains-sweep: could not read state —', e.message);
    return new Response('read failed', { status: 200 });
  }

  const existing = new Set([
    ...(site.domain_aliases || []),
    site.custom_domain,
  ].filter(Boolean).map(d => d.toLowerCase()));

  const wanted = [];
  for (const s of salons) {
    // Don't hand out an address for a salon that isn't live.
    if (s.status && String(s.status).startsWith('deleted')) continue;
    const host = slugToHost(s.slug);
    if (!host) {
      console.log(`domains-sweep: skipping "${s.name}" — slug "${s.slug}" is reserved or unusable.`);
      continue;
    }
    if (!existing.has(host)) wanted.push({ host, name: s.name });
  }

  if (!wanted.length) {
    console.log(`domains-sweep: all ${salons.length} salons already have an address.`);
    return new Response('nothing to do', { status: 200 });
  }

  const batch = wanted.slice(0, MAX_PER_RUN);
  const aliases = [...(site.domain_aliases || []), ...batch.map(b => b.host)];

  try {
    await netlify(`/sites/${process.env.NETLIFY_SITE_ID}`, {
      method: 'PATCH',
      body: JSON.stringify({ domain_aliases: aliases }),
    });
  } catch (e) {
    console.error('domains-sweep: could not add addresses —', e.message, JSON.stringify(e.data || {}));
    return new Response('patch failed', { status: 200 });
  }

  for (const b of batch) console.log(`domains-sweep: ${b.name} is now live at https://${b.host}`);
  const line = `domains-sweep: added ${batch.length}, ${wanted.length - batch.length} still queued`;
  console.log(line);
  return new Response(line, { status: 200 });
}
