# Privacy

This page is for visitors to syncular.dev and states what the documentation site
records about them. The site does not use analytics cookies, fingerprint visitors, or create user
profiles. The documentation site records aggregate traffic
and reading signals in Cloudflare Workers Analytics Engine and Cloudflare Web
Analytics so the maintainers can understand which documentation and articles
are useful.

::meta{for="Visitors to syncular.dev" time="1 minute"}

For an HTML page request, the analytics dataset stores the page path, referring
hostname (never the referring URL), two-letter country code, broad device class,
HTTP status, site section, Cloudflare cache outcome, and sanitized
`utm_source`, `utm_medium`, and `utm_campaign` values. It does not store IP
addresses, full user-agent strings, cookies, account IDs, or any other stable
visitor identifier.

On individual blog posts, a small same-origin script sends one `article_read`
event only after the page has been visible for at least 30 seconds and the
visitor has reached at least 60% of the page. That event contains the article
path, active time, maximum scroll depth, referring hostname, broad device class,
country code, and campaign values. It cannot be linked to a particular person
or to another visit.

Pages on syncular.dev, including the sync lab at `/demo/`, load the Cloudflare
Web Analytics beacon from `static.cloudflareinsights.com`. For each page and
each in-site navigation it reports the page URL, the referrer, the browser's
user agent, and page-load timings (Core Web Vitals) to Cloudflare, which
aggregates them into visit and performance counts. Cloudflare states that Web
Analytics sets no cookies, uses no local storage, and does not fingerprint
visitors. See
[Cloudflare's Web Analytics documentation](https://developers.cloudflare.com/web-analytics/about/)
for how Cloudflare processes that data.

The site honors the browser's Global Privacy Control (`Sec-GPC: 1`) and Do Not
Track (`DNT: 1`) signals by writing no analytics event and not loading the Web Analytics beacon. Analytics data stays in
the Syncular Cloudflare account and is retained by Analytics Engine for three
months. Cloudflare still processes network information needed to deliver and
protect the site under its own privacy terms, independently of this analytics
dataset.
