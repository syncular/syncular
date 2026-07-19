# Privacy

Syncular does not use analytics cookies, fingerprint visitors, or create user
profiles. The documentation site records privacy-conscious, aggregate traffic
and reading signals in Cloudflare Workers Analytics Engine so the maintainers
can understand which documentation and articles are useful.

For an HTML page request, the analytics dataset stores the page path, referring
hostname (never the referring URL), two-letter country code, broad device class,
HTTP status, site section, Cloudflare cache outcome, and sanitized
`utm_source`, `utm_medium`, and `utm_campaign` values. It does **not** store IP
addresses, full user-agent strings, cookies, account IDs, or any other stable
visitor identifier.

On individual blog posts, a small same-origin script sends one `article_read`
event only after the page has been visible for at least 30 seconds and the
visitor has reached at least 60% of the page. That event contains the article
path, active time, maximum scroll depth, referring hostname, broad device class,
country code, and campaign values. It cannot be linked to a particular person
or to another visit.

The site honors the browser's Global Privacy Control (`Sec-GPC: 1`) and Do Not
Track (`DNT: 1`) signals by writing no analytics event. Analytics data stays in
the Syncular Cloudflare account and is retained by Analytics Engine for three
months. Cloudflare still processes network information needed to deliver and
protect the site under its own privacy terms, independently of this analytics
dataset.
