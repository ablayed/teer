import { promises as fs } from 'node:fs';
import path from 'node:path';
import { cache } from 'react';
import { markdownToHtml } from './markdown';

export type LegalDocumentType = 'privacy' | 'cgu' | 'mentions' | 'dpa';

type LegalDocumentConfig = {
  type: LegalDocumentType;
  fileName: string;
  route: string;
  title: string;
  description: string;
};

const LEGAL_DOCUMENTS: Record<LegalDocumentType, LegalDocumentConfig> = {
  privacy: {
    type: 'privacy',
    fileName: 'politique-confidentialite.md',
    route: '/confidentialite',
    title: 'Politique de Confidentialité',
    description: 'Comment Tëër collecte, protège et traite les données personnelles.',
  },
  cgu: {
    type: 'cgu',
    fileName: 'conditions-generales.md',
    route: '/conditions',
    title: "Conditions Générales d'Utilisation",
    description: "Les conditions d'accès et d'utilisation du service Tëër.",
  },
  mentions: {
    type: 'mentions',
    fileName: 'mentions-legales.md',
    route: '/mentions-legales',
    title: 'Mentions Légales',
    description: "Les informations d'édition et d'hébergement du service Tëër.",
  },
  dpa: {
    type: 'dpa',
    fileName: 'dpa-accord-sous-traitance.md',
    route: '/dpa',
    title: 'Accord de Sous-Traitance',
    description: 'Le cadre contractuel de traitement des données pour les Marchands Tëër.',
  },
};

function legalFilePath(fileName: string) {
  return path.join(process.cwd(), 'docs', 'legal', fileName);
}

export function getLegalDocumentConfig(type: LegalDocumentType) {
  return LEGAL_DOCUMENTS[type];
}

export const getLegalDocument = cache(async (type: LegalDocumentType) => {
  const config = getLegalDocumentConfig(type);
  const markdown = await fs.readFile(legalFilePath(config.fileName), 'utf8');

  return {
    ...config,
    markdown,
    html: markdownToHtml(markdown),
  };
});

export function listLegalDocuments() {
  return Object.values(LEGAL_DOCUMENTS);
}
