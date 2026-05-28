import { Suspense } from 'react';
import { ConnexionForm } from './connexion-form';

export default function ConnexionPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-5 py-12 text-text">
      <Suspense fallback={null}>
        <ConnexionForm />
      </Suspense>
    </main>
  );
}
