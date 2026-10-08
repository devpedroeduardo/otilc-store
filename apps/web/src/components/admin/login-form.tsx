'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { adminLoginSchema } from '@otilc/shared';
import { adminApi, AdminApiError } from '@/lib/admin-api';
export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');
    const parsed = adminLoginSchema.safeParse({ email, password });
    if (!parsed.success) {
      setErrors(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message]),
        ),
      );
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await adminApi.login(parsed.data);
      router.replace('/admin');
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof AdminApiError && error.status === 401
          ? 'E-mail ou senha inválidos.'
          : 'Não foi possível entrar. Tente novamente.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="panel admin-form" onSubmit={submit} noValidate>
      <label className="field">
        E-mail
        <input
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-describedby={errors.email ? 'email-error' : undefined}
        />
        {errors.email && (
          <span id="email-error" className="error">
            {errors.email}
          </span>
        )}
      </label>
      <label className="field">
        Senha
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-describedby={errors.password ? 'password-error' : undefined}
        />
        {errors.password && (
          <span id="password-error" className="error">
            {errors.password}
          </span>
        )}
      </label>
      {message && (
        <p className="alert error" role="alert">
          {message}
        </p>
      )}
      <button className="btn btn-solid" disabled={busy}>
        {busy ? 'Entrando…' : 'Entrar'}
      </button>
    </form>
  );
}
