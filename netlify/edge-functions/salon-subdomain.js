/* Pretty client URLs — wildcard subdomain router (v6.2).
   <name>.salonvine.com/ serves that salon's site: rewrite the root
   request to /site.html, which reads the salon from the hostname
   (subdomainSlug) and the backend matches it hyphen-insensitively
   (calicuts -> cali-cuts). Reserved hosts and the bare/apex domain
   pass straight through to the marketing site. Runs only on path "/"
   (configured in netlify.toml), so assets and deep paths are untouched. */
const RESERVED = new Set(['www', 'portal', 'app', 'mail', 'api', 'admin', 'salonvine']);

export default async (request, context) => {
  /* Fail OPEN: any error here must never take down the marketing
     homepage — fall through to normal serving (index.html carries a
     JS fallback that still hands salon subdomains to site.html). */
  try {
    const host = new URL(request.url).hostname.toLowerCase();
    const m = host.match(/^([a-z0-9-]+)\.salonvine\.com$/);
    if (!m || RESERVED.has(m[1])) return context.next();
    return context.rewrite('/site.html');
  } catch (e) {
    return context.next();
  }
};
