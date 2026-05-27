import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Syncular — Local-first sync framework',
  description:
    'Syncular is a type-safe sync framework for local-first apps. A Rust runtime owns SQLite on the client. An immutable commit log carries every change to every peer.',
};

const features = [
  {
    title: 'Local-first',
    body: 'Reads hit a Rust-owned SQLite database in under a millisecond. The network is recovery, not the hot path.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
        <rect
          x="3"
          y="3"
          width="14"
          height="14"
          stroke="currentColor"
          strokeWidth="1"
          rx="1"
        />
        <line
          x1="3"
          y1="7"
          x2="17"
          y2="7"
          stroke="currentColor"
          strokeWidth="1"
        />
      </svg>
    ),
  },
  {
    title: 'Commit-log sync',
    body: "Append-only on the server. Clients fetch what they haven't seen. Causality is preserved by construction.",
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
        <line
          x1="4"
          y1="10"
          x2="16"
          y2="10"
          stroke="currentColor"
          strokeWidth="1"
        />
        <circle cx="4" cy="10" r="2" fill="currentColor" />
        <circle cx="10" cy="10" r="2" fill="currentColor" />
        <circle cx="16" cy="10" r="2" fill="currentColor" />
      </svg>
    ),
  },
  {
    title: 'Scoped auth',
    body: 'Every change is tagged with key-value scopes. Every pull is filtered by what the actor is allowed to see.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
        <path d="M3 5 L17 5 L10 17 Z" stroke="currentColor" strokeWidth="1" />
      </svg>
    ),
  },
  {
    title: 'Typed queries',
    body: 'Kysely on JavaScript. Diesel on Rust. The schema is the contract; the compiler is the auditor.',
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
        <path
          d="M4 6 L16 6 M4 10 L12 10 M4 14 L8 14"
          stroke="currentColor"
          strokeWidth="1"
        />
      </svg>
    ),
  },
];

const flow = [
  {
    step: '01 · WRITE',
    title: 'Local SQLite',
    body: 'Mutation lands. UI re-renders in the same tick.',
  },
  {
    step: '02 · PUSH',
    title: 'Outbox flushes',
    body: 'Rust runtime drains over HTTP. Server validates.',
  },
  {
    step: '03 · LOG',
    title: 'Commit appended',
    body: 'Tagged with scopes. Canonical, replayable, durable.',
  },
  {
    step: '04 · PULL',
    title: 'Peers wake',
    body: "WebSocket nudges. Peers pull what's new.",
  },
];

const GITHUB_URL = 'https://github.com/syncular/syncular';

