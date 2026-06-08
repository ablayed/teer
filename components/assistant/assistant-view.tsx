'use client';

import {
  type IaConversationSummary,
  createConversationAction,
  getConversationMessagesAction,
} from '@/lib/actions/assistant';
import { faqForRole } from '@/lib/ia/faq';
import type { TeamRole } from '@/lib/team/permissions';
import { cn } from '@/lib/utils';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { Loader2, MessageCircle, Plus, Send, Sparkles } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

type Tab = 'chat' | 'faq';

const SUGGESTIONS: Record<TeamRole, string[]> = {
  agent: [
    'Combien de commandes à appeler aujourd’hui ?',
    'Quels produits sont en stock bas ?',
    'Répartition des statuts des commandes ce mois-ci',
  ],
  manager: [
    'Quel est le taux de RTO sur 30 jours ?',
    'Quels produits sont en stock bas ?',
    'Performance des livreurs ce mois-ci',
  ],
  owner: [
    'Quel chiffre d’affaires encaissé sur 30 jours ?',
    'Quelle marge brute ce mois-ci ?',
    'Quel est le taux d’annulation sur 30 jours ?',
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
}: {
  role: TeamRole;
  initialConversations: IaConversationSummary[];
}) {
  const [tab, setTab] = useState<Tab>('chat');
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

  const faqEntries = useMemo(() => faqForRole(role), [role]);
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
    if (!trimmed || busy || creating) {
      return;
    }
    let id = activeId;
    if (!id) {
      setCreating(true);
      const res = await createConversationAction();
      setCreating(false);
      if (!res?.data?.ok) {
        return;
      }
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

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex items-center gap-2" role="tablist" aria-label="Assistant et FAQ">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'chat'}
          onClick={() => setTab('chat')}
          className={cn(
            'flex h-11 items-center gap-2 rounded-md px-4 font-medium transition',
            tab === 'chat' ? 'bg-accent text-accent-ink' : 'bg-surface text-muted hover:text-text',
          )}
        >
          <Sparkles aria-hidden="true" className="size-4" />
          Assistant
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'faq'}
          onClick={() => setTab('faq')}
          className={cn(
            'flex h-11 items-center gap-2 rounded-md px-4 font-medium transition',
            tab === 'faq' ? 'bg-accent text-accent-ink' : 'bg-surface text-muted hover:text-text',
          )}
        >
          <MessageCircle aria-hidden="true" className="size-4" />
          FAQ
        </button>
      </div>

      {tab === 'faq' ? (
        <FaqPanel entries={faqEntries} />
      ) : (
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
      )}
    </div>
  );
}

function FaqPanel({ entries }: { entries: ReturnType<typeof faqForRole> }) {
  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry) => (
        <details
          key={entry.id}
          className="rounded-md border border-border bg-surface px-4 py-3 [&_summary]:cursor-pointer"
        >
          <summary className="font-medium text-text">{entry.question}</summary>
          <p className="mt-2 text-muted text-sm leading-relaxed">{entry.answer}</p>
        </details>
      ))}
    </div>
  );
}

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
          className="flex h-9 shrink-0 items-center gap-1 rounded-md border border-border bg-surface px-3 text-sm text-text"
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
              'h-9 max-w-[180px] shrink-0 truncate rounded-md border px-3 text-sm transition',
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
                  className="rounded-md border border-border bg-surface px-3 py-2 text-left text-sm text-text hover:bg-surface/70"
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
            L’assistant réfléchit…
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
