import type { Metadata } from 'next';
import { LoginForm } from '@/components/admin/login-form';
export const metadata: Metadata = {
  title: 'Acesso administrativo',
  robots: { index: false, follow: false },
};
export default function LoginPage() {
  return (
    <main id="conteudo" className="login">
      <div className="login-art" aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/logo-sm.webp"
          alt=""
          width={120}
          height={28}
          style={{ height: 28, width: 'auto', position: 'relative', alignSelf: 'flex-start' }}
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="brand-eye-static" src="/brand/eye.webp" alt="" width={900} height={712} />
        <h2>
          Veja <em className="chrome-text">além.</em>
        </h2>
      </div>
      <div className="login-side">
        <div className="login-box">
          <span className="muted">Painel da loja</span>
          <h1 className="page-title">Entrar</h1>
          <p className="muted" style={{ margin: 0 }}>
            Acesso só para a equipe da OTILC. O usuário é criado pelo terminal.
          </p>
          <LoginForm />
        </div>
      </div>
    </main>
  );
}
