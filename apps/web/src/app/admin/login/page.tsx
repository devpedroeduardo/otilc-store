import type { Metadata } from 'next';
import { LoginForm } from '@/components/admin/login-form';
export const metadata: Metadata = {
  title: 'Acesso administrativo',
  robots: { index: false, follow: false },
};
export default function LoginPage() {
  return (
    <section className="wrap admin-main">
      <p className="mono muted">OTILC · ADMIN</p>
      <h1 className="page-title">Entrar</h1>
      <LoginForm />
    </section>
  );
}