export default function Landing() {
  return (
    <main className="landing relative">
      <header className="landing-nav sticky top-0 z-30 backdrop-blur-xl backdrop-saturate-150">
        <div className="max-w-[1100px] mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <svg
              width="18"
              height="18"
              viewBox="0 0 32 32"
              fill="none"
              className="text-[var(--landing-ink)]"
            >
              <circle
                cx="16"
                cy="16"
                r="14"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <circle cx="16" cy="16" r="3" fill="currentColor" />
            </svg>
            <span className="text-[15px] font-medium tracking-tight">
              Syncular
            </span>
          </Link>
          <nav className="hidden md:flex items-center gap-7 text-[13px] text-[var(--landing-muted)]">
            <a href="#features" className="hover:text-[var(--landing-ink)]">
              Features
            </a>
            <a href="#how" className="hover:text-[var(--landing-ink)]">
              How it works
            </a>
            <a href="#code" className="hover:text-[var(--landing-ink)]">
              Code
            </a>
            <Link href="/start" className="hover:text-[var(--landing-ink)]">
              Docs
            </Link>
          </nav>
          <div className="flex items-center gap-2 text-[13px]">
            <a
              href={GITHUB_URL}
              className="text-[var(--landing-muted)] hover:text-[var(--landing-ink)] px-3 py-1.5"
              rel="noreferrer"
              target="_blank"
            >
              GitHub
            </a>
            <Link
              href="/start"
              className="bg-white text-black font-medium rounded-md px-3.5 py-1.5 hover:bg-neutral-200 transition-colors"
            >
              Get started
            </Link>
          </div>
        </div>
      </header>

      <section className="relative overflow-hidden">
        <div className="absolute inset-0 landing-dot-grid opacity-60" />
        <div className="absolute inset-x-0 bottom-0 h-40 landing-gradient-fade" />
        <div className="max-w-[1100px] mx-auto px-6 pt-28 pb-24 relative">
          <div className="max-w-2xl">
            <div className="landing-pill rounded-full inline-flex items-center gap-2 px-2.5 py-1 text-[12px] text-[var(--landing-muted)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#9a9a9a]" />
              <span className="landing-mono">v0.x</span>
              <span className="text-[var(--landing-dim)]">·</span>
              <span>Local-first sync framework</span>
            </div>

            <h1 className="text-5xl md:text-[68px] leading-[1.02] tracking-tight mt-7 font-medium">
              Sync, without
              <br />
              <span className="text-[var(--landing-muted)]">the orbit.</span>
            </h1>

            <p className="mt-7 text-[17px] text-[var(--landing-muted)] leading-relaxed max-w-xl">
              Syncular is a type-safe sync framework for local-first apps. A
              Rust runtime owns SQLite on the client. An immutable commit log
              carries every change to every peer. Reads are local. Writes are
              durable.
            </p>

            <div className="mt-9 flex items-center gap-2.5">
              <Link
                href="/start"
                className="bg-white text-black font-medium rounded-md px-4 py-2.5 text-[13px] hover:bg-neutral-200 transition-colors"
              >
                Get started →
              </Link>
              <a
                href="#code"
                className="bg-transparent text-[var(--landing-ink)] border border-[var(--landing-line-2)] rounded-md px-4 py-2.5 text-[13px] hover:border-neutral-500 transition-colors"
              >
                View code
              </a>
            </div>

            <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2 text-[12px] text-[var(--landing-dim)] landing-mono">
              <span>Apache 2.0</span>
              <span>·</span>
              <span>Postgres + SQLite</span>
              <span>·</span>
              <span>React, Solid, Rust</span>
              <span>·</span>
              <span>Self-hosted</span>
            </div>
          </div>

          <div className="absolute right-0 top-32 hidden lg:block w-[400px] h-[400px]">
            <div className="absolute inset-0 landing-dot-grid opacity-40" />
            <div className="landing-orbit-ring" />
            <div className="landing-orbit-ring landing-orbit-ring--inner" />
            <div className="landing-orbit-core" />
            <div className="landing-orbit-dot" />
            <div className="landing-orbit-dot landing-orbit-dot--inner" />
          </div>
        </div>
      </section>

      <section id="features" className="border-t border-[var(--landing-line)]">
        <div className="max-w-[1100px] mx-auto px-6 py-24">
          <div className="grid md:grid-cols-[280px_1fr] gap-12">
            <div>
              <div className="landing-mono text-[11px] tracking-[0.18em] uppercase text-[var(--landing-dim)]">
                §01 — Primitives
              </div>
              <h2 className="text-3xl md:text-4xl mt-3 leading-[1.1] font-medium">
                Small surface.
                <br />
                <span className="text-[var(--landing-muted)]">
                  Large guarantees.
                </span>
              </h2>
            </div>
            <div className="grid sm:grid-cols-2 gap-px bg-[var(--landing-line)] border border-[var(--landing-line)]">
              {features.map((f) => (
                <div
                  key={f.title}
                  className="bg-[var(--landing-bg)] p-7 text-[var(--landing-ink)]"
                >
                  {f.icon}
                  <h3 className="text-[17px] font-medium mt-5">{f.title}</h3>
                  <p className="text-[14px] text-[var(--landing-muted)] mt-2 leading-relaxed">
                    {f.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="code" className="border-t border-[var(--landing-line)]">
        <div className="max-w-[1100px] mx-auto px-6 py-24">
          <div className="grid md:grid-cols-[280px_1fr] gap-12 items-start">
            <div>
              <div className="landing-mono text-[11px] tracking-[0.18em] uppercase text-[var(--landing-dim)]">
                §02 — Specimen
              </div>
              <h2 className="text-3xl md:text-4xl mt-3 leading-[1.1] font-medium">
                One component.
                <br />
                <span className="text-[var(--landing-muted)]">
                  Nothing to wait for.
                </span>
              </h2>
              <p className="text-[14px] text-[var(--landing-muted)] mt-5 leading-relaxed">
                The read hits local SQLite. The mutation writes locally and
                queues in the outbox. The engine syncs in the background.
              </p>
            </div>

            <div className="border border-[var(--landing-line)] rounded-md overflow-hidden bg-[var(--landing-bg-2)]">
              <div className="flex items-center justify-between border-b border-[var(--landing-line)] px-3.5 py-2">
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#3a3a3a]" />
                  <span className="w-2.5 h-2.5 rounded-full bg-[#3a3a3a]" />
                  <span className="w-2.5 h-2.5 rounded-full bg-[#3a3a3a]" />
                  <span className="ml-3 text-[11px] text-[var(--landing-dim)] landing-mono">
                    TaskList.tsx
                  </span>
                </div>
                <span className="text-[11px] text-[var(--landing-dim)] landing-mono">
                  React · TypeScript
                </span>
              </div>
              <pre className="text-[13px] leading-[1.7] p-5 text-[var(--landing-ink)] landing-mono whitespace-pre overflow-x-auto">
                <code>
                  <span className="landing-tk-kw">function</span>{' '}
                  <span className="landing-tk-fn">TaskList</span>
                  {'() {\n  '}
                  <span className="landing-tk-kw">const</span>
                  {' { data: tasks } = '}
                  <span className="landing-tk-fn">useSyncQuery</span>
                  {'(({ selectFrom }) =>\n    selectFrom('}
                  <span className="landing-tk-str">{"'tasks'"}</span>
                  {').selectAll().where('}
                  <span className="landing-tk-str">{"'completed'"}</span>
                  {', '}
                  <span className="landing-tk-str">{"'='"}</span>
                  {', '}
                  <span className="landing-tk-num">0</span>
                  {')\n  );\n  '}
                  <span className="landing-tk-kw">const</span>
                  {' m = '}
                  <span className="landing-tk-fn">useMutations</span>
                  {'();\n\n  '}
                  <span className="landing-tk-kw">return</span>
                  {' (\n    <'}
                  <span className="landing-tk-fn">ul</span>
                  {'>\n      {tasks?.map((task) => (\n        <'}
                  <span className="landing-tk-fn">li</span>
                  {
                    ' key={task.id} onClick={() => m.tasks.update(task.id, { completed: '
                  }
                  <span className="landing-tk-num">1</span>
                  {' })}>\n          {task.title}\n        </'}
                  <span className="landing-tk-fn">li</span>
                  {'>\n      ))}\n    </'}
                  <span className="landing-tk-fn">ul</span>
                  {'>\n  );\n}'}
                </code>
              </pre>
            </div>
          </div>
        </div>
      </section>

      <section id="how" className="border-t border-[var(--landing-line)]">
        <div className="max-w-[1100px] mx-auto px-6 py-24">
          <div className="landing-mono text-[11px] tracking-[0.18em] uppercase text-[var(--landing-dim)]">
            §03 — Path of a write
          </div>
          <h2 className="text-3xl md:text-4xl mt-3 leading-[1.1] max-w-xl font-medium">
            From keystroke to every peer,
            <br />
            <span className="text-[var(--landing-muted)]">in four moves.</span>
          </h2>

          <div className="mt-12 grid md:grid-cols-4 gap-px bg-[var(--landing-line)] border border-[var(--landing-line)]">
            {flow.map((s) => (
              <div key={s.step} className="bg-[var(--landing-bg)] p-6">
                <div className="landing-mono text-[11px] text-[var(--landing-dim)]">
                  {s.step}
                </div>
                <h3 className="text-[16px] font-medium mt-2">{s.title}</h3>
                <p className="text-[13px] text-[var(--landing-muted)] mt-2 leading-relaxed">
                  {s.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-[var(--landing-line)]">
        <div className="max-w-[1100px] mx-auto px-6 py-32 text-center">
          <h2 className="text-5xl md:text-6xl leading-[1.02] tracking-tight font-medium">
            Ready when you are.
          </h2>
          <p className="mt-5 text-[var(--landing-muted)] text-[17px] max-w-md mx-auto">
            Apache 2.0. Self-hosted. Built for teams that take sync seriously.
          </p>
          <div className="mt-9 flex items-center justify-center gap-2.5">
            <Link
              href="/start"
              className="bg-white text-black font-medium rounded-md px-4 py-2.5 text-[13px] landing-mono hover:bg-neutral-200 transition-colors"
            >
              npm i @syncular/client
            </Link>
            <Link
              href="/start"
              className="bg-transparent text-[var(--landing-ink)] border border-[var(--landing-line-2)] rounded-md px-4 py-2.5 text-[13px] hover:border-neutral-500 transition-colors"
            >
              Read the docs →
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-[var(--landing-line)]">
        <div className="max-w-[1100px] mx-auto px-6 py-8 flex flex-wrap items-center justify-between gap-3 text-[12px] text-[var(--landing-dim)]">
          <div className="flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 32 32" fill="none">
              <circle
                cx="16"
                cy="16"
                r="14"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <circle cx="16" cy="16" r="3" fill="currentColor" />
            </svg>
            <span>Syncular</span>
          </div>
          <span className="landing-mono">© 2026 · Apache 2.0</span>
        </div>
      </footer>
    </main>
  );
}
