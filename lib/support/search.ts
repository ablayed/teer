import type { TeamRole } from '@/lib/team/permissions';
import { type FAQItem, faqForRole } from './faq';

// Normalise un texte pour la comparaison : minuscules + suppression des accents.
export function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

// Score de pertinence d'un item pour une requête normalisée.
// Poids : keywords (3 pts/match) > question (2 pts/match) > answer (1 pt/match).
// Bonus +2 si la phrase normalisée complète apparaît dans la question ou la réponse.
export function scoreFAQ(item: FAQItem, normalizedQuery: string): number {
  if (!normalizedQuery.trim()) return 0;

  const terms = normalizedQuery.trim().split(/\s+/).filter(Boolean);
  let score = 0;

  const normQuestion = normalize(item.question);
  const normAnswer = normalize(item.answer);
  const normKeywords = item.keywords.map(normalize);

  for (const term of terms) {
    if (normKeywords.some((kw) => kw.includes(term))) score += 3;
    if (normQuestion.includes(term)) score += 2;
    if (normAnswer.includes(term)) score += 1;
  }

  // Bonus phrase exacte
  if (normQuestion.includes(normalizedQuery) || normAnswer.includes(normalizedQuery)) {
    score += 2;
  }

  return score;
}

export type SearchOptions = {
  minScore?: number;
  maxResults?: number;
};

// Recherche des FAQ pertinentes pour le rôle donné, triées par score décroissant.
export function searchFAQ(
  query: string,
  role: TeamRole,
  { minScore = 1, maxResults = 20 }: SearchOptions = {},
): FAQItem[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery.trim()) return [];

  return faqForRole(role)
    .map((item) => ({ item, score: scoreFAQ(item, normalizedQuery) }))
    .filter(({ score }) => score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ item }) => item);
}

// Retourne true si la FAQ peut répondre à la question (au moins 1 résultat pertinent).
export function canFAQAnswer(query: string, role: TeamRole): boolean {
  return searchFAQ(query, role, { minScore: 1, maxResults: 1 }).length > 0;
}
