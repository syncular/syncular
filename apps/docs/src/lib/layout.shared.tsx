import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2.5">
          <svg
            width="18"
            height="18"
            viewBox="0 0 32 32"
            fill="none"
            aria-hidden
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
        </span>
      ),
      url: '/',
    },
    githubUrl: 'https://github.com/syncular/syncular',
  };
}
