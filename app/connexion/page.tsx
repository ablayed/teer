import { Suspense } from 'react';
import { ConnexionForm } from './connexion-form';

export default function ConnexionPage() {
  return (
    <main>
      <Suspense fallback={null}>
        <ConnexionForm />
      </Suspense>
    </main>
  );
}
