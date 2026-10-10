# LLMs

This page is for people who point a language model at the Syncular docs: coding
agents, editor assistants, and retrieval pipelines. It lists the machine-readable
entry points the build generates and what each one contains.

::meta{for="Developers using agents or retrieval over the docs" time="2 minutes"}

:::terms
- **`llms.txt`**: A generated Markdown index of every docs page, with a link to each page's Markdown copy.
- **Markdown mirror**: The page's Markdown source served at `/<slug>.md`.
- **Docs index**: `/.well-known/docs-index.json`, the machine-readable list of the same pages.
:::

## Entry points

The build (`apps/docs/scripts/agent-assets.mjs`) generates these from the docs
and blog sources, so they track `main`:

| URL | Contents |
|---|---|
| [`/llms.txt`](https://syncular.dev/llms.txt) | An index of every page: title, canonical URL, and Markdown URL. It links to the pages and holds none of their text. |
| `/<slug>.md` | The Markdown source of one page, with a `Canonical` comment on the first line. `/index.md` is the landing page and `/blog.md` lists the blog posts. |
| `/.well-known/docs-index.json` | The page list as JSON: `title`, `path`, and `markdown` for each page. |
| `/sitemap.xml`, `/robots.txt` | The sitemap with a `lastmod` per page, and a robots file that allows all agents. |
| `/.well-known/api-catalog` | An RFC 9727 API catalog that points at the discovery endpoints. |
| `/.well-known/openapi.json` | An OpenAPI description of the public discovery endpoints. |
| `/.well-known/agent-skills/index.json` | An Agent Skills index with one skill, `syncular-docs`, that explains how to navigate the docs. |
| `/auth.md`, OAuth metadata under `/.well-known/` | How an agent gets anonymous read access to the public docs. The token grants access to public documentation only. |
| `/.well-known/mcp/server-card.json` | A card for the browser WebMCP tools. |

## Fetching Markdown

Send `Accept: text/markdown` to any public HTML page and the Worker returns
the generated Markdown copy of that page, with an `x-markdown-tokens` header
that estimates its size and `Vary: Accept` set. The same Markdown is available
at the `.md` URL without content negotiation.

The site also registers WebMCP tools in the browser when
`navigator.modelContext` exists: `syncular_list_docs`, `syncular_search_docs`,
`syncular_get_page_markdown`, and `syncular_open_doc`.

## Source of truth

For protocol claims, cite [`docs/SPEC.md`](https://github.com/syncular/syncular/blob/main/docs/SPEC.md) and the [specifications and packages page](/reference/). The repository root also carries
[`AGENTS.md`](https://github.com/syncular/syncular/blob/main/AGENTS.md), the
instructions that agents and humans follow when they change Syncular itself.
Contribution rules for model-assisted pull requests are on
[Contributing](/contributing/#llm-assistance).

How Syncular's maintainer uses models, and why the project's checks make that
safe, is the blog post
[Model-Written Code Needs a Repository That Checks Itself](/blog/two-cores-check-llm-code/).
