'use client';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { Eye, EyeOff } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useState } from 'react';

type PasswordFieldProps = Omit<ComponentProps<'input'>, 'type'> & {
  showLabel: string;
  hideLabel: string;
};

export function PasswordField({
  showLabel,
  hideLabel,
  id,
  className,
  ...props
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <Input
        {...props}
        className={cn('pr-12', className)}
        id={id}
        type={visible ? 'text' : 'password'}
      />
      <button
        aria-controls={id}
        aria-label={visible ? hideLabel : showLabel}
        aria-pressed={visible}
        className="absolute right-0 top-0 flex h-full min-w-[44px] items-center justify-center rounded-r-lg text-muted transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-ring"
        onClick={() => setVisible((v) => !v)}
        type="button"
      >
        {visible ? (
          <EyeOff aria-hidden="true" className="size-4" />
        ) : (
          <Eye aria-hidden="true" className="size-4" />
        )}
      </button>
    </div>
  );
}
