import { MarketingFooter } from '@/components/marketing/footer';
import { Wordmark } from '@/components/wordmark';
import {
  type LegalDocumentType,
  getLegalDocument,
  listLegalDocuments,
} from '@/lib/legal/documents';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

export async function LegalPage({ type }: { type: LegalDocumentType }) {
  const document = await getLegalDocument(type);

  return (
    <div className="landing min-h-dvh bg-canvas text-text">
      <header className="relative overflow-hidden border-border/70 border-b">
        <div className="-z-10 pointer-events-none absolute inset-0">
          <div className="absolute inset-0 bg-grid opacity-[0.3] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_10%,#000_30%,transparent_78%)]" />
          <div
            className="absolute inset-x-0 top-0 h-[360px]"
            style={{
              background:
                'radial-gradient(55% 60% at 50% 0%, rgba(238,131,67,0.14) 0%, rgba(238,131,67,0) 72%)',
            }}
          />
        </div>

        <div className="mx-auto max-w-5xl px-5 pt-8 pb-12 md:pt-10 md:pb-16">
          <div className="flex items-center justify-between gap-4">
            <Link
              href="/"
              className="inline-flex items-center gap-3 text-sm text-muted transition-colors hover:text-text"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Retour à l'accueil
            </Link>
            <Wordmark size="sm" />
          </div>

          <div className="mt-10 max-w-3xl">
            <p className="text-sm font-medium uppercase tracking-[0.22em] text-accent-deep">
              Informations légales
            </p>
            <h1 className="mt-4 text-balance font-display text-4xl leading-tight tracking-[-0.02em] md:text-6xl">
              {document.title}
            </h1>
            <p className="mt-5 max-w-2xl text-pretty text-base leading-8 text-muted md:text-lg">
              {document.description}
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-10 md:py-14">
        <div className="grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-12">
          <aside className="lg:sticky lg:top-6 lg:self-start">
            <nav
              aria-label="Autres pages légales"
              className="rounded-2xl border border-border bg-surface/85 p-4 shadow-1"
            >
              <p className="text-sm font-medium text-text">Autres documents</p>
              <ul className="mt-4 space-y-2 text-sm text-muted">
                {listLegalDocuments().map((item) => (
                  <li key={item.route}>
                    <Link
                      href={item.route}
                      className={[
                        'block rounded-xl px-3 py-2 transition-colors',
                        item.type === type
                          ? 'bg-canvas font-medium text-text'
                          : 'hover:bg-canvas/70 hover:text-text',
                      ].join(' ')}
                    >
                      {item.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </aside>

          <article className="rounded-[28px] border border-border bg-surface px-5 py-6 shadow-1 md:px-8 md:py-8">
            <div
              className="legal-prose"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: contenu markdown local et versionné
              dangerouslySetInnerHTML={{ __html: document.html }}
            />
          </article>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}
