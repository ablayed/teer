'use client';

import {
  type IaConversationSummary,
  createConversationAction,
  getConversationMessagesAction,
} from '@/lib/actions/assistant';
import { submitFeedbackAction } from '@/lib/actions/feedback';
import { type FAQCategory, FAQ_CATEGORY_KEYS, faqForRole } from '@/lib/support/faq';
import { searchFAQ } from '@/lib/support/search';
import type { TeamRole } from '@/lib/team/permissions';
import { cn } from '@/lib/utils';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { HelpCircle, Loader2, MessageCircle, Phone, Plus, Send, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

type Tab = 'faq' | 'chat' | 'contact';
type FeedbackStatus = 'idle' | 'submitting' | 'success' | 'error';

const SUGGESTIONS: Record<TeamRole, string[]> = {
  agent: [
    "Combien de commandes à appeler aujourd'hui ?",
    'Quels produits sont en stock bas ?',
    'Répartition des statuts des commandes ce mois-ci',
  ],
  manager: [
    'Quel est le taux de RTO sur 30 jours ?',
    'Quels produits sont en stock bas ?',
    'Performance des livreurs ce mois-ci',
  ],
  owner: [
    "Quel chiffre d'affaires encaissé sur 30 jours ?",
    'Quelle marge brute ce mois-ci ?',
    "Quel est le taux d'annulation sur 30 jours ?",
  ],
};

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function hasPendingToolCall(message: UIMessage): boolean {
  return message.parts.some((part) => part.type !== 'text' && part.type !== 'step-start');
}

function toUiMessage(row: { id: string; role: string; content: string }): UIMessage {
  return {
    id: row.id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    parts: [{ type: 'text', text: row.content }],
  } as UIMessage;
}

export function AssistantView({
  role,
  initialConversations,
  supportWhatsApp,
  supportEmail,
}: {
  role: TeamRole;
  initialConversations: IaConversationSummary[];
  supportWhatsApp: string | undefined;
  supportEmail: string | undefined;
}) {
  const t = useTranslations('assistant');
  const [tab, setTab] = useState<Tab>('faq');
  const [conversations, setConversations] = useState(initialConversations);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [creating, setCreating] = useState(false);
  const conversationIdRef = useRef<string | null>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: '/api/assistant/chat',
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: { ...body, messages, conversationId: conversationIdRef.current },
        }),
      }),
    [],
  );

  const { messages, sendMessage, setMessages, status, error } = useChat({ transport });
  const busy = status === 'submitted' || status === 'streaming';

  async function startNewConversation() {
    setActiveId(null);
    conversationIdRef.current = null;
    setMessages([]);
  }

  async function selectConversation(id: string) {
    setActiveId(id);
    conversationIdRef.current = id;
    const res = await getConversationMessagesAction({ conversationId: id });
    if (res?.data?.ok) {
      setMessages(res.data.messages.filter((m) => m.role !== 'tool').map(toUiMessage));
    }
  }

  async function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy || creating) return;
    let id = activeId;
    if (!id) {
      setCreating(true);
      const res = await createConversationAction();
      setCreating(false);
      if (!res?.data?.ok) return;
      id = res.data.conversationId;
      const createdId = id;
      setActiveId(createdId);
      setConversations((prev) => [
        { id: createdId, title: trimmed.slice(0, 60), updatedAt: new Date().toISOString() },
        ...prev,
      ]);
    }
    conversationIdRef.current = id;
    setInput('');
    void sendMessage({ text: trimmed });
  }

  function switchToChat(prefill?: string) {
    setTab('chat');
    if (prefill) setInput(prefill);
  }

  const tabs: { key: Tab; label: string; icon: typeof Sparkles }[] = [
    { key: 'faq', label: t('tab.faq'), icon: MessageCircle },
    { key: 'chat', label: t('tab.chat'), icon: Sparkles },
    { key: 'contact', label: t('tab.contact'), icon: Phone },
  ];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div
        className="flex items-center gap-2 overflow-x-auto pb-1"
        role="tablist"
        aria-label={t('title')}
      >
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              'flex h-11 shrink-0 items-center gap-2 rounded-md px-4 font-medium transition',
              tab === key ? 'bg-accent text-accent-ink' : 'bg-surface text-muted hover:text-text',
            )}
          >
            <Icon aria-hidden="true" className="size-4" />
            {label}
          </button>
        ))}
      </div>

      {tab === 'faq' ? (
        <FaqPanel role={role} onAskAssistant={switchToChat} />
      ) : tab === 'chat' ? (
        <ChatPanel
          activeId={activeId}
          busy={busy}
          conversations={conversations}
          creating={creating}
          error={error}
          input={input}
          messages={messages}
          onInputChange={setInput}
          onNewConversation={startNewConversation}
          onSelectConversation={selectConversation}
          onSubmit={submit}
          role={role}
        />
      ) : (
        <ContactPanel supportWhatsApp={supportWhatsApp} supportEmail={supportEmail} />
      )}
    </div>
  );
}

