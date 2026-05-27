import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BLOG_DIR = resolve(process.cwd(), 'src', 'content', 'blog');
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  author: string;
  date: string;
  body: string;
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function parseFrontmatter(frontmatter: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const line of frontmatter.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();

    if (!key) {
      continue;
    }

    parsed[key] = stripWrappingQuotes(rawValue);
  }

  return parsed;
}

function parseMarkdownFile(text: string): {
  data: Record<string, string>;
  content: string;
} {
  const match = FRONTMATTER_PATTERN.exec(text);
  if (!match) {
    return {
      data: {},
      content: text,
    };
  }

  const frontmatter = parseFrontmatter(match[1]);
  const content = text.slice(match[0].length);

  return {
    data: frontmatter,
    content,
  };
}

function toBlogPost(filename: string): BlogPost {
  const slug = filename.replace(/\.(md|mdx)$/i, '');
  const filePath = resolve(BLOG_DIR, filename);
  const text = readFileSync(filePath, 'utf8');
  const parsed = parseMarkdownFile(text);

  const title = String(parsed.data.title ?? '').trim();
  const description = String(parsed.data.description ?? '').trim();
  const author = String(parsed.data.author ?? '').trim();
  const date = String(parsed.data.date ?? '').trim();

  if (!title || !author || !date) {
    throw new Error(`Invalid blog frontmatter in ${filename}`);
  }

  return {
    slug,
    title,
    description,
    author,
    date,
    body: parsed.content,
  };
}

export function getAllBlogPosts(): BlogPost[] {
  const files = readdirSync(BLOG_DIR).filter((entry) =>
    /\.(md|mdx)$/i.test(entry)
  );

  return files
    .map(toBlogPost)
    .sort(
      (left, right) =>
        new Date(right.date).getTime() - new Date(left.date).getTime()
    );
}

export function getBlogPostBySlug(slug: string): BlogPost | null {
  const post = getAllBlogPosts().find((candidate) => candidate.slug === slug);
  return post ?? null;
}
