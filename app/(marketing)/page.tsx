import { Wordmark } from '@/components/wordmark';
import messages from '@/messages/fr.json';
import Link from 'next/link';

export default function MarketingPage() {
  return (
    <main className="min-h-dvh bg-canvas text-text">
      <header className="sticky top-0 z-10 h-16 border-b border-border/80 bg-canvas/90 backdrop-blur">
        <div className="mx-auto flex h-full max-w-6xl items-center justify-between px-5">
          <Wordmark size="md" />
          <Link className="text-sm font-medium text-text hover:text-accent-deep" href="/connexion">
            {messages.marketing.header.connexion}
          </Link>
        </div>
      </header>

      <section className="mx-auto flex min-h-[calc(100dvh-8rem)] max-w-5xl flex-col items-center justify-center px-5 py-16 text-center">
        <h1 className="max-w-4xl text-balance font-display text-5xl leading-[1.02] md:text-7xl">
          {messages.marketing.hero.title_a} {messages.marketing.hero.title_b}{' '}
          <span className="text-accent">{messages.marketing.hero.title_c}</span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-muted">
          {messages.marketing.hero.subtitle}
        </p>
        <Link
          className="mt-9 rounded-lg bg-accent px-6 py-3 font-medium text-[#111] shadow-1 transition hover:bg-accent-soft"
          href="/connexion?mode=signup"
        >
          {messages.marketing.hero.cta}
        </Link>
      </section>

      <footer className="border-t border-border px-5 py-6">
        <div className="mx-auto flex max-w-6xl items-center justify-between text-sm text-muted">
          <span>{messages.marketing.footer.copyright}</span>
          <Link className="hover:text-text" href="/confidentialite">
            {messages.marketing.footer.privacy}
          </Link>
        </div>
      </footer>
    </main>
  );
}