// ─── FAQ PANEL ───────────────────────────────────────────────────────────────

function FaqPanel({
  role,
  onAskAssistant,
}: {
  role: TeamRole;
  onAskAssistant: (prefill?: string) => void;
}) {
  const t = useTranslations('assistant');
  const tSupport = useTranslations('support');
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<FAQCategory | null>(null);

  const allItems = useMemo(() => faqForRole(role), [role]);

  const displayItems = useMemo(() => {
    if (query.trim()) {
      return searchFAQ(query, role);
    }
    if (activeCategory) {
      return allItems.filter((item) => item.category === activeCategory);
    }
    return allItems;
  }, [query, role, activeCategory, allItems]);

  const hasResults = displayItems.length > 0;
  const isSearching = query.trim().length > 0;

  function handleSearch(value: string) {
    setQuery(value);
    if (value.trim()) setActiveCategory(null);
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Barre de recherche */}
      <input
        type="search"
        value={query}
        onChange={(e) => handleSearch(e.target.value)}
        placeholder={t('faq.searchPlaceholder')}
        className="h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-text outline-none focus:border-accent"
        aria-label={t('faq.searchPlaceholder')}
      />

      {/* Pills catégories (masquées pendant une recherche) */}
      {!isSearching ? (
        <fieldset className="flex flex-wrap gap-2 border-0 p-0">
          <legend className="sr-only">Filtrer par catégorie</legend>
          <button
            type="button"
            onClick={() => setActiveCategory(null)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition',
              activeCategory === null
                ? 'border-accent bg-accent text-accent-ink'
                : 'border-border bg-surface text-muted hover:text-text',
            )}
          >
            {t('faq.allCategories')}
          </button>
          {FAQ_CATEGORY_KEYS.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setActiveCategory(cat)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium transition',
                activeCategory === cat
                  ? 'border-accent bg-accent text-accent-ink'
                  : 'border-border bg-surface text-muted hover:text-text',
              )}
            >
              {tSupport(`categories.${cat}`)}
            </button>
          ))}
        </fieldset>
      ) : null}

      {/* Résultats */}
      {hasResults ? (
        <div className="flex flex-col gap-2">
          {displayItems.map((item) => (
            <details
              key={item.id}
              className="rounded-md border border-border bg-surface px-4 py-3 [&_summary]:cursor-pointer"
            >
              <summary className="font-medium text-text">{item.question}</summary>
              <p className="mt-2 text-muted text-sm leading-relaxed">{item.answer}</p>
            </details>
          ))}
        </div>
      ) : isSearching ? (
        <div className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4 text-sm">
          <p className="text-muted">{t('faq.noResults', { query })}</p>
          <button
            type="button"
            onClick={() => onAskAssistant(query)}
            className="self-start rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition hover:bg-accent-hover"
          >
            {t('faq.noResultsCta')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ─── CHAT PANEL (inchangé) ───────────────────────────────────────────────────

function ChatPanel({
  activeId,
  busy,
  conversations,
  creating,
  error,
  input,
  messages,
  onInputChange,
  onNewConversation,
  onSelectConversation,
  onSubmit,
  role,
}: {
  activeId: string | null;
  busy: boolean;
  conversations: IaConversationSummary[];
  creating: boolean;
  error: Error | undefined;
  input: string;
  messages: UIMessage[];
  onInputChange: (value: string) => void;
  onNewConversation: () => void;
  onSelectConversation: (id: string) => void;
  onSubmit: (text: string) => void;
  role: TeamRole;
}) {
  const showThinking = busy && !messages.some((m) => m.role === 'assistant' && messageText(m));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        <button
          type="button"
          onClick={onNewConversation}
          className="flex min-h-11 shrink-0 items-center gap-1 rounded-md border border-border bg-surface px-3 text-sm text-text md:min-h-9"
        >
          <Plus aria-hidden="true" className="size-4" />
          Nouvelle
        </button>
        {conversations.map((conversation) => (
          <button
            type="button"
            key={conversation.id}
            onClick={() => onSelectConversation(conversation.id)}
            className={cn(
              'min-h-11 max-w-[180px] shrink-0 truncate rounded-md border px-3 text-sm transition md:min-h-9',
              activeId === conversation.id
                ? 'border-accent bg-accent/10 text-text'
                : 'border-border bg-surface text-muted hover:text-text',
            )}
          >
            {conversation.title ?? 'Conversation'}
          </button>
        ))}
      </div>

      <div className="flex min-h-[320px] flex-col gap-3 rounded-md border border-border bg-canvas p-4">
        {messages.length === 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-muted text-sm">
              Pose une question sur tes commandes, ton stock, tes clients ou tes livreurs. Je ne
              rapporte que des données réellement enregistrées.
            </p>
            <div className="mt-1 flex flex-col gap-2">
              {SUGGESTIONS[role].map((suggestion) => (
                <button
                  type="button"
                  key={suggestion}
                  onClick={() => onSubmit(suggestion)}
                  className="min-h-11 rounded-md border border-border bg-surface px-3 py-2 text-left text-sm text-text hover:bg-surface/70"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={cn(
                'max-w-[85%] rounded-md px-3 py-2 text-sm leading-relaxed',
                message.role === 'user'
                  ? 'self-end bg-accent text-accent-ink'
                  : 'self-start bg-surface text-text',
              )}
            >
              {messageText(message) ||
                (hasPendingToolCall(message) ? (
                  <span className="flex items-center gap-2 text-muted">
                    <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                    Consultation des données…
                  </span>
                ) : null)}
            </div>
          ))
        )}

        {showThinking ? (
          <div className="flex items-center gap-2 self-start text-muted text-sm">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            L'assistant réfléchit…
          </div>
        ) : null}

        {error ? (
          <p className="self-start text-danger text-sm">
            Une erreur est survenue. Réessaie dans un instant.
          </p>
        ) : null}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(input);
        }}
        className="flex items-end gap-2"
      >
        <textarea
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onSubmit(input);
            }
          }}
          rows={1}
          maxLength={4000}
          placeholder="Écris ta question…"
          className="min-h-11 flex-1 resize-none rounded-md border border-border bg-surface px-3 py-2 text-text outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={busy || creating || !input.trim()}
          aria-label="Envoyer"
          className="flex size-11 shrink-0 items-center justify-center rounded-md bg-accent text-accent-ink transition disabled:opacity-50"
        >
          <Send aria-hidden="true" className="size-5" />
        </button>
      </form>
    </div>
  );
}

