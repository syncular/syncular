import { BlogHeader } from '@/components/blog/header';

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <BlogHeader />
      <div className="pt-12">{children}</div>
    </>
  );
}
