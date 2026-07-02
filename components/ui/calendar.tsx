'use client';

// Charge la feuille de style de base react-day-picker (layout de la grille). Ce
// module n'est importé qu'en `lazy` (à l'ouverture de « Personnalisé »), donc le
// CSS voyage dans le chunk du calendrier — l'usage courant des presets ne le paie
// pas. Le thème Dakar Teranga (accent orange, Fraunces) est surchargé via les
// variables `.rdp-root` dans globals.css.
import 'react-day-picker/style.css';

import { cn } from '@/lib/utils';
import { fr } from 'date-fns/locale';
import type { ComponentProps } from 'react';
import { DayPicker } from 'react-day-picker';

export type CalendarProps = ComponentProps<typeof DayPicker>;

export function Calendar({ className, ...props }: CalendarProps) {
  return <DayPicker locale={fr} className={cn('rdp-teer', className)} {...props} />;
}

export default Calendar;