// ─── CONTACT PANEL ───────────────────────────────────────────────────────────

function ContactPanel({
  supportWhatsApp,
  supportEmail,
}: {
  supportWhatsApp: string | undefined;
  supportEmail: string | undefined;
}) {
  const t = useTranslations('assistant');
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-base font-semibold text-text">{t('contact.title')}</p>
      <div className="flex flex-col gap-3">
        {supportWhatsApp ? (
          <a
            href={`https://wa.me/${supportWhatsApp.replace(/\D/g, '')}?text=${encodeURIComponent('Bonjour, j’ai besoin d’aide avec Tëër…')}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-11 items-center gap-3 rounded-md border border-border bg-surface px-4 text-sm font-medium text-text transition hover:bg-canvas"
          >
            <HelpCircle aria-hidden="true" className="size-5 shrink-0 text-accent" />
            {t('contact.whatsapp')}
          </a>
        ) : null}

        {supportEmail ? (
          <a
            href={`mailto:${supportEmail}`}
            className="flex min-h-11 items-center gap-3 rounded-md border border-border bg-surface px-4 text-sm font-medium text-text transition hover:bg-canvas"
          >
            <MessageCircle aria-hidden="true" className="size-5 shrink-0 text-accent" />
            {t('contact.email')}
          </a>
        ) : null}

        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="flex min-h-11 items-center gap-3 rounded-md border border-border bg-surface px-4 text-sm font-medium text-text transition hover:bg-canvas"
        >
          <Phone aria-hidden="true" className="size-5 shrink-0 text-accent" />
          {t('contact.reportBug')}
        </button>
      </div>

      {dialogOpen ? <FeedbackDialog onClose={() => setDialogOpen(false)} /> : null}
    </div>
  );
}

// ─── FEEDBACK DIALOG ─────────────────────────────────────────────────────────

const FEEDBACK_CATEGORIES = ['bug', 'suggestion', 'question', 'autre'] as const;
type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations('assistant');
  const fieldId = useId();
  const [category, setCategory] = useState<FeedbackCategory>('bug');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<FeedbackStatus>('idle');
  const submitFeedback = useAction(submitFeedbackAction);

  async function handleSubmit() {
    if (message.trim().length < 5 || status === 'submitting') return;
    setStatus('submitting');

    const pageContext = typeof window !== 'undefined' ? window.location.pathname : undefined;
    const userAgent =
      typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 500) : undefined;

    const res = await submitFeedback.executeAsync({
      category,
      message: message.trim(),
      pageContext,
      userAgent,
    });

    if (res?.data?.ok) {
      setStatus('success');
    } else {
      setStatus('error');
    }
  }

  // Fermeture Escape
  usePressEscape(onClose);

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <dialog
        aria-label={t('feedback.title')}
        aria-modal="true"
        className="m-0 w-full max-w-sm space-y-4 rounded-lg border border-border bg-surface p-5 text-text shadow-2"
        open
      >
        <h2 className="text-lg font-semibold">{t('feedback.title')}</h2>

        {status === 'success' ? (
          <div className="space-y-3">
            <p className="font-medium text-success">{t('feedback.successTitle')}</p>
            <p className="text-muted text-sm">{t('feedback.successBody')}</p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition hover:bg-accent-hover"
              >
                {t('feedback.close')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <label htmlFor={`${fieldId}-category`} className="block text-sm font-medium">
                {t('feedback.categoryLabel')}
              </label>
              <select
                id={`${fieldId}-category`}
                value={category}
                onChange={(e) => setCategory(e.target.value as FeedbackCategory)}
                className="h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-text outline-none focus:border-accent"
              >
                {FEEDBACK_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {t(`feedback.categories.${cat}`)}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label htmlFor={`${fieldId}-message`} className="block text-sm font-medium">
                {t('feedback.messageLabel')}
              </label>
              <textarea
                id={`${fieldId}-message`}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={t('feedback.messagePlaceholder')}
                maxLength={2000}
                rows={4}
                className="w-full resize-none rounded-md border border-border bg-surface p-3 text-sm text-text outline-none focus:border-accent"
              />
              <p className="text-right text-xs text-muted">{message.length}/2000</p>
            </div>

            {status === 'error' ? (
              <p className="text-sm font-medium text-danger" role="alert">
                {t('feedback.errorBody')}
              </p>
            ) : null}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-border bg-surface px-4 py-2 text-sm font-medium text-text transition hover:bg-canvas"
              >
                {t('feedback.close')}
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={message.trim().length < 5 || status === 'submitting'}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition hover:bg-accent-hover disabled:opacity-50"
              >
                {status === 'submitting' ? t('feedback.submitting') : t('feedback.submit')}
              </button>
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}

// ─── HOOK UTILITAIRE ─────────────────────────────────────────────────────────

function usePressEscape(onClose: () => void) {
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);
}
