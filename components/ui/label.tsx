import { cn } from '@/lib/utils';
import type { ComponentProps } from 'react';

type LabelProps = ComponentProps<'label'> & {
  htmlFor: string;
};

export function Label({ className, htmlFor, ...props }: LabelProps) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: htmlFor is required by LabelProps.
    <label
      className={cn('text-sm font-medium text-text', className)}
      htmlFor={htmlFor}
      {...props}
    />
  );
}
