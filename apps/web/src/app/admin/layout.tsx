import type { Metadata } from 'next';
import './admin.css';
export const metadata: Metadata = { robots: { index: false, follow: false } };
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <section className="wrap admin-main">{children}</section>;
}
